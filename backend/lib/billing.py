"""Credit 计费：价格表、按次记账、各级合计和月额度。设计见 docs/credit-design.md。

计费的有四样：
- 主 Agent 的模型 token：来自 Harness 自己写在运行日志组里的用量指标（每个会话实例每分钟一条，token 合计是精确值，不带提示词文本），
  由 meter Lambda 每分钟入账。每轮开始时运行日志里有一条同时带会话号和实例号的记录，用它把实例对应到任务；
- 看图模型的 token：Slate-llm 每次调用直接记；
- 配音字数：Slate-voice 每次合成直接记（按 MiniMax 返回的计费字数）；
- 渲染：渲染机（AgentCore Runtime 的 GPU 实例）每次渲染、自检的忙碌秒数 × 机型单价（EC2 按需价 + AgentCore 管理费），
  渲染机做完往任务的 events/ 写一条用量，events Lambda 记账。开机和空闲收尾不算在用户头上，由比例覆盖。
会话容器、浏览器、Lambda 等基础服务不单独计费，比例里多出的部分覆盖它们。

一条明细（pk=TASK#<任务>，sk=CALL#<毫秒>#<幂等键>）：主 Agent 是"一个实例一分钟"，看图和配音是一次调用。条件写入保证同一个幂等键只记一次；
写成功后原子累加：任务合计、按轮次的小计（BILLTURN#）、用户月合计和日合计（USAGE#<用户>）、全平台日合计（USAGEDAY#<日期>）。
不计费的调用（平台原因的重做）照常记明细，但不进合计，用户能看到这笔被免掉了。
"""
import re, time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from . import common as c

CN = timezone(timedelta(hours=8))  # 按北京时间分日、分月
KEY = {"pk": "CONFIG#billing", "sk": "META"}
OPUS = {"input": 4, "cacheRead": 0.2, "cacheWrite": 5, "output": 20}
PEGASUS = "us.twelvelabs.pegasus-1-5-v1:0"
DEFAULTS = {
    "version": 1, "ratio": 1.3, "defaultMonthly": 1000,
    # 美元 / 百万 token。Opus 4.8 和 GPT-6 Astra 只在被安全策略误拦时备用，先按 Opus 5.5 的价格记，管理端可改
    "models": {
        "global.anthropic.claude-opus-5-5": {"name": "Claude Opus 5.5", **OPUS},
        "global.anthropic.claude-opus-4-8": {"name": "Claude Opus 4.8", **OPUS},
        "global.openai.gpt-6-astra": {"name": "GPT-6 Astra", **OPUS},
        "global.anthropic.claude-sonnet-5-5": {"name": "Claude Sonnet 5.5", "input": 2, "cacheRead": 0.2, "cacheWrite": 2.5, "output": 10},
        # 看视频（风格创建听旁白）：按输入视频的秒数和输出 token 计价，没有输入 token 和缓存的单价
        PEGASUS: {"name": "TwelveLabs Pegasus 1.5", "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 7.5, "videoSecond": 0.00049},
    },
    "voice": {"per10kChars": 3.5, "currency": "CNY"},  # MiniMax speech-2.8-hd：人民币 / 万字符（按 MiniMax 返回的计费字数）
    # 渲染机：美元 / 小时 = EC2 按需价 × (1 + 7.8% AgentCore 管理费，G 系列)
    "render": {
        "g4dn.xlarge": {"name": "T4 · g4dn.xlarge", "perHour": round(0.526 * 1.078, 4)},
        "g5.xlarge": {"name": "A10G · g5.xlarge", "perHour": round(1.006 * 1.078, 4)},
    },
    "fx": {"CNY": 7.2},  # 1 美元兑多少人民币
}
_cache = [0.0, None]


def month_of(ms):
    return datetime.fromtimestamp(ms / 1000, CN).strftime("%Y-%m")


def day_of(ms):
    return datetime.fromtimestamp(ms / 1000, CN).strftime("%Y-%m-%d")


def config(fresh=False):
    if not fresh and _cache[1] is not None and time.time() - _cache[0] < 60:
        return _cache[1]
    item = c.plain(c.table().get_item(Key=KEY).get("Item") or {})
    cfg = {**DEFAULTS, **{k: item[k] for k in DEFAULTS if k in item}}
    cfg["models"] = {**DEFAULTS["models"], **(item.get("models") or {})}
    cfg["render"] = {**DEFAULTS["render"], **(item.get("render") or {})}
    for k in ("updatedAt", "updatedBy"):
        cfg[k] = item.get(k)
    _cache[:] = [time.time(), cfg]
    return cfg


def save_config(cfg, who):
    old = config(fresh=True)
    item = {**KEY, **{k: cfg[k] for k in DEFAULTS if k in cfg}, "version": int(old.get("version") or 1) + 1,
            "updatedAt": c.now_ms(), "updatedBy": who}
    c.table().put_item(Item=c.ddb_safe(item))
    _cache[:] = [0.0, None]
    return config(fresh=True)


def price_of(model, cfg=None):
    """模型的单价；没登记的模型按表里最贵的价格记（宁可多记，管理员看到后补上价格再调整）"""
    cfg = cfg or config()
    p = cfg["models"].get(model)
    if p:
        return p, True
    return max(cfg["models"].values(), key=lambda x: x.get("output", 0)), False


def model_cost(model, tokens, cfg=None):
    """tokens = {input, cacheRead, cacheWrite, output} → 美元"""
    p, _ = price_of(model, cfg)
    return sum(float(tokens.get(k) or 0) * float(p.get(k) or 0) for k in ("input", "cacheRead", "cacheWrite", "output")) / 1e6


def video_cost(model, usage, cfg=None):
    """看视频的模型：输入视频秒数 × 每秒单价 + 输出 token（美元 / 百万 token）"""
    p, _ = price_of(model, cfg)
    return model_cost(model, usage, cfg) + float(usage.get("seconds") or 0) * float(p.get("videoSecond") or 0)


def voice_cost(chars, cfg=None):
    cfg = cfg or config()
    v = cfg["voice"]
    rate = float(cfg["fx"].get(v.get("currency", "CNY"), 7.2)) if v.get("currency", "CNY") != "USD" else 1.0
    return float(chars or 0) / 10000 * float(v["per10kChars"]) / rate


def render_cost(instance, seconds, cfg=None):
    """渲染机忙碌秒数 → 美元；没登记的机型按表里最贵的算"""
    table = (cfg or config())["render"]
    p = table.get(instance) or max(table.values(), key=lambda x: x.get("perHour", 0))
    return float(seconds or 0) / 3600 * float(p.get("perHour") or 0)


def credits_of(usd, cfg=None):
    return round(usd * float((cfg or config())["ratio"]), 6)


# ---------------------------------------------------------------- 记账

def record(task, at_ms, idem, kind, turn, usage, model=None, billable=True, note=""):
    """记一条明细并累加合计；同一个 idem（请求号）只记一次。返回这条的 Credit，重复时返回 None。
    task：任务记录（要 id、sub、email）；turn：{turnId, label, chapter}；usage：token 或 {chars}"""
    cfg = config()
    if kind == "voice":
        usd = voice_cost(usage.get("chars"), cfg)
    elif kind == "render":
        usd = render_cost(model, usage.get("seconds"), cfg)
    elif kind == "video":
        usd = video_cost(model, usage, cfg)
    else:
        usd = model_cost(model, usage, cfg)
    cr = credits_of(usd, cfg)
    tid, sub = task["id"], task["sub"]
    item = {"pk": f"TASK#{tid}", "sk": f"CALL#{int(at_ms):015d}#{str(idem)[:64]}", "at": int(at_ms), "kind": kind, "model": model,
            "turnId": turn.get("turnId"), "label": turn.get("label"), "chapter": turn.get("chapter"),
            **{k: int(usage[k]) for k in ("input", "cacheRead", "cacheWrite", "output", "chars") if usage.get(k) is not None},
            **({"seconds": round(float(usage["seconds"]), 2)} if usage.get("seconds") is not None else {}),
            "costUsd": round(usd, 8), "credits": cr, "billable": bool(billable), "note": note, "priceVersion": cfg["version"],
            "ttl": None}
    item = {k: v for k, v in item.items() if v is not None}
    try:
        c.table().put_item(Item=c.ddb_safe(item), ConditionExpression="attribute_not_exists(pk)")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise
    if billable and cr > 0:
        add_totals(task, at_ms, cr, usd, turn)
    return cr


def add_totals(task, at_ms, cr, usd, turn):
    tid, sub, m, d = task["id"], task["sub"], month_of(at_ms), day_of(at_ms)
    dc, du = Decimal(str(round(cr, 6))), Decimal(str(round(usd, 8)))
    t = c.table()
    t.update_item(Key={"pk": f"TASK#{tid}", "sk": "META"}, UpdateExpression="ADD credits :c, costUsd :u",
                  ExpressionAttributeValues={":c": dc, ":u": du})
    if turn.get("turnId"):
        t.update_item(Key={"pk": f"TASK#{tid}", "sk": f"BILLTURN#{turn['turnId']}"},
                      UpdateExpression="ADD credits :c, calls :one SET #l = if_not_exists(#l, :l), #ch = if_not_exists(#ch, :ch), #a = if_not_exists(#a, :a)",
                      ExpressionAttributeNames={"#l": "label", "#ch": "chapter", "#a": "at"},
                      ExpressionAttributeValues={":c": dc, ":one": 1, ":l": turn.get("label") or "", ":ch": turn.get("chapter") or "", ":a": int(at_ms)})
    for k in (f"M#{m}", f"D#{d}"):
        t.update_item(Key={"pk": f"USAGE#{sub}", "sk": k}, UpdateExpression="ADD credits :c, costUsd :u",
                      ExpressionAttributeValues={":c": dc, ":u": du})
    t.update_item(Key={"pk": f"USAGEDAY#{d}", "sk": f"USER#{sub}"}, UpdateExpression="ADD credits :c, costUsd :u SET email = :e",
                  ExpressionAttributeValues={":c": dc, ":u": du, ":e": task.get("email") or ""})


def adjust(task, credits, reason, who):
    """管理员调整：负数是退还，正数是补扣。记一条明细，进合计"""
    now = c.now_ms()
    cr = round(float(credits), 2)
    item = {"pk": f"TASK#{task['id']}", "sk": f"CALL#{now:015d}#adj-{c.new_id()[:8]}", "at": now, "kind": "adjust",
            "credits": cr, "costUsd": 0, "billable": True, "note": f"{who}：{reason}"[:300], "label": "管理员调整"}
    c.table().put_item(Item=c.ddb_safe(item))
    usd = cr / float(config()["ratio"] or 1)
    add_totals(task, now, cr, usd, {})
    return item


# ---------------------------------------------------------------- 会话 → 任务和轮次

def open_span(session_id, task, turn, chapter=None, label="", free=False, model=None):
    """每轮开始时记一段：[开始毫秒, 轮次, 章, 是否免费, 标签, 模型]。meter 按用量的时间找所在的那一段，决定算在哪一轮、按哪个模型定价"""
    span = [c.now_ms(), turn["id"], chapter or "", bool(free), label, model or ""]
    c.table().update_item(
        Key={"pk": f"BILLSESSION#{session_id}", "sk": "META"},
        UpdateExpression="SET taskId = :t, #s = :s, email = :e, spans = list_append(if_not_exists(spans, :empty), :span), #ttl = :ttl",
        ExpressionAttributeNames={"#s": "sub", "#ttl": "ttl"},
        ExpressionAttributeValues={":t": task["id"], ":s": task["sub"], ":e": task.get("email") or "", ":span": [span], ":empty": [],
                                   ":ttl": int(time.time()) + 30 * 86400})


def map_instance(instance_id, session_id):
    """运行日志里每轮开始的那条记录：实例号 → 会话号。
    会话也能往运行日志里写，所以 8 小时内（会话最长活这么久）不许把一个实例改记到别的会话上：
    真实的记录在会话第一次调用开始时就写下了，那时会话里的代码还没机会运行"""
    from botocore.exceptions import ClientError
    now = int(time.time())
    try:
        c.table().put_item(Item={"pk": f"BILLINST#{instance_id}", "sk": "META", "sessionId": session_id, "mappedAt": now, "ttl": now + 30 * 86400},
                           ConditionExpression="attribute_not_exists(pk) OR sessionId = :s OR attribute_not_exists(mappedAt) OR mappedAt < :old",
                           ExpressionAttributeValues={":s": session_id, ":old": now - 8 * 3600})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        print("instance already mapped to another session, ignore", instance_id[:12], session_id[:40])


def find_session(session_id, at_ms, cache=None):
    """返回 (任务记录的 id/sub/email, 轮次信息) 或 None"""
    cache = cache if cache is not None else {}
    if session_id not in cache:
        cache[session_id] = c.plain(c.table().get_item(Key={"pk": f"BILLSESSION#{session_id}", "sk": "META"}).get("Item") or {}) or None
    it = cache[session_id]
    if not it or not it.get("spans"):
        return None
    spans = [x for x in it["spans"] if x[0] <= at_ms] or it["spans"][:1]
    x = spans[-1]
    task = {"id": it["taskId"], "sub": it["sub"], "email": it.get("email", "")}
    return task, {"turnId": x[1], "chapter": x[2] or None, "free": bool(x[3]), "label": x[4], "model": x[5] if len(x) > 5 else ""}


def session_of_instance(instance_id, cache=None):
    cache = cache if cache is not None else {}
    if instance_id not in cache:
        it = c.table().get_item(Key={"pk": f"BILLINST#{instance_id}", "sk": "META"}).get("Item") or {}
        cache[instance_id] = it.get("sessionId")
    return cache[instance_id]


def turn_label(turn, chapter=None):
    origin = turn.get("origin") or turn.get("kind")
    base = {"start": "首版", "confirm": "确认分镜后制作", "revise": "修改", "retry": "重试", "continue": "续做"}.get(origin, origin or "")
    if origin == "revise" and turn.get("startedAt"):
        base += " " + datetime.fromtimestamp(turn["startedAt"] / 1000, CN).strftime("%m-%d %H:%M")
    return (f"第 {int(chapter)} 章 · " if chapter else "") + base


# ---------------------------------------------------------------- 额度

def monthly_quota(sub, cfg=None):
    it = c.plain(c.table().get_item(Key={"pk": f"USAGE#{sub}", "sk": "QUOTA"}).get("Item") or {})
    if it.get("monthly") is not None:
        return float(it["monthly"]), True
    return float((cfg or config())["defaultMonthly"]), False


def set_quota(sub, monthly):
    if monthly is None:
        c.table().delete_item(Key={"pk": f"USAGE#{sub}", "sk": "QUOTA"})
    else:
        c.table().put_item(Item=c.ddb_safe({"pk": f"USAGE#{sub}", "sk": "QUOTA", "monthly": float(monthly), "updatedAt": c.now_ms()}))


def month_used(sub, month=None):
    month = month or month_of(c.now_ms())
    it = c.plain(c.table().get_item(Key={"pk": f"USAGE#{sub}", "sk": f"M#{month}"}).get("Item") or {})
    return float(it.get("credits") or 0)


def many(subs):
    """一批用户的本月用量和额度：{sub: {used, quota, custom}}（管理端用户列表用，一次批量读）"""
    month, cfg = month_of(c.now_ms()), config()
    keys = [{"pk": f"USAGE#{s}", "sk": k} for s in subs for k in (f"M#{month}", "QUOTA")]
    got = {}
    for i in range(0, len(keys), 100):
        req = {c.TABLE: {"Keys": keys[i:i + 100]}}
        while req:
            r = c._ddb.batch_get_item(RequestItems=req)
            for it in r["Responses"].get(c.TABLE, []):
                it = c.plain(it)
                got[(it["pk"][6:], it["sk"])] = it
            req = r.get("UnprocessedKeys") or None
    out = {}
    for s in subs:
        q = got.get((s, "QUOTA"))
        out[s] = {"used": round(float((got.get((s, f"M#{month}")) or {}).get("credits") or 0), 2),
                  "quota": float(q["monthly"]) if q and q.get("monthly") is not None else float(cfg["defaultMonthly"]), "custom": bool(q)}
    return out


def months_of(sub, months):
    r = c.table().query(KeyConditionExpression=Key("pk").eq(f"USAGE#{sub}") & Key("sk").between(f"M#{months[0]}", f"M#{months[-1]}"))
    return {x["sk"][2:]: round(float(x.get("credits") or 0), 2) for x in (c.plain(i) for i in r.get("Items", []))}


def summary(sub):
    month = month_of(c.now_ms())
    used = round(month_used(sub, month), 2)
    quota, custom = monthly_quota(sub)
    share = used / quota if quota else 1
    return {"month": month, "used": used, "quota": quota, "remaining": round(max(0.0, quota - used), 2),
            "warn": "100" if share >= 1 else "80" if share >= 0.8 else None, "custom": custom}


def check_quota(sub):
    s = summary(sub)
    if s["used"] >= s["quota"]:
        raise c.ApiError(402, "quota_exceeded", "本月额度已用完，下月 1 日恢复")
    return s


# ---------------------------------------------------------------- 查询

def calls_of(task_id):
    out, kw = [], dict(KeyConditionExpression=Key("pk").eq(f"TASK#{task_id}") & Key("sk").begins_with("CALL#"))
    while True:
        r = c.table().query(**kw)
        out += [c.plain(i) for i in r.get("Items", [])]
        if "LastEvaluatedKey" not in r:
            return out
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def turns_of(task_id):
    r = c.table().query(KeyConditionExpression=Key("pk").eq(f"TASK#{task_id}") & Key("sk").begins_with("BILLTURN#"))
    rows = [c.plain(i) for i in r.get("Items", [])]
    return sorted(({"turnId": x["sk"].split("#", 1)[1], "label": x.get("label") or "", "credits": round(float(x.get("credits") or 0), 2),
                    "calls": int(x.get("calls") or 0), "at": x.get("at")} for x in rows), key=lambda x: (x["at"] or 0, x["label"]))


def days_of(sub, d0, d1):
    r = c.table().query(KeyConditionExpression=Key("pk").eq(f"USAGE#{sub}") & Key("sk").between(f"D#{d0}", f"D#{d1}"))
    return {x["sk"][2:]: round(float(x.get("credits") or 0), 2) for x in (c.plain(i) for i in r.get("Items", []))}


def all_users_days(d0, d1):
    """全平台按天：每天一个分区，逐天查（日期范围一般是一个月以内）"""
    days, users = {}, {}
    d = datetime.strptime(d0, "%Y-%m-%d")
    end = datetime.strptime(d1, "%Y-%m-%d")
    while d <= end:
        key = d.strftime("%Y-%m-%d")
        r = c.table().query(KeyConditionExpression=Key("pk").eq(f"USAGEDAY#{key}"))
        total = 0.0
        for x in (c.plain(i) for i in r.get("Items", [])):
            sub = x["sk"].split("#", 1)[1]
            v = float(x.get("credits") or 0)
            total += v
            u = users.setdefault(sub, {"sub": sub, "email": x.get("email") or "", "credits": 0.0})
            u["credits"] += v
        days[key] = round(total, 2)
        d += timedelta(days=1)
    return days, sorted(({**u, "credits": round(u["credits"], 2)} for u in users.values()), key=lambda u: -u["credits"])


def date_range(qs):
    """查询参数里的 from/to，默认本月；最长 366 天"""
    today = datetime.now(CN)
    d0 = str(qs.get("from") or today.strftime("%Y-%m-01"))
    d1 = str(qs.get("to") or today.strftime("%Y-%m-%d"))
    for d in (d0, d1):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            raise c.ApiError(400, "bad_date", "日期格式是 YYYY-MM-DD")
    if d0 > d1:
        d0, d1 = d1, d0
    if (datetime.strptime(d1, "%Y-%m-%d") - datetime.strptime(d0, "%Y-%m-%d")).days > 366:
        raise c.ApiError(400, "bad_range", "日期范围最长一年")
    return d0, d1


def day_start_ms(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=CN).timestamp() * 1000)


def day_list(d0, d1, values):
    out, d, end = [], datetime.strptime(d0, "%Y-%m-%d"), datetime.strptime(d1, "%Y-%m-%d")
    while d <= end:
        k = d.strftime("%Y-%m-%d")
        out.append({"date": k, "credits": values.get(k, 0)})
        d += timedelta(days=1)
    return out


CSV_HEAD = ["时间", "轮次", "类型", "模型或机型", "输入", "缓存读", "缓存写", "输出", "字数", "渲染秒数", "Credit", "计费", "说明"]
KIND = {"model": "主 Agent", "vision": "看图", "video": "看视频", "voice": "配音", "render": "渲染", "adjust": "调整"}


def usage_rows(task_id):
    rows = []
    for x in sorted(calls_of(task_id), key=lambda r: r["sk"]):
        rows.append({"at": x.get("at"), "turnId": x.get("turnId"), "label": x.get("label") or "", "kind": x.get("kind"), "model": x.get("model"),
                     "input": x.get("input"), "cacheRead": x.get("cacheRead"), "cacheWrite": x.get("cacheWrite"), "output": x.get("output"),
                     "chars": x.get("chars"), "seconds": x.get("seconds"), "credits": round(float(x.get("credits") or 0), 4), "billable": bool(x.get("billable", True)),
                     "note": x.get("note") or ""})
    total = round(sum(r["credits"] for r in rows if r["billable"]), 2)
    return rows, total


def usage_csv(task_id):
    import csv, io
    rows, total = usage_rows(task_id)
    cfg = config()
    names = {**{k: v.get("name", k) for k, v in cfg["models"].items()}, **{k: v.get("name", k) for k, v in cfg["render"].items()}}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_HEAD)
    for r in rows:
        w.writerow([datetime.fromtimestamp((r["at"] or 0) / 1000, CN).strftime("%Y-%m-%d %H:%M:%S"), r["label"], KIND.get(r["kind"], r["kind"]),
                    names.get(r["model"], r["model"] or ""), r["input"] or "", r["cacheRead"] or "", r["cacheWrite"] or "", r["output"] or "",
                    r["chars"] or "", r["seconds"] or "", f"{r['credits']:.4f}", "是" if r["billable"] else "否", r["note"]])
    w.writerow(["合计", "", "", "", "", "", "", "", "", "", f"{total:.2f}", "", ""])
    return "﻿" + buf.getvalue()  # 带 BOM，Excel 打开中文不乱码
