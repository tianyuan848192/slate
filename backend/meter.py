"""meter Lambda：每分钟一次，把主 Agent 的模型用量从 Harness 的运行日志记进账本（设计见 docs/credit-design.md）。

运行日志组是 Harness 默认写的（不需要另外开日志），里面有两种记录：
- 每轮开始时的一条应用日志："Returning streaming response"，resource 里有实例号，attributes 里有会话号 → 实例对应到会话；
- 每个实例每分钟一条用量指标（EMF）：strands.event_loop 的输入、缓存读、缓存写、输出 token，Sum 是精确的合计。
每次读最近一段时间（和上次有重叠，防止日志晚到），明细按"实例 + 时间"幂等，重复读不会重复记。
记完以后检查碰到的用户：本月用量超过额度的 120%，停掉他正在跑的任务（正常情况下额度用完就不让开新任务，这是长任务的兜底）。
"""
import json, os, traceback

import boto3

from lib import billing
from lib import chapters as chs
from lib import common as c

HARNESS_NAME = os.environ.get("HARNESS_NAME", "")
OVERLAP_MS = 10 * 60 * 1000
CURSOR = {"pk": "CONFIG#metering", "sk": "META"}
METRICS = {"input": "strands.event_loop.input.tokens", "cacheRead": "strands.event_loop.cache_read.input.tokens",
           "cacheWrite": "strands.event_loop.cache_write.input.tokens", "output": "strands.event_loop.output.tokens"}
HARD_LIMIT = 1.2
MAX_TOKENS_PER_RECORD = 20_000_000  # 一个实例一分钟的 token 上限：正常最多几百万（每次调用都读一遍缓存的上下文）
logs = boto3.client("logs", region_name=c.REGION)


def log_groups():
    prefix = f"/aws/bedrock-agentcore/runtimes/harness_{HARNESS_NAME}-"
    out, tok = [], None
    while True:
        r = logs.describe_log_groups(logGroupNamePrefix=prefix, **({"nextToken": tok} if tok else {}))
        out += [g["logGroupName"] for g in r["logGroups"]]
        tok = r.get("nextToken")
        if not tok:
            return out


def events(group, pattern, start, end):
    tok = None
    while True:
        kw = dict(logGroupName=group, startTime=start, endTime=end, filterPattern=pattern, limit=10000)
        if tok:
            kw["nextToken"] = tok
        r = logs.filter_log_events(**kw)
        yield from r["events"]
        tok = r.get("nextToken")
        if not tok:
            return


def metric_sum(d, name):
    v = d.get(name)
    if isinstance(v, dict):
        return int(round(float(v.get("Sum") or 0)))
    return int(round(float(v or 0)))


def calls_in(d):
    v = d.get(METRICS["output"])
    return int(v.get("Count") or 0) if isinstance(v, dict) else 1


def process(start, end):
    inst_cache, sess_cache, touched, stats = {}, {}, {}, {"usage": 0, "recorded": 0, "unmapped": 0, "other": 0}
    for group in log_groups():
        for e in events(group, '"Returning streaming response"', start, end):  # 实例 → 会话
            try:
                d = json.loads(e["message"])
                inst = d["resource"]["attributes"]["service.instance.id"]
                sid = (d.get("attributes") or {}).get("sessionId") or ""
            except (ValueError, KeyError, TypeError):
                continue
            if sid.startswith("slate-task-") and inst_cache.get(inst) != sid:
                billing.map_instance(inst, sid)
                inst_cache[inst] = sid
        for e in events(group, f'"{METRICS["input"]}"', start, end):  # 用量
            try:
                d = json.loads(e["message"])
            except ValueError:
                continue
            inst = d.get("otel.resource.service.instance.id")
            if not inst:
                continue
            stats["usage"] += 1
            at = int((d.get("_aws") or {}).get("Timestamp") or e["timestamp"])
            sid = billing.session_of_instance(inst, inst_cache)
            if not sid:
                stats["unmapped"] += 1  # 还没读到这个实例的开始记录：下一次读的时间段有重叠，会补上
                continue
            found = billing.find_session(sid, at, sess_cache)
            if not found:
                stats["other"] += 1  # 不是任务的会话（比如手工测试的会话），不记
                continue
            task, turn = found
            usage = {k: metric_sum(d, name) for k, name in METRICS.items()}
            if not any(usage.values()):
                continue
            if max(usage.values()) > MAX_TOKENS_PER_RECORD:  # 一条是一个实例一分钟的用量；离谱的数是会话伪造的
                print("usage record out of range, ignore", inst[:12], usage); continue
            n = calls_in(d)
            note = (f"{n} 次模型调用" if n else "") + ("；安全策略误拦后自动重做，不计费" if turn["free"] else "")
            cr = billing.record(task, at, f"m-{inst[:8]}-{at}", "model", turn, usage, model=turn["model"] or c.MODELS[0],
                                billable=not turn["free"], note=note)
            if cr is not None:
                stats["recorded"] += 1
                touched[task["sub"]] = task
    return touched, stats


def enforce(touched):
    """本月用量超过额度的 120%：停掉这个用户正在跑的任务"""
    for sub, t in touched.items():
        s = billing.summary(sub)
        if s["used"] <= s["quota"] * HARD_LIMIT:
            continue
        for task in c.tasks_of(sub, limit=50):
            if task.get("status") not in ("running", "queued"):
                continue
            sessions = [c.session_id(task["id"])] + [c.session_id(task["id"], x["id"]) for x in chs.all_of(task["id"])
                                                      if x.get("status") in ("running", "queued")]
            for sid in sessions:
                try:
                    c.agent.stop_runtime_session(agentRuntimeArn=c.HARNESS_ARN, runtimeSessionId=sid)
                except Exception:
                    pass
            for x in chs.all_of(task["id"]):
                if x.get("status") in ("running", "queued"):
                    chs.set_fields(task["id"], x["id"], status="failed", turn=None, failure={"message": "本月额度已超出，已停止", "at": c.now_ms()})
            msg = f"本月额度已超出（已用 {s['used']:.0f} / {s['quota']:.0f} Credit），任务已停止。下月 1 日恢复，或联系管理员调整额度。"
            c.set_fields(task["id"], status="failed", turn=None, failure={"message": msg, "at": c.now_ms()})
            print(json.dumps({"quota_stop": task["id"], "sub": sub, "used": s["used"], "quota": s["quota"]}))


def handler(event, context):
    now = c.now_ms()
    cur = c.plain(c.table().get_item(Key=CURSOR).get("Item") or {})
    last = int((event or {}).get("since") or cur.get("lastMs") or now - 30 * 60 * 1000)
    start = last - OVERLAP_MS
    try:
        touched, stats = process(start, now)
        c.table().put_item(Item={**CURSOR, "lastMs": now})
        enforce(touched)
        print(json.dumps({"from": start, "to": now, **stats}))
        return stats
    except Exception:
        traceback.print_exc()
        raise
