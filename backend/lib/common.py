"""Lambda 共用：配置、DynamoDB、S3、任务凭证、调用 Harness。"""
import json, os, re, secrets, time, uuid
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE = os.environ.get("TABLE", "")
DATA_BUCKET = os.environ.get("DATA_BUCKET", "")
HARNESS_ARN = os.environ.get("HARNESS_ARN", "")
GATEWAY_ARN = os.environ.get("GATEWAY_ARN", "")
TASK_DATA_ROLE_ARN = os.environ.get("TASK_DATA_ROLE_ARN", "")
TURN_FN = os.environ.get("TURN_FN", "")
MODELS = json.loads(os.environ.get("MODELS", '["global.anthropic.claude-opus-5-5"]'))
RUNNING_LIMIT = int(os.environ.get("RUNNING_LIMIT", "3"))
DAILY_LIMIT = int(os.environ.get("DAILY_LIMIT", "30"))

_ddb = boto3.resource("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION, config=Config(signature_version="s3v4"))
lam = boto3.client("lambda", region_name=REGION)
sts = boto3.client("sts", region_name=REGION)
agent = boto3.client("bedrock-agentcore", region_name=REGION, config=Config(read_timeout=900, retries={"max_attempts": 2}))

# 先整理资料（参考资料、链接、联网搜索），再结合需求分析、写剧本（docs/references-design.md）
STEPS = [("research", "资料整理"), ("analyze", "分析需求"), ("script", "写剧本"), ("storyboard", "写分镜"),
         ("code", "写动画代码"), ("render", "渲染画面"), ("compose", "合成配音和字幕")]
# 3D 图片任务（docs/library-3d-design.md）的步骤
MODEL_STEPS = [("analyze", "看图分析"), ("spec", "建模规格"), ("model", "建模"), ("review", "比对修正"), ("export", "导出")]
# 风格创建任务（docs/style-creator-design.md）的步骤，只在管理端显示
# 一段参考视频可以同时产出画风和写作方法：只要其中一种时，另一种的步骤跳过（docs/skills-two-dimensions.md）
STYLE_STEPS = [("analyze", "看视频"), ("listen", "听旁白"), ("traits", "提炼要素"), ("skill", "写说明书"), ("engine", "写引擎和示范镜头"),
               ("writing", "写写作方法"), ("check", "自检打分")]
ACTIVE = ("queued", "running", "awaiting_confirmation")


def table():
    return _ddb.Table(TABLE)


def now_ms():
    return int(time.time() * 1000)


def new_id():
    return str(uuid.uuid4())


LONG_SECONDS = int(os.environ.get("LONG_SECONDS", "180"))  # 超过这个时长的片子按章节并行制作


def session_id(task_id, chapter=None):
    """任务的会话号。长片每章另开一个会话：slate-task-<任务号>-c<章号>"""
    return f"slate-task-{task_id}" + (f"-c{chapter}" if chapter else "")


def session_parts(sid):
    """会话号 → (任务号, 章号)；不是本系统的会话返回 (None, None)"""
    m = re.fullmatch(r"slate-task-([0-9a-f-]{36})(?:-c([0-9]{2}))?", sid or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def task_id_from_session(sid):
    return session_parts(sid)[0]


def is_long(task):
    """长片：用户指定的时长超过 LONG_SECONDS，或者已经进入章节制作"""
    sp = ((task.get("request") or {}).get("options") or {}).get("spec") or {}
    return bool(task.get("chapters")) or bool(sp.get("enabled") and int(sp.get("duration") or 0) > LONG_SECONDS)


def prefix(sub, task_id):
    return f"u/{sub}/t/{task_id}"


def plain(o):
    """DynamoDB 的 Decimal 转回 int/float。"""
    if isinstance(o, list):
        return [plain(x) for x in o]
    if isinstance(o, dict):
        return {k: plain(v) for k, v in o.items()}
    if isinstance(o, Decimal):
        return int(o) if o == int(o) else float(o)
    return o


def ddb_safe(o):
    """float 转 Decimal，去掉空字符串键。"""
    return json.loads(json.dumps(o), parse_float=Decimal)


# ---------- 任务 ----------

def get_task(task_id):
    r = table().get_item(Key={"pk": f"TASK#{task_id}", "sk": "META"})
    return plain(r.get("Item")) if r.get("Item") else None


def put_task(item):
    table().put_item(Item=ddb_safe(item))


def update_task(task_id, expr, names=None, values=None, cond=None):
    kw = {"Key": {"pk": f"TASK#{task_id}", "sk": "META"}, "UpdateExpression": expr}
    if names:
        kw["ExpressionAttributeNames"] = names
    if values:
        kw["ExpressionAttributeValues"] = ddb_safe(values)
    if cond:
        kw["ConditionExpression"] = cond
    return table().update_item(**kw)


def set_fields(task_id, cond=None, **fields):
    """把若干顶层字段一次写入，同时刷新 updatedAt 和 gsi1sk。"""
    fields["updatedAt"] = now_ms()
    fields["gsi1sk"] = fields["updatedAt"]
    names = {f"#{k}": k for k in fields}
    values = {f":{k}": v for k, v in fields.items()}
    expr = "SET " + ", ".join(f"#{k} = :{k}" for k in fields)
    return update_task(task_id, expr, names, values, cond)


def add_message(task_id, role, text, kind="text", scope=None, extra=None):
    at = now_ms()
    item = {"pk": f"TASK#{task_id}", "sk": f"MSG#{at:015d}#{uuid.uuid4().hex[:6]}", "role": role, "kind": kind,
            "text": text, "at": at}
    if scope:
        item["scope"] = scope
    if extra:
        item.update(extra)
    table().put_item(Item=ddb_safe(item))
    return item


def messages(task_id):
    r = table().query(KeyConditionExpression=Key("pk").eq(f"TASK#{task_id}") & Key("sk").begins_with("MSG#"))
    return [plain(i) for i in r.get("Items", [])]


def tasks_of(sub, limit=100):
    r = table().query(IndexName="byUser", KeyConditionExpression=Key("gsi1pk").eq(f"USER#{sub}"),
                      ScanIndexForward=False, Limit=limit)
    return [plain(i) for i in r.get("Items", [])]


def product_of(task):
    """任务的产品类型：video（视频）、model3d（3D 图片）或 style（管理端的风格创建）"""
    return (task.get("request") or {}).get("product") or "video"


def steps_of(task):
    return {"model3d": MODEL_STEPS, "style": STYLE_STEPS}.get(product_of(task), STEPS)


def empty_steps(steps=STEPS):
    return {name: {"state": "pending", "note": ""} for name, _ in steps}


def turn_nonce():
    """轮次的口令：建轮次时就生成，finish 只认带着它的 hook（会话看不到，见 finish._verified）"""
    return secrets.token_hex(16)


def turn_secrets():
    """新轮次带的两样：口令（只给 Harness，会话看不到）和计费令牌（写进会话，看图、配音的 Lambda 凭它认任务）"""
    return {"nonce": turn_nonce(), "billToken": secrets.token_hex(16)}


def billed_task(b):
    """看图、配音这些按次计费的 Lambda 用：会话交来的 billing 要带着这一轮的计费令牌，对得上才算数。
    会话能直接调用这些 Lambda，任务号是它自己报的：不认令牌的话，不带任务号就白用，带别人的任务号就记到别人头上"""
    import hmac
    tid, tok, ch = str((b or {}).get("taskId") or ""), str((b or {}).get("token") or ""), (b or {}).get("chapter")
    task = get_task(tid) if re.fullmatch(r"[0-9a-f-]{36}", tid) and tok else None
    if not task:
        return None
    if ch:
        from . import chapters as chs
        turn = (chs.get(tid, str(ch)) or {}).get("turn") or {}
    else:
        turn = task.get("turn") or {}
    want = str(turn.get("billToken") or "")
    return task if want and hmac.compare_digest(want, tok) else None


def start_turn(task, kind, text=None, extra=None, check=True):
    """标记任务进入新的一轮，并异步调用 turn Lambda。check=True 时要求任务当前不在生成中（防止重复点击）。"""
    from botocore.exceptions import ClientError
    turn = {"id": new_id()[:8], "kind": kind, "modelIndex": 0, "attempt": 1, "autoContinues": 0,
            "startedAt": now_ms(), "text": text, **(extra or {}), **turn_secrets()}
    values = {":turn": turn, ":queued": "queued", ":null": None, ":now": now_ms()}
    cond = None
    if check:
        cond = "NOT #status IN (:queued, :running)"
        values[":running"] = "running"
    expr = ("SET turn = :turn, #status = :queued, failure = :null, lastError = :null, turnFlags = :empty, "
            "updatedAt = :now, gsi1sk = :now")
    node = turn.get("node")
    redo = kind == "revise" and node != "text"  # 工作流的文字节点只改剧本和分镜，不碰后面三步
    if redo:  # 修改轮会重写代码、重渲染、重新合成：这三步重新开始计
        expr += ", steps.code = :pending, steps.render = :pending, steps.#cp = :pending"
        values[":pending"] = {"state": "pending", "note": ""}
    if node:  # 工作流模式：记下这一轮属于哪个节点（文字 / 音画），节点的状态和对话按它分
        expr += ", flowNode = :node"
        values[":node"] = node
    names = {"#status": "status", **({"#cp": "compose"} if redo else {})}
    try:
        update_task(task["id"], expr, names=names, values={**values, ":empty": {}}, cond=cond)
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ApiError(409, "busy", "Agent 正在工作，等这一轮完成后再操作")
        raise
    lam.invoke(FunctionName=TURN_FN, InvocationType="Event",
                 Payload=json.dumps({"taskId": task["id"], "turnId": turn["id"]}).encode())
    return turn

# ---------- S3 ----------

def presign_get(key, expires=3600, download_name=None):
    params = {"Bucket": DATA_BUCKET, "Key": key}
    if download_name:
        from urllib.parse import quote
        params["ResponseContentDisposition"] = f"attachment; filename*=UTF-8''{quote(download_name)}"
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=expires)


# ---------- 渲染机（AgentCore Runtime 的 GPU 实例，docs/gpu-render-design.md）----------
RENDER_RUNTIME_ARN = os.environ.get("RENDER_RUNTIME_ARN", "")
RENDER_WARM_FN = os.environ.get("RENDER_WARM_FN", "")
RENDER_CAPACITY_ID = os.environ.get("RENDER_CAPACITY_ID", "")


def render_session(task_id, chapter=None):
    """一个任务一台渲染机；长片每 3 章共用一台（和会话里 slate/remote.py 的算法一致）"""
    g = (int(chapter) - 1) // 3 if chapter else 0
    return f"slate-render-{task_id}" + (f"-g{g}" if g else "")


def warm_render(task_id, chapter=None):
    """开工时异步预热渲染机：开机加拉镜像约 2 分钟，Agent 写完第一镜时机器已经就绪"""
    if RENDER_WARM_FN:
        try:
            lam.invoke(FunctionName=RENDER_WARM_FN, InvocationType="Event",
                       Payload=json.dumps({"sessions": [render_session(task_id, chapter)]}).encode())
        except Exception as e:
            print("预热渲染机失败：", e)


def stop_render(task_id, chapters=0):
    """任务停下来（完成、失败、等确认）时停掉它的渲染机，计费随之停止；之后再修改会重新开机"""
    # Instance 模式有两层会话：停 Runtime 会话只停掉机器上的渲染服务，机器还开着（要等空闲超时）；
    # 删除容量提供方会话才会立刻终止这台机器（几秒内开始关机，计费随之停止）
    if not RENDER_CAPACITY_ID:
        return
    groups = range(max(1, (int(chapters) + 2) // 3)) if chapters else [0]
    for g in groups:
        sid = f"slate-render-{task_id}" + (f"-g{g}" if g else "")
        try:
            agent.delete_capacity_provider_session(capacityProviderId=RENDER_CAPACITY_ID, sessionId=sid)
        except Exception as e:
            if "ResourceNotFound" not in type(e).__name__ and "not found" not in str(e).lower():
                print("停渲染机失败：", sid, str(e)[:200])


MEDIA_DOMAIN = os.environ.get("MEDIA_DOMAIN", "")
MEDIA_KEY_ID = os.environ.get("MEDIA_KEY_ID", "")
MEDIA_KEY_SECRET = os.environ.get("MEDIA_KEY_SECRET", "")
_media_signer = None


def _signer():
    """视频 CDN 的签名器：私钥在部署时生成并存进 Secrets Manager，每个 Lambda 容器读一次"""
    global _media_signer
    if _media_signer is None:
        from botocore.signers import CloudFrontSigner
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        pem = boto3.client("secretsmanager", region_name=REGION).get_secret_value(SecretId=MEDIA_KEY_SECRET)["SecretString"]
        key = serialization.load_pem_private_key(pem.encode(), password=None)
        _media_signer = CloudFrontSigner(MEDIA_KEY_ID, lambda msg: key.sign(msg, padding.PKCS1v15(), hashes.SHA1()))
    return _media_signer


def media_url(key, download_name=None):
    """播放和下载视频的链接：走视频 CDN（CloudFront 签名链接），没配 CDN 时退回 S3 预签名链接。
    有效期取到整点后再加一小时（1～2 小时）：同一小时里链接不变，浏览器和 CDN 的缓存都能命中"""
    if not (MEDIA_DOMAIN and MEDIA_KEY_ID and MEDIA_KEY_SECRET):
        return presign_get(key, download_name=download_name)
    from datetime import datetime, timezone
    from urllib.parse import quote
    url = f"https://{MEDIA_DOMAIN}/{quote(key)}"
    if download_name:
        url += "?dl=" + quote(download_name, safe="")  # CDN 的响应函数据此加上下载文件名
    exp = (int(time.time()) // 3600 + 2) * 3600
    return _signer().generate_presigned_url(url, date_less_than=datetime.fromtimestamp(exp, timezone.utc))


def read_json(key):
    return json.loads(s3.get_object(Bucket=DATA_BUCKET, Key=key)["Body"].read())


# ---------- 任务范围的临时凭证 ----------

def task_credentials(sub, task_id, seconds=3600):
    """假设 TaskDataRole 并附加会话策略：只能读写 u/<sub>/t/<taskId>/ 下的对象。"""
    pre = prefix(sub, task_id)
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": f"arn:aws:s3:::{DATA_BUCKET}/{pre}/*"},
        {"Effect": "Allow", "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{DATA_BUCKET}",
         "Condition": {"StringLike": {"s3:prefix": [f"{pre}/*"]}}},
    ]}
    r = sts.assume_role(RoleArn=TASK_DATA_ROLE_ARN, RoleSessionName=f"t-{task_id[:50]}", DurationSeconds=seconds,
                        Policy=json.dumps(policy))
    return r["Credentials"]


def session_command(task_id, command, timeout=120, chapter=None):
    """在任务的 Harness 会话里执行一条 shell 命令（不经过模型），返回 (exitCode, stdout, stderr)。"""
    r = agent.invoke_agent_runtime_command(agentRuntimeArn=HARNESS_ARN, runtimeSessionId=session_id(task_id, chapter),
                                           body={"command": command, "timeout": timeout})
    out, err, code = [], [], None
    for ev in r["stream"]:
        c = ev.get("chunk", {})
        if "contentDelta" in c:
            out.append(c["contentDelta"].get("stdout") or ""); err.append(c["contentDelta"].get("stderr") or "")
        elif "contentStop" in c:
            code = c["contentStop"].get("exitCode")
    return code, "".join(out), "".join(err)


def write_session_context(task, turn_id, chapter=None):
    """把本轮凭证和任务上下文写进会话：/root/.slate/credentials 和 task.json（章节会话带上章号）。"""
    import base64
    c = task_credentials(task["sub"], task["id"])
    cred = ("[task]\n"
            f"aws_access_key_id = {c['AccessKeyId']}\n"
            f"aws_secret_access_key = {c['SecretAccessKey']}\n"
            f"aws_session_token = {c['SessionToken']}\n")
    if chapter:
        from . import chapters as chs
        turn = (chs.get(task["id"], chapter) or {}).get("turn") or {}
    else:
        turn = (get_task(task["id"]) or {}).get("turn") or {}
    ctx = {"bucket": DATA_BUCKET, "prefix": prefix(task["sub"], task["id"]), "taskId": task["id"], "turnId": turn_id,
           "region": REGION, **({"chapter": chapter} if chapter else {}),
           **({"billToken": turn["billToken"]} if turn.get("id") == turn_id and turn.get("billToken") else {})}
    b1 = base64.b64encode(cred.encode()).decode()
    b2 = base64.b64encode(json.dumps(ctx).encode()).decode()
    cmd = (f"mkdir -p /root/.slate && umask 077 && echo {b1} | base64 -d > /root/.slate/credentials "
           f"&& echo {b2} | base64 -d > /root/.slate/task.json && echo ok")
    return session_command(task["id"], cmd, timeout=60, chapter=chapter)


class ApiError(Exception):
    """接口错误：status 是 HTTP 状态码，message 是给用户看的中文说明。"""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


_catalog = None


def catalog():
    """官方 Skill 目录（部署时从 agent/skills/catalog.json 复制进来）。"""
    global _catalog
    if _catalog is None:
        _catalog = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.json"), encoding="utf-8"))
    return _catalog


_genres = None


def genres():
    """写法目录（部署时从 agent/skills/genres.json 复制进来）：剧本怎么组织，和风格互相独立。"""
    global _genres
    if _genres is None:
        _genres = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "genres.json"), encoding="utf-8"))
    return _genres


def genre_of(gid):
    return next((g for g in genres() if g["id"] == gid), None)


def safe_name(name, n=120):
    """文件名只留最后一段，去掉控制字符和开头的点：用来拼 S3 键，会话里也按它落到本地路径"""
    s = os.path.basename(str(name or "").replace("\\", "/"))
    s = re.sub(r"[\x00-\x1f\x7f]", "", s).strip().lstrip(".").strip()
    return s[:n]


_voices = None


def voices():
    """配音音色目录（部署时从 agent/voices.json 复制进来）；前端只需要名字、分类、说明和试听地址"""
    global _voices
    if _voices is None:
        raw = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices.json"), encoding="utf-8"))
        _voices = [{"id": v["id"], "name": v["name"], "cat": v["cat"], "desc": v["desc"], "preview": f"voices/{v['id']}.mp3"}
                   for v in raw]
    return _voices


def json_dumps(o):
    return json.dumps(o, ensure_ascii=False, default=lambda x: plain(x) if isinstance(x, Decimal) else str(x))
