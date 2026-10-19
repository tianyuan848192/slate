"""按任务拆解时间：每个会话（长片的主会话和各章）按步骤分成"模型思考"和各类命令的耗时，渲染再细到每一镜。

数据来源：Harness 运行日志组（不另开日志）
- 模型每次输出一条 gen_ai.choice（输出结束的时间、要执行的工具和命令）；
- 每次工具调用一条 strands.tool.duration 指标（精确耗时）；
- slate-render 的返回结果里有每一镜的帧数、分段数、渲染用时和每帧耗时；
- 每轮开始的 "Returning streaming response"（实例号 → 会话号）。
"模型思考" = 这次输出结束的时间 − 上一次工具执行完的时间（含排队和网络）。

用法：python scripts/task_timing.py <任务 ID 前缀> [--json 输出文件]
"""
import argparse, collections, json, os, re, sys, time

import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
STACK = os.environ.get("STACK", "Slate")
OUT = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{STACK}.json")))[STACK]
os.environ.setdefault("TABLE", OUT["TableName"])

from lib import chapters as chs  # noqa: E402
from lib import common as c  # noqa: E402

logs = boto3.client("logs", region_name="us-east-1")
HARNESS = f"{STACK}_agent"
STEPS = ("analyze", "research", "script", "storyboard", "code", "render", "compose")
# 命令归类，按先后匹配：一条命令里有渲染就算渲染
KINDS = [("render", r"slate-render"), ("qa", r"slate-qa"), ("look", r"slate-look"), ("voice", r"slate-voice"),
         ("compose", r"slate-compose"), ("browse", r"slate-browse"),
         ("write", r"cat\s*>|tee\s|>\s*\S+\.(html|js|json|css|mjs)|open\([^)]*['\"]w|write_text|^create$|^str_replace$|^insert$"),
         ("read", r"\b(cat|sed|head|tail|grep|ls|find|wc)\b|^view$")]


def kind_of(cmd):
    for k, pat in KINDS:
        if re.search(pat, cmd or "", re.M):
            return k
    return "other"


def events(group, pattern, start, end):
    kw, tok = dict(logGroupName=group, startTime=start, endTime=end, filterPattern=pattern, limit=10000), None
    while True:
        if tok:
            kw["nextToken"] = tok
        r = logs.filter_log_events(**kw)
        yield from r["events"]
        tok = r.get("nextToken")
        if not tok:
            return


def groups():
    r = logs.describe_log_groups(logGroupNamePrefix=f"/aws/bedrock-agentcore/runtimes/harness_{HARNESS}-")
    return [g["logGroupName"] for g in r["logGroups"]]


def find_task(prefix):
    from boto3.dynamodb.conditions import Attr
    t, kw = c.table(), dict(FilterExpression=Attr("sk").eq("META") & Attr("pk").begins_with(f"TASK#{prefix}"))
    while True:
        r = t.scan(**kw)
        if r["Items"]:
            return c.plain(r["Items"][0])
        if "LastEvaluatedKey" not in r:
            sys.exit(f"找不到任务 {prefix}")
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def collect(task):
    tid = task["id"]
    chapters = chs.all_of(tid) if c.is_long(task) else []
    sessions = {c.session_id(tid): "主会话", **{c.session_id(tid, x["id"]): f"第 {x['id']} 章" for x in chapters}}
    start = int(task["createdAt"]) - 60_000
    end = min(int(time.time() * 1000), max([int(task.get("updatedAt") or 0)] + [int(x.get("updatedAt") or 0) for x in chapters]) + 600_000)
    inst, turns = {}, collections.defaultdict(list)
    choices, durs, renders = collections.defaultdict(list), {}, {}
    for g in groups():
        for e in events(g, '"Returning streaming response"', start, end):
            d = json.loads(e["message"])
            sid = (d.get("attributes") or {}).get("sessionId")
            if sid in sessions:
                inst[d["resource"]["attributes"]["service.instance.id"]] = sid
                turns[sid].append(e["timestamp"])
        for e in events(g, '"gen_ai.choice"', start, end):
            d = json.loads(e["message"])
            i = d["resource"]["attributes"]["service.instance.id"]
            if i not in inst:
                continue
            msg = (d.get("body") or {}).get("message") or {}
            calls = [(t["id"], t["function"]["name"], json.dumps(t["function"]["arguments"], ensure_ascii=False) if t["function"]["name"] != "shell"
                      else t["function"]["arguments"].get("command", "")) for t in msg.get("tool_calls") or []]
            choices[inst[i]].append({"at": e["timestamp"], "finish": d["body"].get("finish_reason"), "calls": calls})
        for e in events(g, '"strands.tool.duration"', start, end):
            d = json.loads(e["message"])
            if d.get("otel.resource.service.instance.id") in inst and d.get("tool_use_id"):
                durs[d["tool_use_id"]] = float(d["strands.tool.duration"]["Sum"])
        for e in events(g, '"render_s"', start, end):  # slate-render 的返回结果（会在之后的每次请求里重复出现，按工具调用去重）
            d = json.loads(e["message"])
            if d["resource"]["attributes"]["service.instance.id"] not in inst:
                continue
            for part in (d.get("body") or {}).get("content") or []:
                tr = part.get("toolResult") if isinstance(part, dict) else None
                if not tr or tr.get("toolUseId") in renders:
                    continue
                text = "".join(x.get("text", "") for x in tr.get("content") or [] if isinstance(x, dict))
                try:
                    text = json.loads(text).get("stdout", text)
                except (ValueError, AttributeError):
                    pass
                rows = []
                for line in str(text).splitlines():
                    m = re.search(r"\{.*\"render_s\".*\}|\{.*\"reused\": true.*\}", line)
                    if m:
                        try:
                            rows.append(json.loads(m.group(0)))
                        except ValueError:
                            pass
                if rows:
                    renders[tr["toolUseId"]] = rows
    return sessions, turns, choices, durs, renders


def analyze(task):
    sessions, turns, choices, durs, renders = collect(task)
    report = {"task": task["id"], "title": task.get("title"), "sessions": []}
    for sid, label in sessions.items():
        cs = sorted(choices.get(sid, []), key=lambda x: x["at"])
        if not cs:
            continue
        starts = sorted(turns.get(sid, []))
        step, prev_end = "analyze" if label == "主会话" else "storyboard", None
        by_step = collections.defaultdict(lambda: collections.Counter())
        counts = collections.defaultdict(lambda: collections.Counter())
        scenes, timeline = [], []
        for ch in cs:
            # 一轮开始（用户确认、修改）之后的第一次输出，从这一轮开始时算
            base = prev_end
            later = [s for s in starts if (prev_end is None or s > prev_end) and s <= ch["at"]]
            if later:
                base = later[-1]
            think = max(0.0, (ch["at"] - base) / 1000) if base else 0.0
            for tid_, name, cmd in ch["calls"]:
                for m in re.finditer(r"slate-event step (\w+) start", cmd):  # 一条命令里常常是"上一步 done && 下一步 start"
                    if m.group(1) in STEPS:
                        step = m.group(1)
            by_step[step]["模型"] += think
            t_end = ch["at"]
            for tid_, name, cmd in ch["calls"]:
                d = durs.get(tid_, 0.0)
                k = kind_of(cmd)
                by_step[step][k] += d
                counts[step][k] += 1
                t_end += d * 1000
                timeline.append({"at": ch["at"], "step": step, "kind": k, "s": round(d, 1), "think": round(think, 1), "cmd": cmd[:100],
                                 "render_s": round(sum(r.get("render_s") or 0 for r in renders.get(tid_, [])), 1), "qa": "slate-qa" in cmd})
                if tid_ in renders:
                    for r in renders[tid_]:
                        scenes.append({**{k2: r.get(k2) for k2 in ("scene", "frames", "shards", "render_s", "frame_s", "reused", "duration")}, "step": step})
            counts[step]["模型"] += 1
            prev_end = t_end
        wall = (prev_end - (starts[0] if starts else cs[0]["at"])) / 1000
        report["sessions"].append({"session": label, "turns": len(starts), "wall_s": round(wall), "steps": {k: dict(v) for k, v in by_step.items()},
                                   "counts": {k: dict(v) for k, v in counts.items()}, "scenes": scenes, "timeline": timeline,
                                   "first": starts[0] if starts else cs[0]["at"], "last": prev_end})
    return report


def fmt(s):
    return f"{s / 60:5.1f}m" if s >= 60 else f"{s:5.0f}s"


def show(rep):
    print(f"\n任务 {rep['task'][:8]}  {rep['title']}")
    t0 = min(x["first"] for x in rep["sessions"])
    for s in rep["sessions"]:
        tot = collections.Counter()
        for v in s["steps"].values():
            tot.update(v)
        busy = sum(tot.values())
        print(f"\n== {s['session']}：从第 {(s['first'] - t0) / 60000:.1f} 分钟开始，到第 {(s['last'] - t0) / 60000:.1f} 分钟结束（{s['turns']} 轮），忙碌 {fmt(busy)}")
        cols = ["模型", "write", "read", "voice", "render", "qa", "look", "compose", "browse", "other"]  # render 含同一条命令里的 qa
        print("   步骤        " + "".join(f"{x:>9}" for x in cols))
        for st in STEPS:
            if st in s["steps"]:
                v = s["steps"][st]
                print(f"   {st:<11} " + "".join(f"{fmt(v.get(x, 0)):>9}" for x in cols))
        print("   合计        " + "".join(f"{fmt(tot.get(x, 0)):>9}" for x in cols))
        n = collections.Counter()
        for v in s["counts"].values():
            n.update(v)
        print("   次数        " + "".join(f"{n.get(x, 0):>9}" for x in cols))
        rs = [x for x in s["scenes"] if not x.get("reused")]
        if rs:
            tr = sum(x["render_s"] or 0 for x in rs)
            print(f"   渲染了 {len(rs)} 次（复用 {sum(1 for x in s['scenes'] if x.get('reused'))} 次）：合计 {fmt(tr)}，"
                  f"每次 {min(x['render_s'] for x in rs):.0f}～{max(x['render_s'] for x in rs):.0f} 秒；"
                  f"每帧 {min(x['frame_s'] or 0 for x in rs):.2f}～{max(x['frame_s'] or 0 for x in rs):.2f} 秒；分段 {sorted({x['shards'] for x in rs})}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    reps = [analyze(find_task(p)) for p in a.tasks]
    for r in reps:
        show(r)
    if a.json:
        json.dump(reps, open(a.json, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
