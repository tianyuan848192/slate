"""长片的章节：每章一个会话、一条记录（pk=TASK#<任务号>，sk=CH#<章号>），各章并行制作，全部完成后在主会话里拼成整片。

章节记录：{id, title, duration, status: queued|running|done|failed, turn, flags, steps, storyboard, clips, final, failure, updatedAt}
- turn：这一章当前的轮次（结构和任务的 turn 一样：id、kind、modelIndex、attempt、autoContinues、filtered…）；
- flags：这一轮里 events 写入的标记（final、fail）；
- steps：这一章的 code / render / compose 进度，任务页把各章汇总成全片的进度；
- storyboard、clips：这一章的分镜和片段（镜头号是章内的两位数，任务页显示成 "03-12"）。
"""
import json

from boto3.dynamodb.conditions import Key

from . import common as c

CHAPTER_STEPS = ("storyboard", "code", "render", "compose")


def chapter_key(task_id, ch):
    return {"pk": f"TASK#{task_id}", "sk": f"CH#{ch}"}


def all_of(task_id):
    r = c.table().query(KeyConditionExpression=Key("pk").eq(f"TASK#{task_id}") & Key("sk").begins_with("CH#"), ConsistentRead=True)
    return sorted((c.plain(i) for i in r.get("Items", [])), key=lambda x: x["id"])


def get(task_id, ch):
    r = c.table().get_item(Key=chapter_key(task_id, ch))
    return c.plain(r["Item"]) if r.get("Item") else None


def update(task_id, ch, expr, names=None, values=None, cond=None, ret=None):
    kw = {"Key": chapter_key(task_id, ch), "UpdateExpression": expr}
    if names:
        kw["ExpressionAttributeNames"] = names
    if values:
        kw["ExpressionAttributeValues"] = c.ddb_safe(values)
    if cond:
        kw["ConditionExpression"] = cond
    if ret:
        kw["ReturnValues"] = ret
    return c.table().update_item(**kw)


def set_fields(task_id, ch, **fields):
    fields["updatedAt"] = c.now_ms()
    return update(task_id, ch, "SET " + ", ".join(f"#{k} = :{k}" for k in fields), {f"#{k}": k for k in fields},
                  {f":{k}": v for k, v in fields.items()})


def new_turn(kind, text=None, extra=None):
    return {"id": c.new_id()[:8], "kind": kind, "modelIndex": 0, "attempt": 1, "autoContinues": 0,
            "startedAt": c.now_ms(), "text": text, **(extra or {}), **c.turn_secrets()}


def start(task, ids, kind, text=None, extra=None):
    """开始（或重做）若干章：写好章节记录和轮次，任务进入"各章制作中"，每章异步调用一次 turn Lambda"""
    outline = (task.get("docs") or {}).get("outline") or {}
    plan = {x["id"]: x for x in outline.get("chapters") or []}
    bad = [ch for ch in ids if ch not in plan]
    if bad:  # 总纲里没有的章号：不能建出来开工
        raise c.ApiError(400, "bad_scope", f"总纲里没有第 {'、'.join(bad)} 章")
    now = c.now_ms()
    for ch in ids:
        turn = new_turn(kind, text, extra)
        cur = get(task["id"], ch)
        item = {**chapter_key(task["id"], ch), "id": ch, "title": plan.get(ch, {}).get("title", ""),
                "duration": plan.get(ch, {}).get("duration"), "status": "queued", "turn": turn, "flags": {}, "failure": None,
                "steps": {s: {"state": "pending", "note": ""} for s in CHAPTER_STEPS}, "clips": {}, "updatedAt": now}
        if cur and kind != "start":  # 重做和修改：保留已有的分镜、片段和成片，只换轮次
            item.update({k: cur[k] for k in ("storyboard", "clips", "final") if k in cur})
            if kind == "revise":  # 修改会重写代码、重渲、重新合成：分镜这一步保持已完成
                item["steps"]["storyboard"] = cur.get("steps", {}).get("storyboard") or item["steps"]["storyboard"]
        c.table().put_item(Item=c.ddb_safe(item))
    c.set_fields(task["id"], status="running", turn={"id": c.new_id()[:8], "kind": "chapters", "startedAt": now, **c.turn_secrets()},
                 failure=None, lastError=None, turnFlags={}, stitching=False)
    for ch in ids:
        it = get(task["id"], ch)
        c.lam.invoke(FunctionName=c.TURN_FN, InvocationType="Event",
                     Payload=json.dumps({"taskId": task["id"], "turnId": it["turn"]["id"], "chapter": ch}).encode())


def after_chapter(task_id):
    """某一章结束（完成或失败）后：全部完成就拼接整片；有失败且其余都结束了，任务失败（重试只重做失败的章）"""
    task = c.get_task(task_id)
    if not task or (task.get("turn") or {}).get("kind") != "chapters":
        return
    chs = all_of(task_id)
    if any(x["status"] in ("queued", "running") for x in chs):
        return
    bad = [x for x in chs if x["status"] == "failed"]
    if bad:
        names = "、".join(f"第 {int(x['id'])} 章" for x in bad)
        why = (bad[0].get("failure") or {}).get("message", "")
        c.set_fields(task_id, status="failed", turn=None,
                     failure={"message": f"{names}没有完成{('：' + why) if why else ''}。可以点重试，只重做没完成的章。", "at": c.now_ms(),
                              "chapters": [x["id"] for x in bad]})
        return
    stitch(task)


def stitch(task):
    """各章都有成片了：在主会话里拼接（不经过模型）。用条件写入保证只触发一次"""
    from botocore.exceptions import ClientError
    turn = {"id": c.new_id()[:8], "kind": "stitch", "startedAt": c.now_ms(), **c.turn_secrets()}
    try:
        c.update_task(task["id"], "SET #t = :t, #s = :y, #u = :now", names={"#t": "turn", "#s": "stitching", "#u": "updatedAt"},
                      values={":t": turn, ":y": True, ":n": False, ":now": c.now_ms()}, cond="attribute_not_exists(#s) OR #s = :n")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        raise
    c.lam.invoke(FunctionName=c.TURN_FN, InvocationType="Event",
                 Payload=json.dumps({"taskId": task["id"], "turnId": turn["id"], "stitch": True}).encode())


def merged_storyboard(task, chs):
    """把各章的分镜拼成全片的分镜给任务页：镜头号写成 "章号-镜头号"，带上章号和章名"""
    outline = (task.get("docs") or {}).get("outline") or {}
    by = {x["id"]: x for x in chs}
    scenes = []
    for plan in outline.get("chapters") or []:
        ch = by.get(plan["id"]) or {}
        for s in (ch.get("storyboard") or {}).get("scenes") or []:
            clip = (ch.get("clips") or {}).get(s["id"])
            scenes.append({**s, "id": f"{plan['id']}-{s['id']}", "chapter": plan["id"], "chapterTitle": plan.get("title"), "_clip": clip})
    first = next((x.get("storyboard") for x in chs if x.get("storyboard")), {}) or {}
    return {"title": outline.get("title"), **{k: first[k] for k in ("ratio", "resolution", "fps") if k in first}, "scenes": scenes}
