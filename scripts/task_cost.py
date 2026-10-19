"""按任务统计主 Agent 的模型 token 和费用（含提示缓存）。

数据来源：Harness 运行时日志里每次模型调用的 EMF 指标（strands.event_loop.*），按会话实例（service.instance.id）汇总。
日志里没有会话号，所以用 finish Lambda 收到的每轮用量（会话号 + 未命中缓存的输入和输出 token）去对：
同一个会话的合计和某个实例的合计完全相同，就认定是它；对不上时退回按时间段归属（多个任务同时跑时会算重）。hook 回传的 inputTokens 只算没命中缓存的部分，CloudWatch AWS/Bedrock 的缓存指标对 global 推理配置一直是 0，
所以这两处都不能用来算缓存后的费用。

用法：python scripts/task_cost.py [任务 ID 前缀 ...]      不带参数时统计最近 24 小时的任务
说明：单价按 Opus 5.5 计（用 IAM 角色还是 Bedrock API Key 调用，单价一样）；被拦后改用备用模型的那部分也按这个价算。slate-look 看图（Sonnet 5.5）不在这里，每个任务约 $0.1。
"""
import collections, json, os, sys, time

import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = json.load(open(os.path.join(ROOT, ".slate", "outputs-Slate.json")))["Slate"]
REGION = "us-east-1"
PRICE = {"input": 4e-6, "cache_read": 0.2e-6, "cache_write": 5e-6, "output": 20e-6}  # Opus 5.5，global 推理配置
KEYS = {"input": "strands.event_loop.input.tokens", "output": "strands.event_loop.output.tokens",
        "cache_read": "strands.event_loop.cache_read.input.tokens", "cache_write": "strands.event_loop.cache_write.input.tokens"}

logs = boto3.client("logs", region_name=REGION)
table = boto3.resource("dynamodb", region_name=REGION).Table(out["TableName"])


def tasks(prefixes):
    items, kw = [], dict(FilterExpression="sk = :m AND begins_with(pk, :t)", ExpressionAttributeValues={":m": "META", ":t": "TASK#"})
    while True:
        r = table.scan(**kw)
        items += r["Items"]
        if "LastEvaluatedKey" not in r: break
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    if prefixes:
        return [t for t in items if any(t["id"].startswith(p) for p in prefixes)]
    since = (time.time() - 86400) * 1000
    return [t for t in items if int(t["updatedAt"]) >= since]


def runtime_log_group():
    stack = os.environ.get("STACK", "Slate")
    prefix = f"/aws/bedrock-agentcore/runtimes/harness_{stack}_agent-"
    groups = logs.describe_log_groups(logGroupNamePrefix=prefix)["logGroups"]
    return groups[0]["logGroupName"]


def instances(start_ms, end_ms):
    """每个会话实例：第一次模型调用的时间、调用次数和各类 token 合计"""
    acc = collections.defaultdict(lambda: {"first": None, "calls": 0, **{k: 0 for k in KEYS}})
    kw = dict(logGroupName=runtime_log_group(), startTime=start_ms, endTime=end_ms, filterPattern=f'"{KEYS["cache_read"]}"')
    for page in logs.get_paginator("filter_log_events").paginate(**kw):
        for e in page["events"]:
            m = json.loads(e["message"])
            a = acc[m["otel.resource.service.instance.id"]]
            a["first"] = min(a["first"] or e["timestamp"], e["timestamp"])
            a["calls"] += m.get(KEYS["input"], {}).get("Count", 0)
            for k, name in KEYS.items():
                v = m.get(name)
                a[k] += v.get("Sum", 0) if isinstance(v, dict) else 0
    return acc


def hook_usage(start_ms, end_ms):
    """finish Lambda 日志里每个会话各轮用量的合计：{会话号: (输入, 输出)}"""
    stack = os.environ.get("STACK", "Slate")
    acc, seen = collections.defaultdict(lambda: [0, 0]), set()
    kw = dict(logGroupName=f"/aws/lambda/{stack}-finish", startTime=start_ms, endTime=end_ms, filterPattern='"after_invocation"')
    for page in logs.get_paginator("filter_log_events").paginate(**kw):
        for e in page["events"]:
            try:
                m = json.loads(e["message"])
            except ValueError:
                continue
            if m.get("hookEventId") in seen:  # 同一个事件可能记多次，只算一次
                continue
            seen.add(m.get("hookEventId"))
            u = (m.get("context") or {}).get("usage") or {}
            acc[m.get("sessionId")][0] += u.get("inputTokens", 0)
            acc[m.get("sessionId")][1] += u.get("outputTokens", 0)
    return {k: tuple(v) for k, v in acc.items()}


def main():
    ts = sorted(tasks(sys.argv[1:]), key=lambda t: int(t["createdAt"]))
    if not ts:
        print("没有找到任务"); return
    pad = 60_000
    start, end = int(ts[0]["createdAt"]) - pad, int(max(int(t["updatedAt"]) for t in ts)) + pad
    acc = instances(start, end)
    hooks = hook_usage(start, end + 30 * 60_000)
    for t in ts:
        a0, a1 = int(t["createdAt"]) - pad, int(t["updatedAt"]) + pad
        # 长片除了主会话，每章还有一个会话（slate-task-<任务号>-c<章号>），各自对上一个实例
        wants = [v for k, v in hooks.items() if k == f"slate-task-{t['id']}" or k.startswith(f"slate-task-{t['id']}-c")]
        mine = [a for a in acc.values() if (a["input"], a["output"]) in wants]
        if not mine:
            mine = [a for a in acc.values() if a0 <= a["first"] <= a1]
        tot = {k: sum(a[k] for a in mine) for k in (*KEYS, "calls")}
        for a in mine:
            # 走 Bedrock API Key（Harness 的 LiteLLM 配置）时，输入按 OpenAI 的口径报，已经包含缓存读写的部分；
            # IAM 角色（Converse）报的只是没命中缓存的部分，远小于缓存读写之和。这里统一成后一种口径
            if a["input"] >= a["cache_read"] + a["cache_write"] > 0:
                tot["input"] -= a["cache_read"] + a["cache_write"]
        paid = sum(tot[k] * PRICE[k] for k in KEYS)
        plain = (tot["input"] + tot["cache_read"] + tot["cache_write"]) * PRICE["input"] + tot["output"] * PRICE["output"]
        hit = tot["cache_read"] / max(1, tot["input"] + tot["cache_read"] + tot["cache_write"])
        print(f"{t['id'][:8]}  {t.get('title', '')[:20]:<20}  模型调用 {tot['calls']:>3} 次  "
              f"输入 {tot['input']:>7,}  缓存读 {tot['cache_read']:>9,}  缓存写 {tot['cache_write']:>8,}  输出 {tot['output']:>7,}  "
              f"命中率 {hit:.0%}  实付 ${paid:.2f}（不开缓存 ${plain:.2f}）")


if __name__ == "__main__":
    main()
