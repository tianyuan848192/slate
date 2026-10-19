"""llm Lambda：替会话调用模型（docs/model-keys-design.md），用部署账号的 IAM 角色调 Amazon Bedrock。

请求：{"images": [{"b64", "format"}], "question", "system", "maxTokens"?}；op 为 "text" 时可以不带图片（剧本核对）
op 为 "video" 时是看视频（风格创建听旁白）：{"key": 任务目录下参考视频的 S3 键, "question", "seconds"}，用 Bedrock 上的 TwelveLabs Pegasus，
视频只能是发起调用的这个任务自己目录里 input/ref/ 下的文件
返回：{"ok": true, "text", "source", "model"}；调不通时 {"ok": false, "error"}。
主模型被内容安全策略拦下时换备用模型（models.chain）。调用模型的权限在托管策略 <栈名>-models 里，和主 Agent 共用。
"""
import base64, json, re

import boto3
from botocore.config import Config

from lib import billing
from lib import common as c
from lib import models

LAST = {}  # 最近一次调用的 token 用量，记账用
# 看图模型先思考再回答，输出上限 8000 时一次可能要一两分钟；Lambda 最长 180 秒
BEDROCK = boto3.client("bedrock-runtime", region_name=c.REGION, config=Config(read_timeout=170, retries={"max_attempts": 1}))


def converse_body(ev):
    content = []
    for im in ev["images"]:
        content.append({"image": {"format": im.get("format", "jpeg"), "source": {"bytes": im["b64"]}}})
    content.append({"text": ev["question"]})
    return {"messages": [{"role": "user", "content": content}], "system": [{"text": ev["system"]}],
            "inferenceConfig": {"maxTokens": ev.get("maxTokens", 1500)}}


def converse_text(d):
    u = d.get("usage") or {}
    LAST["usage"] = {"input": int(u.get("inputTokens") or 0), "cacheRead": int(u.get("cacheReadInputTokens") or 0),
                     "cacheWrite": int(u.get("cacheWriteInputTokens") or 0), "output": int(u.get("outputTokens") or 0)}
    if d.get("stopReason") == "content_filtered":
        return None
    return "".join(b.get("text", "") for b in d["output"]["message"]["content"])


def via_iam(r, ev):
    body = converse_body(ev)
    for m in body["messages"][0]["content"]:
        if "image" in m:
            m["image"]["source"]["bytes"] = base64.b64decode(m["image"]["source"]["bytes"])
    return converse_text(BEDROCK.converse(modelId=r["model"], **body))


CALL = {"bedrock": via_iam}


VIDEO_MODEL = models.VIDEO_MODEL
_account = []


def account():
    """数据桶所在的账号（Pegasus 读数据桶里的视频时要写 bucketOwner）"""
    if not _account:
        _account.append(boto3.client("sts", region_name=c.REGION).get_caller_identity()["Account"])
    return _account[0]


def watch(ev):
    """看视频：Pegasus 直接读数据桶里的视频（不经过会话），听旁白、语气语调、配乐，按要求输出文字。按视频秒数和输出 token 记账"""
    b = ev.get("billing") or {}
    tid, key = str(b.get("taskId") or ""), str(ev.get("key") or "")
    task = c.get_task(tid) if re.fullmatch(r"[0-9a-f-]{36}", tid) else None
    if not task or not key.startswith(c.prefix(task["sub"], tid) + "/input/ref/") or ".." in key:
        return {"ok": False, "error": "只能看这个任务自己的参考视频"}
    body = {"inputPrompt": ev["question"][:20000], "temperature": 0,
            "mediaSource": {"s3Location": {"uri": f"s3://{c.DATA_BUCKET}/{key}", "bucketOwner": account()}}}
    try:
        r = BEDROCK.invoke_model(modelId=VIDEO_MODEL, body=json.dumps(body))
        out = json.loads(r["body"].read())
    except Exception as e:
        print("video model failed", repr(e)[:300])
        return {"ok": False, "error": str(e)[:300]}
    # 视频秒数由会话报上来（probe 量的时长），限制在 1 秒到 1 小时；输出 token 以模型返回的为准
    secs = max(1.0, min(3600.0, float(ev.get("seconds") or 0) or 1.0))
    usage = {"output": int(out.get("output_tokens") or 0), "seconds": secs}
    try:
        found = billing.find_session(c.session_id(tid, b.get("chapter")), c.now_ms())
        if found:
            t, turn = found
            billing.record(t, c.now_ms(), f"w-{c.new_id()}", "video", turn, usage, model=VIDEO_MODEL, billable=not turn["free"],
                           note=f"看视频 {secs:.0f} 秒")
    except Exception as e:
        print("video billing failed", repr(e)[:300])
    return {"ok": True, "text": out.get("message") or "", "model": "TwelveLabs Pegasus 1.5", "stop": out.get("stopReason")}


def handler(event, context):
    ev = event or {}
    task = c.billed_task(ev.get("billing"))  # 先认任务、查额度，再调模型（第二次扫描 #1、#14）
    if not task:
        return {"ok": False, "error": "这次调用没有带上本轮的计费凭证"}
    try:
        billing.check_quota(task["sub"])
    except c.ApiError as e:
        return {"ok": False, "error": e.message}
    if ev.get("op") == "video":
        return watch(ev) if ev.get("question") and ev.get("key") else {"ok": False, "error": "缺少视频或问题"}
    # op=text：只有文字（剧本和参考资料的核对，refs.check_script）；默认是看图
    if not ev.get("question") or (not ev.get("images") and ev.get("op") != "text"):
        return {"ok": False, "error": "缺少图片或问题"}
    ev.setdefault("images", [])
    ev.setdefault("system", "")
    down, filtered, err, last = set(), set(), None, None
    for r in models.chain("vision"):
        if r["src"] in down or r["model"] in filtered:
            continue
        LAST.clear()
        try:
            text = CALL[r["kind"]](r, ev)
            bill(ev, r["model"], LAST.get("usage"))
        except Exception as e:  # 调不通：只有这一个来源，后面的模型也不用试了
            print("vision call failed", r["model"], repr(e)[:300])
            down.add(r["src"]); err = e
            continue
        if text is None:  # 被内容安全策略拦下：换下一个模型
            filtered.add(r["model"]); last = r
            continue
        return {"ok": True, "text": text, "source": r["name"], "model": models.label(r["model"])}
    if last:
        return {"ok": True, "text": "（看图模型没有返回结论，请换个问法再试）", "source": last["name"], "model": models.label(last["model"])}
    return {"ok": False, "error": str(err)[:300]}


def bill(ev, model, usage):
    """看图的 token 记在发起调用的任务上（被安全策略拦下的调用也照样消耗了 token）。记账失败不影响看图结果"""
    b = ev.get("billing") or {}
    tid = str(b.get("taskId") or "")
    if not usage or not re.fullmatch(r"[0-9a-f-]{36}", tid):
        return
    try:
        found = billing.find_session(c.session_id(tid, b.get("chapter")), c.now_ms())
        if found:
            task, turn = found
            billing.record(task, c.now_ms(), f"v-{c.new_id()}", "vision", turn, usage, model=model, billable=not turn["free"],
                           note="安全策略误拦后自动重做，不计费" if turn["free"] else "")
    except Exception as e:
        print("vision billing failed", repr(e)[:300])
