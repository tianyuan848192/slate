"""验证拒答兜底和失败重试链路：造一个"第一轮被模型安全策略拦下"的任务，看 finish Lambda 是否换备用模型继续并出片。

做法：在任务表里直接写一条 running 状态的任务（模型序号 0），再以 Harness hook 的格式调用 finish Lambda，
stopReason = content_filtered。预期：出现一条系统提示、模型序号变成 1、同一会话里从头做完并出片。
用法：python scripts/test_fallback.py --email a@b.com "冷萃和热萃咖啡有什么区别，30 秒"
"""
import argparse, json, os, sys, time, uuid

import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

ap = argparse.ArgumentParser()
ap.add_argument("--email", required=True); ap.add_argument("--stack", default="Slate"); ap.add_argument("description")
ap.add_argument("--stop", default="content_filtered", help="模拟的结束原因，比如 content_filtered、hook_stopped（会标记失败）")
a = ap.parse_args()
out = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{a.stack}.json")))[a.stack]
os.environ.update(TABLE=out["TableName"], AWS_DEFAULT_REGION="us-east-1")
from lib import common as c  # noqa: E402
from lib.validate import task_request  # noqa: E402

idp = boto3.client("cognito-idp", region_name="us-east-1")
user = idp.admin_get_user(UserPoolId=out["UserPoolId"], Username=a.email)
sub = next(x["Value"] for x in user["UserAttributes"] if x["Name"] == "sub")

# 按 api Lambda 的方式构造任务（快速模式，没有上传文件）
req = task_request({"mode": "quick", "web_search": False, "description": a.description})
req["options"]["script"]["files"] = []; req["options"]["assets"]["files"] = []
req["options"]["script"].pop("uploads", None); req["options"]["assets"].pop("uploads", None)
tid, now = str(uuid.uuid4()), c.now_ms()
turn = {"id": uuid.uuid4().hex[:8], "kind": "start", "modelIndex": 0, "attempt": 1, "autoContinues": 0, "startedAt": now, "text": None}
c.put_task({"pk": f"TASK#{tid}", "sk": "META", "id": tid, "sub": sub, "email": a.email, "gsi1pk": f"USER#{sub}", "gsi1sk": now,
            "title": a.description[:24], "mode": "quick", "request": req, "status": "running", "steps": c.empty_steps(),
            "docs": {}, "clips": {}, "versions": [], "turn": turn, "turnFlags": {}, "failure": None, "createdAt": now, "updatedAt": now,
            "model": "global.anthropic.claude-opus-5-5"})
c.add_message(tid, "user", a.description)
print("task", tid)

ev = {"hookEventId": "test-" + uuid.uuid4().hex[:6], "name": "finish", "event": "after_invocation", "harnessArn": out["HarnessArn"],
      "sessionId": c.session_id(tid), "context": {"stopReason": a.stop, "usage": {"inputTokens": 0, "outputTokens": 0}}}
r = boto3.client("lambda", region_name="us-east-1").invoke(FunctionName=f"{a.stack}-finish", Payload=json.dumps(ev).encode())
print("finish hook ->", r["Payload"].read().decode())
time.sleep(15)
t = c.get_task(tid)
print("after hook:", t["status"], "modelIndex =", t["turn"]["modelIndex"] if t.get("turn") else None, "model =", t.get("model"))
print([m["text"] for m in c.messages(tid)])
