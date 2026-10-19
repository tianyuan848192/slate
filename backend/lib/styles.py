"""生成的 Skill（docs/style-creator-design.md 第十一节、docs/skills-two-dimensions.md）：存放、可见范围、复制进任务。

- 两类：画风（kind=visual，id 形如 film-xxx）和写作方法（kind=writing，id 形如 write-xxx）。一段参考视频可以同时生成这两类，
  各是一条记录、各自审核发布。老记录没有 kind 的都是画风。
- 归属（owner）：现在都是 platform（管理员生成、发布给所有人）。以后开放给普通用户时是 user:<sub>，只有本人看得到。
- 记录：任务表 pk=STYLES、sk=<id>，一个 Skill 一条（版本摘要也在这一条里）。画风和写作方法互相独立，不记适用的另一类。
- 文件：数据桶 styles/<id>/source/（参考视频）、styles/<id>/v<n>/skill/（Skill 本身）、styles/<id>/v<n>/review/（验证材料）。
  建任务时画风复制进任务的 input/styles/<id>/，写作方法复制进 input/writing/<id>/。
- 可见范围：公开发布以前只有管理员看得到、用得了。用户端的风格库只返回已公开的；调用者在 admin 组里时再加上内测中的。
- 生成任务（product=style）不进任何人的任务列表和素材库（gsi1pk=STYLEGEN），用户端接口碰到一律 404。
"""
import json, re

from boto3.dynamodb.conditions import Key

from . import common as c

PK = "STYLES"
GSI = "STYLEGEN"
SLUG_RE = r"[a-z][a-z0-9-]{2,30}"
MAX_VERSIONS = 10
KINDS = ("visual", "writing")
PREFIX = {"visual": "film-", "writing": "write-"}
TASK_DIR = {"visual": "styles", "writing": "writing"}   # 建任务时复制进任务的 input/<目录>/<id>/
EXPORT_DIR = {"visual": "style", "writing": "writing"}  # 生成任务导出的一版在任务目录的 <目录>/v<n>/
GROUPS = ("讲解", "宣传")                               # 写作方法属于哪一类：决定 Agent 读哪份通用打法


def kind_of(st):
    return (st or {}).get("kind") or "visual"


def owner_of(st):
    return (st or {}).get("owner") or "platform"


def get(sid):
    it = c.table().get_item(Key={"pk": PK, "sk": sid}).get("Item")
    return c.plain(it) if it else None


def all_styles():
    out, kw = [], {"KeyConditionExpression": Key("pk").eq(PK)}
    while True:
        r = c.table().query(**kw)
        out += [c.plain(i) for i in r.get("Items", [])]
        if "LastEvaluatedKey" not in r:
            return out
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def update(sid, **fields):
    names = {f"#{k}": k for k in fields}
    values = {f":{k}": c.ddb_safe(v) for k, v in fields.items()}
    values[":now"] = c.now_ms()
    c.table().update_item(Key={"pk": PK, "sk": sid}, UpdateExpression="SET updatedAt = :now, " + ", ".join(f"#{k} = :{k}" for k in fields),
                          ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def status_of(st, task=None):
    """风格的状态：下架、驳回、公开、内测是管理员的操作；其余看生成任务"""
    if st.get("retired"):
        return "retired"
    if st.get("rejected"):
        return "rejected"
    if st.get("publicV"):
        return "public"
    if st.get("betaV"):
        return "beta"
    tstat = (task or {}).get("status")
    if tstat in ("queued", "running"):
        return "generating"
    if st.get("versions"):
        return "review"
    if tstat == "failed":
        return "failed"
    if tstat == "completed":
        return "failed"  # 生成任务做完了，这一种却没导出（两种一起生成时，另一种可能已经好了）
    return "generating" if st.get("taskId") else "draft"


def base(sid, v):
    return f"styles/{sid}/v{int(v)}"


def version(st, v):
    return next((x for x in st.get("versions") or [] if x["n"] == int(v)), None)


# ---------------------------------------------------------------- 用户端：风格库和建任务

def visible(admin, kind="visual", sub=None):
    """用户端能选的生成 Skill：{id: (记录, 版本号, 是否内测)}。管理员优先用内测版（就是为了测它）。
    平台的 Skill 所有人可见；以后普通用户自己生成的（owner=user:<sub>），只有本人可见"""
    out = {}
    for st in all_styles():
        if st.get("retired") or st.get("rejected") or kind_of(st) != kind:
            continue
        if owner_of(st) != "platform" and owner_of(st) != f"user:{sub}":
            continue
        if admin and st.get("betaV"):
            out[st["sk"]] = (st, int(st["betaV"]), True)
        elif st.get("publicV"):
            out[st["sk"]] = (st, int(st["publicV"]), False)
    return out


def catalog_items(admin):
    """风格库的条目，格式和内置的 catalog.json 一样，另加 thumb、generated、beta"""
    items = []
    for sid, (st, v, beta) in visible(admin).items():
        ver = version(st, v) or {}
        pub = ver.get("public") or public_traits(ver.get("traits") or {})  # 老版本没有 public，现算
        items.append({"id": sid, "name": st["name"], "cat": st.get("cat") or "插画讲解", "ver": str(v),
                      "summary": ver.get("summary") or pub.get("line") or "", "highlights": pub.get("highlights") or [],
                      "ratio": None, "generated": True, "beta": beta,
                      "thumb": c.media_url(ver["thumb"]) if ver.get("thumb") else None})
    return items


def writing_items(admin, sub=None):
    """写作方法目录里的生成条目，格式和内置的 genres.json 一样（id、name、group、summary、example、styles），另加 generated、beta"""
    items, vis = [], visible(admin, "writing", sub)
    looks = visible(admin, "visual", sub) if any(st.get("pair") for st, _, _ in vis.values()) else {}
    for wid, (st, v, beta) in vis.items():
        ver = version(st, v) or {}
        pub = ver.get("public") or public_traits(ver.get("traits") or {})  # 老版本没有 public，现算
        items.append({"id": wid, "name": st["name"], "group": st.get("group") or "讲解", "summary": ver.get("summary") or pub.get("line") or "",
                      "example": pub.get("example") or "", "styles": [st["pair"]] if st.get("pair") in looks else [],  # 同一段参考视频出的画风常搭配
                      "generated": True, "beta": beta})
    return items


def copy_into_task(sub, task_id, ids, vis, kind="visual"):
    """建任务时：选中的生成 Skill 复制进任务的 input/styles/<id>/（画风）或 input/writing/<id>/（写作方法），
    返回 [{id, name, v, beta}]（写作方法另带 group）。vis 是 visible() 的结果，看不到的跳过"""
    pre = c.prefix(sub, task_id)
    refs = []
    for sid in ids:
        if sid not in vis:
            continue
        st, v, beta = vis[sid]
        src = base(sid, v) + "/skill/"
        for page in c.s3.get_paginator("list_objects_v2").paginate(Bucket=c.DATA_BUCKET, Prefix=src):
            for o in page.get("Contents", []):
                c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/input/{TASK_DIR[kind]}/{sid}/{o['Key'][len(src):]}",
                                 CopySource={"Bucket": c.DATA_BUCKET, "Key": o["Key"]})
        refs.append({"id": sid, "name": st["name"], "v": v, "beta": beta, **({"group": st.get("group") or "讲解"} if kind == "writing" else {})})
    return refs


def record_tests(task, refs, user):
    """用内测版建的任务记进这个风格的测试片（公开发布要求这一版至少有一支做完的测试片）"""
    for r in refs:
        if not r["beta"]:
            continue
        entry = {"taskId": task["id"], "sub": user["sub"], "email": user.get("email", ""), "v": r["v"], "at": c.now_ms()}
        c.table().update_item(Key={"pk": PK, "sk": r["id"]}, UpdateExpression="SET tests = list_append(if_not_exists(tests, :e), :t)",
                              ExpressionAttributeValues={":t": [entry], ":e": []})


# ---------------------------------------------------------------- 生成任务

MEDIA_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm")


def public_traits(traits):
    """风格库里给用户看的几样（一句话定位、亮点、示例）：限长，过外发检查，没过的不显示。
    完整的 traits 只给管理端看。生成会话里有平台的风格生成手册，不能让它经这几个字段原样流到用户手里"""
    from . import gate
    out = {}
    for k, v in (("line", str(traits.get("line") or "")[:200]),
                 ("highlights", [str(x)[:60] for x in (traits.get("highlights") or []) if isinstance(x, str)][:4]),
                 ("example", str(traits.get("example") or "")[:300])):
        if any(gate.check(t) for t in (v if isinstance(v, list) else [v]) if t):
            print("style trait blocked by gate:", k)
            continue
        out[k] = v
    return out


def new_version(task, ev, pre, kind="visual"):
    """生成任务发出一版（slate-style export / export-writing）：文件从任务目录复制到 styles/<id>/v<n>/，在记录里加一条版本摘要"""
    sid = (task["request"].get("style" if kind == "visual" else "writing") or {}).get("id")
    st = get(sid) if sid else None
    n = ev.get("n")
    if not st or kind_of(st) != kind or not isinstance(n, int) or not 1 <= n <= MAX_VERSIONS or version(st, n):
        return None
    src = f"{pre}/{EXPORT_DIR[kind]}/v{n}/"
    keys = []
    for page in c.s3.get_paginator("list_objects_v2").paginate(Bucket=c.DATA_BUCKET, Prefix=src):
        keys += [o["Key"] for o in page.get("Contents", [])]
    if not any(k.endswith("/skill/SKILL.md") for k in keys):
        return None
    dst = base(sid, n) + "/"
    for k in keys:
        c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=dst + k[len(src):], CopySource={"Bucket": c.DATA_BUCKET, "Key": k})
    try:
        traits = json.loads(c.s3.get_object(Bucket=c.DATA_BUCKET, Key=dst + "skill/traits.json")["Body"].read())
    except Exception:
        traits = {}
    copied = {dst + k[len(src):] for k in keys}
    # 事件里的路径相对于版本目录，只认这次确实复制过来的图片、视频：不能借它给说明书、引擎签出下载链接
    rel = lambda k: dst + k if isinstance(k, str) and dst + k in copied and k.lower().endswith(MEDIA_EXT) else None  # noqa: E731
    clean = lambda xs, fields: [{f: x.get(f) for f in fields if f in x} for x in xs if isinstance(x, dict)][:12]  # noqa: E731
    segs = clean(ev.get("segments") or [], ("id", "desc", "structure", "motion", "paletteDeltaE", "peakLag", "side", "cmp"))
    for s in segs:
        s["side"], s["cmp"] = rel(s.get("side")), rel(s.get("cmp"))
    demos = clean(ev.get("demos") or [], ("id", "title", "url"))
    for d in demos:
        d["url"] = rel(d.get("url"))
    trials = clean(ev.get("trials") or [], ("label", "url", "scores", "notes", "topic"))
    for t in trials:
        t["url"] = rel(t.get("url"))
    fb = next((f for f in reversed(st.get("feedback") or []) if f.get("forV") == n), None)
    pub = public_traits(traits)
    val = {"n": n, "at": c.now_ms(), "taskId": task["id"], "summary": pub.get("line") or "", "public": pub,
           "checks": clean(ev.get("checks") or [], ("name", "ok", "detail")), "segments": segs, "demos": demos, "trials": trials,
           "traits": traits, "thumb": rel(ev.get("thumb")), "feedback": fb.get("text") if fb else None,
           "files": sorted(k[len(src + "skill/"):] for k in keys if k.startswith(src + "skill/"))[:200],
           # 验证材料里的文字文件（写作方法的原片分镜表、听旁白的结果、试写的剧本等），管理端可以打开看
           "reviewFiles": sorted(k[len(src + "review/"):] for k in keys if k.startswith(src + "review/") and k.endswith((".json", ".md"))
                                 and k[len(src + "review/"):] != "report.md")[:40]}
    c.table().update_item(Key={"pk": PK, "sk": sid}, UpdateExpression="SET versions = list_append(if_not_exists(versions, :e), :v), updatedAt = :now",
                          ExpressionAttributeValues={":v": [c.ddb_safe(val)], ":e": [], ":now": c.now_ms()})
    return val


# ---------------------------------------------------------------- 内容把关

def protect(sid, v):
    """内测发布时：这一版的说明书和示范片说明写进内容把关的语料（styles/protected/<id>-v<n>.json），一句话定位不算。
    下架以后也不删：老任务里还有这个风格的文件"""
    b = base(sid, v) + "/skill/"
    parts = []
    for name in ("SKILL.md", "DEMO.md"):
        try:
            t = c.s3.get_object(Bucket=c.DATA_BUCKET, Key=b + name)["Body"].read().decode("utf-8", "ignore")
        except Exception:
            continue
        parts.append(re.sub(r"^---\n.*?\n---\n", "", t, flags=re.S) if name == "SKILL.md" else t)  # frontmatter 的描述会出现在风格库里
    st = get(sid) or {}
    ver = version(st, v) or {}
    c.s3.put_object(Bucket=c.DATA_BUCKET, Key=f"styles/protected/{sid}-v{int(v)}.json", ContentType="application/json",
                    Body=json.dumps({"id": sid, "v": int(v), "text": "\n".join(parts), "allow": ver.get("summary") or ""}, ensure_ascii=False).encode())

