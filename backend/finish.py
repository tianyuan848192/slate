"""finish Lambda：Harness 的 afterInvocation hook 目标，每轮结束时调用一次。

负载：{"event": "after_invocation", "harnessArn", "sessionId", "context": {"stopReason", "usage"}}
- end_turn：保存工作区（slate-sync push），按这一轮的产出决定任务状态；
- content_filtered（模型安全策略误拦）：换下一个备用模型，在同一会话里发"继续"；
- 迭代次数、时长、输出长度到上限：自动续跑，最多两次，再到上限就标记失败。
长片：主会话写完总纲后开始各章并行制作；章节会话（会话号带 -c<章号>）的每一轮在章节记录里收尾，全部完成后拼接整片。
返回 {"decision": "allow"}（hook 的约定）。
"""
import hmac, json, os, traceback

from lib import common as c
from lib import models
from lib import chapters as chs
from lib import flows

AUTO_CONTINUE = {"max_iterations_exceeded", "timeout_exceeded", "max_tokens", "max_output_tokens_exceeded",
                 "model_context_window_exceeded", "partial_turn", "interrupted", "tool_use", "tool_result"}
LIMIT_TEXT = {"max_iterations_exceeded": "步骤太多", "timeout_exceeded": "用时超过上限", "max_tokens": "输出太长",
              "max_output_tokens_exceeded": "输出太长", "model_context_window_exceeded": "对话太长"}


HARNESS_PREFIX = f"arn:aws:bedrock-agentcore:{c.REGION}:"


def _verified(ev, turn):
    """Harness 用执行角色调用 hook，会话里的代码也能调用 finish，所以负载不可信：只认带着这一轮口令的。
    口令在建轮次时生成，每次调用 Harness 前 turn Lambda 再换一个新的，经 baggage 交给 Harness，会话里看不到。没有口令的一律不认"""
    want = turn.get("nonce")
    if not want:
        return False
    bag = str((ev.get("headers") or {}).get("baggage") or "")
    got = dict(p.strip().split("=", 1) for p in bag.split(",") if "=" in p).get("slate.nonce", "")
    return hmac.compare_digest(got, want)


def _node(task):
    """工作流模式：系统消息也记在这一轮所属的节点下"""
    node = flows.node_of(task)
    return {"node": node} if node else None


def handler(event, context):
    """hook 调用时立刻返回，把收尾工作交给一次异步调用（收尾要推送工作区，可能超过 hook 的等待时间）。"""
    try:
        arn = str(event.get("harnessArn") or "")
        name = os.environ.get("HARNESS_NAME", "")
        if not (arn.startswith(HARNESS_PREFIX) and f":harness/{name}-" in arn):
            print("unknown harness, ignore", arn); return {"decision": "allow"}
        if not event.get("_async"):
            c.lam.invoke(FunctionName=context.function_name, InvocationType="Event",
                         Payload=json.dumps({**event, "_async": True}).encode())
            return {"decision": "allow"}
        c.HARNESS_ARN = arn
        process(event)
    except Exception:
        traceback.print_exc()
    return {"decision": "allow"}


FILTERED_TEXT = "这条需求触发了模型的内容安全策略，没能完成。可以调整描述或参考资料后重试。"


def process(ev):
    process_turn(ev)
    task_id, _ = c.session_parts(ev.get("sessionId"))
    t = c.get_task(task_id) if task_id else None
    if t and t.get("status") not in ("running", "queued"):
        n = len(chs.all_of(task_id)) if c.is_long(t) else 0
        if not n or not any(x.get("status") in ("running", "queued") for x in chs.all_of(task_id)):
            c.stop_render(task_id, n)


def process_turn(ev):
    print(json.dumps({k: v for k, v in ev.items() if k != "headers"})[:1000])  # 请求头里有口令，不进日志
    task_id, ch = c.session_parts(ev.get("sessionId"))
    task = c.get_task(task_id) if task_id else None
    if task and ch:
        return process_chapter(task, ch, ev)
    if not task or task.get("status") not in ("running", "queued") or not task.get("turn"):
        print("no running turn, ignore", task_id); return
    turn = task["turn"]
    if not _verified(ev, turn):
        print("hook without this turn's nonce, ignore", task_id); return
    stop = (ev.get("context") or {}).get("stopReason") or "end_turn"

    if stop == "end_turn":
        push(task, turn)
        settle(task, turn)
    elif stop == "content_filtered":
        chain = models.agent_chain()
        i = min(turn.get("modelIndex", 0), len(chain) - 1)
        filtered = [*turn.get("filtered", []), chain[i]["model"]]
        nxt = models.next_model(chain, i, filtered)
        if nxt is not None:
            c.add_message(task_id, "agent", "遇到一点小状况，Agent 换一种方式继续处理。", kind="system", extra=_node(task))
            restart(task, turn, modelIndex=nxt, filtered=filtered, restartReason="filtered")
        else:
            push(task, turn)
            fail(task, FILTERED_TEXT)
    elif stop in AUTO_CONTINUE and turn.get("autoContinues", 0) < 2:
        restart(task, turn, autoContinues=turn.get("autoContinues", 0) + 1, restartReason="continue")
    else:
        push(task, turn)
        fail(task, f"这一轮没有完成（{LIMIT_TEXT.get(stop, stop)}）。可以点重试，让 Agent 接着做。")


def process_chapter(task, ch, ev):
    """长片某一章的一轮结束"""
    rec = chs.get(task["id"], ch)
    if not rec or rec.get("status") not in ("running", "queued") or not rec.get("turn"):
        print("no running chapter turn, ignore", task["id"], ch); return
    turn = rec["turn"]
    if not _verified(ev, turn):
        print("hook without this turn's nonce, ignore", task["id"], ch); return
    stop = (ev.get("context") or {}).get("stopReason") or "end_turn"
    chain = models.agent_chain()
    i = min(turn.get("modelIndex", 0), len(chain) - 1)

    def failed(message):
        push(task, turn, ch)
        chs.set_fields(task["id"], ch, status="failed", turn=None, failure={"message": message, "at": c.now_ms()})
        chs.after_chapter(task["id"])

    if stop == "end_turn":
        push(task, turn, ch)
        flags = (chs.get(task["id"], ch) or {}).get("flags") or {}
        if flags.get("fail"):
            failed(flags["fail"])
        elif flags.get("final"):
            chs.set_fields(task["id"], ch, status="done", turn=None, flags={})
            chs.after_chapter(task["id"])
        else:
            failed(f"这一章结束了，但没有合成出成片{('：' + rec['lastError']) if rec.get('lastError') else ''}")
    elif stop == "content_filtered":
        filtered = [*turn.get("filtered", []), chain[i]["model"]]
        nxt = models.next_model(chain, i, filtered)
        if nxt is not None:
            restart_chapter(task, ch, turn, modelIndex=nxt, filtered=filtered, restartReason="filtered")
        else:
            failed(FILTERED_TEXT)
    elif stop in AUTO_CONTINUE and turn.get("autoContinues", 0) < 3:
        restart_chapter(task, ch, turn, autoContinues=turn.get("autoContinues", 0) + 1, restartReason="continue")
    else:
        failed(f"这一章没有完成（{LIMIT_TEXT.get(stop, stop)}）")


def restart_chapter(task, ch, turn, **changes):
    new_turn = {**turn, **changes, "kind": "continue", "origin": turn.get("origin") or turn["kind"],
                "attempt": turn.get("attempt", 1) + 1, "startedAt": c.now_ms()}
    chs.set_fields(task["id"], ch, turn=new_turn, status="queued")
    c.lam.invoke(FunctionName=c.TURN_FN, InvocationType="Event",
                 Payload=json.dumps({"taskId": task["id"], "turnId": new_turn["id"], "chapter": ch}).encode())


def push(task, turn, ch=None):
    try:
        c.write_session_context(task, turn["id"], chapter=ch)
        code, out, err = c.session_command(task["id"], "slate-sync push", timeout=180, chapter=ch)
        print("sync push:", code, out[-200:], err[-200:])
    except Exception:
        traceback.print_exc()


def restart(task, turn, **changes):
    """同一轮换模型或续跑：保持 turn.id 不变（事件按 turnId 归属），kind 改成 continue。"""
    new_turn = {**turn, **changes, "kind": "continue", "origin": turn.get("origin") or turn["kind"],
                "attempt": turn.get("attempt", 1) + 1, "startedAt": c.now_ms()}
    c.set_fields(task["id"], turn=new_turn, status="queued")
    c.lam.invoke(FunctionName=c.TURN_FN, InvocationType="Event",
                 Payload=json.dumps({"taskId": task["id"], "turnId": new_turn["id"]}).encode())


def fail(task, message):
    c.set_fields(task["id"], status="failed", failure={"message": message, "at": c.now_ms()}, turn=None)


def settle(task, turn):
    """一轮正常结束：根据这一轮发出的事件决定状态。"""
    t = c.get_task(task["id"])  # 重新读，拿到 events Lambda 刚写入的字段
    flags = t.get("turnFlags") or {}
    product = c.product_of(t)
    # 已经有的成品：3D 版本、风格创建导出的版本（画风或写作方法）、成片版本
    made = (t.get("styleVersions") or t.get("writingVersions")) if product == "style" else t.get("models" if product == "model3d" else "versions")
    origin = turn.get("origin") or turn["kind"]
    if flags.get("fail"):
        fail(t, flags["fail"])
    elif flags.get("chaptersReady"):  # 长片：总纲写好了。要确认就先停下给用户看，否则直接开始各章
        ids = [x["id"] for x in ((t.get("docs") or {}).get("outline") or {}).get("chapters") or []]
        if not ids:
            fail(t, f"总纲没有发布成功{('：' + t['lastError']) if t.get('lastError') else ''}。可以点重试。")
        elif (t["request"]["options"] or {}).get("confirm_storyboard") and not t.get("outlineConfirmed"):
            c.set_fields(t["id"], status="awaiting_confirmation", turn=None, turnFlags={})
        else:
            chs.start(t, ids, "start")
    elif flags.get("reviseChapters"):  # 长片的全片修改：主会话判断好要重做哪几章
        rc = flags["reviseChapters"]
        chs.start(t, rc["chapters"], "revise", text=rc.get("note"))
    elif flags.get("awaiting"):
        c.set_fields(t["id"], status="awaiting_confirmation", turn=None, turnFlags={})
    elif flags.get("version"):
        c.set_fields(t["id"], status="completed", turn=None, turnFlags={})
    elif made and origin in ("revise", "retry"):
        # 修改轮没有出新版本（比如用户只是提问，或请求超出范围）：回到已完成状态
        c.set_fields(t["id"], status="completed", turn=None, turnFlags={})
    elif origin == "revise" and (t.get("docs") or {}).get("storyboard") and not t.get("versions"):
        c.set_fields(t["id"], status="awaiting_confirmation", turn=None, turnFlags={})
    else:
        last = t.get("lastError")
        what = {"model3d": "3D 图片", "style": "风格"}.get(product, "视频")
        fail(t, f"这一轮结束了，但没有产出{what}{('：' + last) if last else ''}。可以点重试，让 Agent 接着做。")
