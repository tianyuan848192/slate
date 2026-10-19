"""把渲染和自检交给渲染机（AgentCore Runtime 的 GPU 实例，见 docs/gpu-render-design.md）。

开关：环境变量 SLATE_RENDER_RUNTIME_ARN（CDK 写进 Harness）。设成 SLATE_RENDERER=browser 时不用渲染机。
渲染机调不通（开不出机器、超时、被拒绝）时返回 None，调用方退回原来的远程浏览器方式。
"""
import configparser, hashlib, io, json, os, re, sys, tarfile

import boto3
from botocore.config import Config

from .common import REGION, STATE, ctx, key, path, s3

ARN = os.environ.get("SLATE_RENDER_RUNTIME_ARN", "")
INPUT_RE = re.compile(r"/input/([^\"')\s?#]+)")
SHARED_RE = re.compile(r"\.\./(_[A-Za-z0-9_-]+)/")
SKILL_RE = re.compile(r"/skills/([a-z0-9-]+)/")


def enabled():
    return bool(ARN) and os.environ.get("SLATE_RENDERER", "remote") != "browser" and bool(ctx()) \
        and os.path.exists(os.path.join(STATE, "credentials"))


def session_id():
    """一个任务一台渲染机；长片每 3 章共用一台"""
    c = ctx()
    ch = c.get("chapter")
    g = (int(ch) - 1) // 3 if ch else 0
    return f"slate-render-{c['taskId']}" + (f"-g{g}" if g else "")


def _creds():
    cp = configparser.ConfigParser()
    cp.read(os.path.join(STATE, "credentials"))
    t = cp["task"]
    return {"key": t["aws_access_key_id"], "secret": t["aws_secret_access_key"], "token": t["aws_session_token"]}


def _scene_text(sid):
    out = []
    for root, _, files in os.walk(path("scenes", sid)):
        for f in files:
            if f.endswith((".html", ".js", ".mjs", ".css")):
                out.append(open(os.path.join(root, f), encoding="utf-8", errors="ignore").read())
    return "".join(out)


def bundle(scene_ids, with_clips=False):
    """要渲染的镜头和它们用到的文件打成一个包：分镜、brief、配音时间轴、这几镜的目录、引用到的共用目录、用户上传文件和生成的风格"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        def add(rel):
            p = path(rel)
            if os.path.exists(p):
                tf.add(p, arcname=rel)
        for f in ("storyboard.json", "brief.json"):
            add(f)
        for sid in scene_ids:
            add(os.path.join("voice", f"{sid}.json"))
        refs, shared, skills = set(), set(), set()
        for sid in scene_ids:
            add(os.path.join("scenes", sid))
            text = _scene_text(sid)
            refs.update(INPUT_RE.findall(text))
            shared.update(SHARED_RE.findall(text))
            skills.update(SKILL_RE.findall(text))
        for d in sorted(shared):
            add(os.path.join("scenes", d))
            skills.update(SKILL_RE.findall(_scene_text(d)))
        for r in sorted(refs):
            if ".." not in r:
                add(os.path.join("input", r))
        for k in sorted(skills):  # 管理员生成的风格不在渲染机的镜像里，随包带过去
            add(os.path.join("input", "styles", k))
        if with_clips:
            for sid in scene_ids:
                add(os.path.join("clips", f"{sid}.mp4"))
    return buf.getvalue()


def call(op, scene_ids, **kw):
    """调用渲染机，返回它的结果；调不通时返回 None（原因写到标准错误）"""
    try:
        c = ctx()
        data = bundle(scene_ids, with_clips=(op == "qa"))
        k = key("render", f"{hashlib.sha256(data).hexdigest()[:32]}.tgz")
        s3().put_object(Bucket=c["bucket"], Key=k, Body=data)
        dp = boto3.client("bedrock-agentcore", region_name=REGION,
                          config=Config(read_timeout=900, connect_timeout=30, retries={"max_attempts": 2}))
        payload = {"op": op, "bundle": k, "bucketName": c["bucket"], "scenes": scene_ids, "creds": _creds(),
                   **({"chapter": c["chapter"]} if c.get("chapter") else {}), **kw}
        r = dp.invoke_agent_runtime(agentRuntimeArn=ARN, runtimeSessionId=session_id(), payload=json.dumps(payload).encode(),
                                    contentType="application/json", accept="application/json")
        res = json.loads(r["response"].read())
        if res.get("error"):
            print(json.dumps({"render_machine": "error", "detail": str(res["error"])[-300:]}, ensure_ascii=False), file=sys.stderr)
            return None
        return res
    except Exception as e:
        print(json.dumps({"render_machine": "unavailable", "detail": str(e)[:300]}, ensure_ascii=False), file=sys.stderr)
        return None


def download(k, local):
    os.makedirs(os.path.dirname(local), exist_ok=True)
    s3().download_file(ctx()["bucket"], k, local)
