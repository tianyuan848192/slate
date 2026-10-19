"""slate 命令共用的路径、凭证和事件上传。

每一轮开始前，turn Lambda 通过 InvokeAgentRuntimeCommand 写入：
  /root/.slate/credentials  本任务范围的临时凭证（profile "task"），只能访问 u/<sub>/t/<taskId>/*
  /root/.slate/task.json    {"bucket", "prefix", "taskId", "turnId", "region", "chapter"?}
长片按章节并行制作：每章一个会话，task.json 里带 chapter（两位数字，例如 "03"），事件和存档都按章区分。
Polly、Bedrock、Browser 用会话自带的执行角色凭证（默认凭证链）。
"""
import json, os, secrets, sys, time

import boto3

TASK = os.environ.get("SLATE_TASK_DIR", "/root/task")
STATE = os.environ.get("SLATE_STATE_DIR", "/root/.slate")
OPT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = os.environ.get("AWS_REGION", "us-east-1")


def die(msg, code=1):
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(code)


def path(*parts):
    return os.path.join(TASK, *parts)


def ctx():
    try:
        return json.load(open(os.path.join(STATE, "task.json")))
    except FileNotFoundError:
        return {}


def task_session():
    """本任务范围的 boto3 Session；没有凭证时（本地调试）返回 None。"""
    cred = os.path.join(STATE, "credentials")
    if not os.path.exists(cred):
        return None
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = cred
    return boto3.Session(profile_name="task", region_name=REGION)


def s3():
    sess = task_session()
    return sess.client("s3") if sess else None


def key(*parts):
    c = ctx()
    return "/".join([c["prefix"].rstrip("/"), *parts])


def upload(local, *key_parts, content_type=None):
    """上传到本任务前缀下，返回 key；本地调试模式（无凭证）返回 None。"""
    c, cli = ctx(), s3()
    if not cli or not c:
        return None
    k = key(*key_parts)
    extra = {"ContentType": content_type} if content_type else {}
    cli.upload_file(local, c["bucket"], k, ExtraArgs=extra)
    return k


def chapter():
    """章节会话返回章号（例如 "03"），主会话和普通任务返回 None"""
    return ctx().get("chapter") or None


def emit(event_type, **fields):
    """发出一个事件：写到 S3 events/ 前缀（由 events Lambda 校验后进 DynamoDB），同时记本地日志。章节会话的事件带上章号"""
    c = ctx()
    ev = {"type": event_type, "turnId": c.get("turnId"), "at": int(time.time() * 1000), **fields}
    if c.get("chapter"):
        ev["chapter"] = c["chapter"]
    os.makedirs(TASK, exist_ok=True)
    with open(path(".events.log"), "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    cli = s3()
    if cli and c:
        name = f"{ev['at']}-{secrets.token_hex(3)}.json"
        cli.put_object(Bucket=c["bucket"], Key=key("events", name), Body=json.dumps(ev, ensure_ascii=False).encode(),
                       ContentType="application/json")
    return ev


def load_json(p, default=None):
    try:
        return json.load(open(p, encoding="utf-8"))
    except FileNotFoundError:
        return default


def storyboard():
    sb = load_json(path("storyboard.json"))
    if not sb:
        die("找不到 storyboard.json，先写分镜并用 slate-publish storyboard 发布")
    return sb


def spec():
    """当前规格：分镜里的值优先，其次 brief，最后默认 16:9 1080p 30 帧。"""
    sb = load_json(path("storyboard.json"), {}) or {}
    br = load_json(path("brief.json"), {}) or {}
    ratio = sb.get("ratio") or br.get("ratio") or "16:9"
    res = sb.get("resolution") or br.get("resolution") or "1080p"
    fps = int(sb.get("fps") or br.get("fps") or 30)
    return {"ratio": ratio, "resolution": res, "fps": fps, **dict(zip(("w", "h"), size_of(ratio, res)))}


def size_of(ratio, resolution):
    short = {"720p": 720, "1080p": 1080}.get(resolution, 1080)
    a, b = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5)}.get(ratio, (16, 9))
    if a >= b:
        h = short; w = round(short * a / b / 2) * 2
    else:
        w = short; h = round(short * b / a / 2) * 2
    return w, h


def scene_ids():
    return [s["id"] for s in storyboard()["scenes"]]


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def media_duration(p):
    """用 ffmpeg 读媒体时长（秒）。"""
    import re, subprocess
    r = subprocess.run([ffmpeg(), "-hide_banner", "-i", p], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", r.stderr)
    if not m:
        return 0.0
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)
