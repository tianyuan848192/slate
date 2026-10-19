"""管理端的风格创建（docs/style-creator-design.md 第十一节）：上传参考视频 → 生成 → 验证 → 内测发布 → 测试片 → 公开发布。

一段参考视频可以同时产出两种 Skill（docs/skills-two-dimensions.md）：画风（film-<短名>）和写作方法（write-<短名>）。
两种各是一条记录、各自验证、各自发布，共用一个生成任务。

管理端 Lambda 只碰数据桶的 styles/ 前缀（生成任务的产出由 events Lambda 复制过来），看不到用户的成片和素材。
生成任务归在操作的管理员名下（用量记在他的账上），但不进任何人的用户端任务列表。
"""
import os, re

from botocore.exceptions import ClientError

from lib import audit, styles
from lib import common as c
from lib.common import ApiError

VIDEO_EXT = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
MAX_VIDEO = 300 << 20
# 生成中超过这么久没有任何动静（步骤、消息、新版本都没有），会话多半已经被回收了（比如内存撑爆），可以重试
STALE_MS = 20 * 60 * 1000


def _taken(sid):
    """和内置的画风、写作方法、已下架的旧风格、已有的生成 Skill 重名"""
    from lib import gate
    return (sid in {s["id"] for s in c.catalog()} or c.genre_of(sid) is not None or styles.get(sid) is not None
            or any(os.path.isdir(os.path.join(gate.PROTECTED, d, sid)) for d in ("skills", "legacy-skills")))


KIND_NAME = {"visual": "画风", "writing": "写作方法"}


def _must(sid):
    st = styles.get(sid)
    if not st:
        raise ApiError(404, "not_found", "没有这个 Skill")
    return st


def _url(key):
    return c.presign_get(key) if key else None


def _brief(st, task=None):
    return {"id": st["sk"], "kind": styles.kind_of(st), "group": st.get("group"), "pair": st.get("pair"),
            "name": st["name"], "cat": st.get("cat"), "status": styles.status_of(st, task),
            "betaV": st.get("betaV"), "publicV": st.get("publicV"), "latestV": max([v["n"] for v in st.get("versions") or []], default=None),
            "versions": len(st.get("versions") or []), "thumb": _url((st.get("versions") or [{}])[-1].get("thumb")),
            "createdBy": {"email": (st.get("createdBy") or {}).get("email", "")}, "createdAt": st.get("createdAt"), "updatedAt": st.get("updatedAt")}


def list_styles():
    out = []
    for st in sorted(styles.all_styles(), key=lambda s: -(s.get("updatedAt") or 0)):
        out.append(_brief(st, c.get_task(st["taskId"]) if st.get("taskId") else None))
    return out


def _ids(slug, outputs):
    """英文短名 → 这次要建的 {种类: id}：画风 film-<短名>，写作方法 write-<短名>（短名本身带了前缀的去掉）"""
    core = re.sub(r"^(film|write)-", "", slug)
    return {k: styles.PREFIX[k] + core for k in styles.KINDS if k in outputs}


def create(body, me):
    name = str(body.get("name") or "").strip()
    wname = str(body.get("wname") or "").strip() or name
    slug = str(body.get("slug") or "").strip().lower()
    want = body["outputs"] if "outputs" in body else ["visual"]  # 老的管理端不传，只要画风
    outputs = [k for k in styles.KINDS if k in (want or [])]
    group = str(body.get("group") or "讲解")
    if not outputs:
        raise ApiError(400, "bad_outputs", "至少要生成一种：画风或写作方法")
    if not name or len(name) > 20 or len(wname) > 20:
        raise ApiError(400, "bad_name", "名称要填，最多 20 个字")
    if not re.fullmatch(styles.SLUG_RE, slug):
        raise ApiError(400, "bad_slug", "英文短名只能用小写字母、数字和连字符，以字母开头，3 到 31 个字符")
    if "writing" in outputs and group not in styles.GROUPS:
        raise ApiError(400, "bad_group", "写作方法要选属于讲解类还是宣传类")
    if not body.get("rights"):
        raise ApiError(400, "no_rights", "先确认有权使用这段视频")
    ids = _ids(slug, outputs)
    sid = ids.get("visual") or ids["writing"]  # 主记录：带参考视频和上传链接；另一种的记录指向它
    # 自己建的、还没开始生成的草稿（上次上传断了）：用同一个短名再建一次，换一个新的上传链接。
    # 每个 id 单独判断：不能借主 id 是自己的草稿，把别人已有的配对 id 也一起覆盖掉
    redo = set()
    for k, i in ids.items():
        if not _taken(i):
            continue
        st = styles.get(i) or {}
        mine = st and not st.get("taskId") and (st.get("createdBy") or {}).get("sub") == me["sub"]
        if not (mine and (i == sid or st.get("pair") == sid)):
            raise ApiError(409, "taken", f"{i} 已经有了，换一个英文短名")
        redo.add(i)
    f = body.get("file") or {}
    fname = os.path.basename(str(f.get("name") or "")).strip()
    ext = os.path.splitext(fname)[1].lower()
    size = int(f.get("size") or 0)
    if ext not in VIDEO_EXT or not re.fullmatch(r"[\w .()-]{1,100}", fname):
        raise ApiError(400, "bad_file", "参考视频只收 mp4、mov、webm，文件名不要带特殊符号")
    if not 0 < size <= MAX_VIDEO:
        raise ApiError(400, "bad_size", "参考视频不能超过 300 MB")
    now = c.now_ms()
    key = f"styles/{sid}/source/{fname}"
    notes = str(body.get("notes") or "")[:1000]
    for k, i in ids.items():
        item = {"pk": styles.PK, "sk": i, "kind": k, "owner": "platform", "name": name if k == "visual" else wname,
                "notes": notes, "source": {"key": key, "name": fname, "size": size},
                "createdBy": {"sub": me["sub"], "email": me["email"]}, "createdAt": now, "updatedAt": now,
                "versions": [], "tests": [], "feedback": [], **({"pair": sid} if i != sid else {}),
                **({"cat": str(body.get("cat") or "")[:20] or "插画讲解"} if k == "visual" else {"group": group})}
        if i in redo:  # 写入那一刻仍要是自己没开始生成的草稿
            cond = {"ConditionExpression": "attribute_not_exists(taskId) AND createdBy.#s = :me",
                    "ExpressionAttributeNames": {"#s": "sub"}, "ExpressionAttributeValues": {":me": me["sub"]}}
        else:
            cond = {"ConditionExpression": "attribute_not_exists(pk)"}
        try:
            c.table().put_item(Item=c.ddb_safe(item), **cond)
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ApiError(409, "taken", f"{i} 已经有了，换一个英文短名")
            raise
    if len(ids) > 1:
        styles.update(sid, pair=ids["writing"])  # 两条记录互相指向
    url = c.s3.generate_presigned_url("put_object", Params={"Bucket": c.DATA_BUCKET, "Key": key, "ContentType": VIDEO_EXT[ext]}, ExpiresIn=3600)
    what = "、".join(f"{KIND_NAME[k]}（{i}）" for k, i in ids.items())
    audit.write(me["email"], "新建风格", f"{name}：{what}", f"参考视频 {fname}，{size / 1048576:.1f} MB")
    return {"id": sid, "ids": ids, "upload": {"url": url, "headers": {"Content-Type": VIDEO_EXT[ext]}}}


def start(sid, me):
    """参考视频传完以后：建生成任务（复制参考视频进任务目录），开始第一轮"""
    st = _must(sid)
    if st.get("taskId"):
        raise ApiError(409, "started", "这个 Skill 已经开始生成了")
    src = st["source"]
    try:
        head = c.s3.head_object(Bucket=c.DATA_BUCKET, Key=src["key"])
    except Exception:
        raise ApiError(400, "no_upload", "参考视频还没有传完")
    if head["ContentLength"] > MAX_VIDEO:
        raise ApiError(400, "bad_size", "参考视频不能超过 300 MB")
    task_id = c.new_id()
    c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{c.prefix(me['sub'], task_id)}/input/ref/{src['name']}",
                     CopySource={"Bucket": c.DATA_BUCKET, "Key": src["key"]})
    now = c.now_ms()
    recs = {styles.kind_of(x): x for x in [st] + ([styles.get(st["pair"])] if st.get("pair") else []) if x}
    req = {"product": "style", "mode": "quick", "web_search": False, "description": st.get("notes") or st["name"],
           "outputs": [k for k in styles.KINDS if k in recs], "source": src["name"]}
    if "visual" in recs:
        v = recs["visual"]
        req["style"] = {"id": v["sk"], "name": v["name"], "cat": v.get("cat"), "notes": v.get("notes") or ""}
    if "writing" in recs:
        w = recs["writing"]
        req["writing"] = {"id": w["sk"], "name": w["name"], "group": w.get("group") or "讲解", "notes": w.get("notes") or ""}
    item = {"pk": f"TASK#{task_id}", "sk": "META", "id": task_id, "sub": me["sub"], "email": me["email"],
            "gsi1pk": styles.GSI, "gsi1sk": now, "title": f"风格创建：{st['name']}", "mode": "quick", "request": req,
            "status": "queued", "steps": c.empty_steps(c.STYLE_STEPS), "docs": {}, "clips": {}, "versions": [], "turn": None,
            "failure": None, "createdAt": now, "updatedAt": now}
    c.put_task(item)
    what = "、".join(f"{KIND_NAME[k]}「{r['name']}」" for k, r in recs.items())
    c.add_message(task_id, "user", f"开始生成{what}" + (f"。补充说明：{st['notes']}" if st.get("notes") else ""), kind="text")
    for r in recs.values():
        styles.update(r["sk"], taskId=task_id)
    c.start_turn(item, "start", check=False)
    audit.write(me["email"], "开始生成风格", f"{st['name']}（{sid}）", f"生成任务 {task_id[:8]}")
    return {"taskId": task_id}


def _version_view(v, done_tests):
    seg = [{**s, "side": _url(s.get("side")), "cmp": _url(s.get("cmp"))} for s in v.get("segments") or []]
    return {"n": v["n"], "at": v.get("at"), "summary": v.get("summary"), "feedback": v.get("feedback"), "checks": v.get("checks") or [],
            "segments": seg, "demos": [{**d, "url": _url(d.get("url"))} for d in v.get("demos") or []],
            "trials": [{**t, "url": _url(t.get("url"))} for t in v.get("trials") or []], "traits": v.get("traits") or {},
            "thumb": _url(v.get("thumb")), "files": (v.get("files") or []) + ["report.md"],
            "reviewFiles": [f"review/{f}" for f in v.get("reviewFiles") or []], "canPublish": v["n"] in done_tests}


def detail(sid):
    st = _must(sid)
    task = c.get_task(st["taskId"]) if st.get("taskId") else None
    tests = []
    for t in st.get("tests") or []:
        tk = c.get_task(t["taskId"]) or {}
        tests.append({"taskId": t["taskId"], "email": t.get("email", ""), "v": t["v"], "title": tk.get("title") or "（已删除）",
                      "status": tk.get("status") or "deleted", "credits": tk.get("credits"), "at": t.get("at")})
    done = {t["v"] for t in tests if t["status"] == "completed"}
    out = {**_brief(st, task), "notes": st.get("notes") or "",
           "source": {"name": st["source"]["name"], "size": st["source"]["size"], "url": _url(st["source"]["key"])},
           "task": None, "versions": [_version_view(v, done) for v in st.get("versions") or []], "tests": tests,
           "rejected": st.get("rejected"), "reason": (st.get("rejected") or {}).get("reason"), "retired": st.get("retired")}
    if task:
        steps = task.get("steps") or {}
        idle = "pending" if task.get("status") in ("queued", "running") else "skipped"  # 以前的生成任务没有听旁白、写写作方法这两步
        msgs = [m for m in c.messages(task["id"]) if m.get("kind") != "system"][-20:]
        out["task"] = {"id": task["id"], "status": task.get("status"), "credits": task.get("credits"), "updatedAt": task.get("updatedAt"),
                       "stale": _stale(task),
                       "failure": (task.get("failure") or {}).get("message"),
                       "steps": [{"id": k, "name": n, "state": (steps.get(k) or {}).get("state", idle), "note": (steps.get(k) or {}).get("note", "")}
                                 for k, n in c.STYLE_STEPS],
                       "messages": [{"role": m.get("role"), "text": m.get("text"), "at": m.get("at")} for m in msgs]}
    return out


def file(sid, qs):
    st = _must(sid)
    v = styles.version(st, qs.get("v") or 0)
    path = str(qs.get("path") or "")
    if not v:
        raise ApiError(404, "not_found", "没有这一版")
    if path == "report.md":
        key = f"{styles.base(sid, v['n'])}/review/report.md"
    elif path.startswith("review/") and path[len("review/"):] in (v.get("reviewFiles") or []):
        key = f"{styles.base(sid, v['n'])}/{path}"
    elif path in (v.get("files") or []):
        key = f"{styles.base(sid, v['n'])}/skill/{path}"
    else:
        raise ApiError(404, "not_found", "这一版里没有这个文件")
    try:
        data = c.s3.get_object(Bucket=c.DATA_BUCKET, Key=key)["Body"].read(400 << 10)
    except Exception:
        raise ApiError(404, "not_found", "文件不存在")
    return {"path": path, "text": data.decode("utf-8", "replace")}


def _version_of(st, body):
    v = styles.version(st, body.get("v") or 0)
    if not v:
        raise ApiError(400, "bad_version", "没有这一版")
    return v["n"]


def feedback(sid, body, me):
    st = _must(sid)
    text = str(body.get("text") or "").strip()
    if not text or len(text) > 2000:
        raise ApiError(400, "bad_text", "修改意见要填，最多 2000 字")
    task = c.get_task(st.get("taskId") or "")
    if not task:
        raise ApiError(400, "not_started", "这个 Skill 还没有开始生成")
    if len(st.get("versions") or []) >= styles.MAX_VERSIONS:
        raise ApiError(400, "too_many", f"一个 Skill 最多 {styles.MAX_VERSIONS} 版")
    v = _version_of(st, body)
    c.start_turn(task, "revise", text=text, extra={"v": v, "skillKind": styles.kind_of(st)})  # 正在生成时返回 409
    entry = {"forV": len(st.get("versions") or []) + 1, "v": v, "text": text, "at": c.now_ms(), "by": me["email"]}
    c.table().update_item(Key={"pk": styles.PK, "sk": sid}, UpdateExpression="SET feedback = list_append(if_not_exists(feedback, :e), :f), updatedAt = :now",
                          ExpressionAttributeValues={":f": [entry], ":e": [], ":now": c.now_ms()})
    styles.update(sid, rejected=None)
    audit.write(me["email"], "风格按意见重新生成", f"{st['name']}（{sid}）", f"看的是第 {v} 版：{text[:200]}")
    return {"ok": True}


def _stale(task):
    return task.get("status") in ("queued", "running") and c.now_ms() - int(task.get("updatedAt") or 0) > STALE_MS


def retry(sid, me):
    """生成失败，或者生成中却很久没有动静（会话被回收了）：在同一个任务里接着做"""
    st = _must(sid)
    task = c.get_task(st.get("taskId") or "")
    missing = bool(task) and task.get("status") == "completed" and not st.get("versions")  # 任务做完了，这一种没导出
    if not task or not (task.get("status") == "failed" or _stale(task) or missing):
        raise ApiError(400, "not_failed", "只有生成失败、或者很久没有动静的 Skill 可以重试")
    why = ((task.get("failure") or {}).get("message") if not missing else None) or (
        f"{KIND_NAME[styles.kind_of(st)]}（{sid}）还没有导出：做完它并导出第一版，另一种不动" if missing
        else "会话意外停止，工作区可能已经丢失" if _stale(task) else "未知")
    c.start_turn(task, "retry", text=why, check=False)
    audit.write(me["email"], "重试生成风格", f"{st['name']}（{sid}）")
    return {"ok": True}


def act(sid, action, body, me):
    st = _must(sid)
    label = f"{st['name']}（{sid}）"
    if action == "reject":
        reason = str(body.get("reason") or "").strip()
        if not reason:
            raise ApiError(400, "no_reason", "驳回要写原因")
        styles.update(sid, rejected={"reason": reason[:500], "at": c.now_ms(), "by": me["email"]}, betaV=None)
        audit.write(me["email"], "驳回风格", label, reason[:300])
    elif action == "beta":
        v = _version_of(st, body)
        styles.protect(sid, v)  # 先写进内容把关，再让人用
        styles.update(sid, betaV=v, rejected=None, retired=None)
        audit.write(me["email"], "内测发布风格", label, f"第 {v} 版，只有管理员能在风格库里看到")
    elif action == "unbeta":
        styles.update(sid, betaV=None)
        audit.write(me["email"], "撤回内测", label)
    elif action == "publish":
        v = _version_of(st, body)
        done = [t for t in st.get("tests") or [] if t["v"] == v and (c.get_task(t["taskId"]) or {}).get("status") == "completed"]
        if not done:
            raise ApiError(400, "no_test", f"第 {v} 版还没有做完的测试片：先内测发布，用它做一支片子")
        styles.protect(sid, v)
        styles.update(sid, publicV=v, betaV=None if st.get("betaV") == v else st.get("betaV"), retired=None, rejected=None)
        audit.write(me["email"], "公开发布风格", label, f"第 {v} 版，所有用户都能用")
    elif action == "retire":
        styles.update(sid, retired={"at": c.now_ms(), "by": me["email"]}, publicV=None, betaV=None)
        audit.write(me["email"], "下架风格", label, "已经用过它的任务照常能改、能重渲")
    else:
        raise ApiError(404, "not_found", "没有这个操作")
    return {"ok": True}
