"""events Lambda：S3 数据桶 u/<sub>/t/<taskId>/events/*.json 的对象创建事件。

会话里的 slate 命令把进度和结果写成事件文件；这里在沙箱外校验、把关后写入 DynamoDB，前端只读这里的结果。
长片章节会话的事件带 chapter（两位数字），写进这一章的章节记录。
"""
import json, re, traceback
from urllib.parse import unquote_plus

from lib import billing
from lib import common as c
from lib import chapters as chs
from lib import flows
from lib import gate
from lib import library
from lib import styles
from lib.validate import genre_name, schema_check

KEY_RE = re.compile(r"^u/([^/]+)/t/([0-9a-f-]{36})/events/[^/]+\.json$")
STATE = {"start": "running", "done": "done", "skip": "skipped"}


def handler(event, context):
    for rec in event.get("Records", []):
        key = unquote_plus(rec["s3"]["object"]["key"])
        m = KEY_RE.match(key)
        if not m:
            continue
        try:
            process(m.group(1), m.group(2), c.read_json(key))
        except Exception:
            traceback.print_exc()


def blocked(task_id, what, reason):
    print(json.dumps({"security": "output_blocked", "task": task_id, "what": what, "reason": reason}, ensure_ascii=False))
    c.set_fields(task_id, lastError=f"{what}没有通过内容检查")


# 只给渲染或程序用的字段（风格组件名、字体名、颜色、函数名），不展示给用户，不做内容重合检查：
# 总纲的 look（给各章会话的视觉规范），分镜的 caption_style（全片字幕样式），素材卡的 factory（模型的工厂函数名）
VISUAL_ONLY = {"outline": ("look",), "storyboard": ("caption_style",), "asset": ("factory",)}


DOC_NAMES = {"notes": "资料整理", "brief": "需求分析", "sources": "资料来源", "script": "剧本", "scriptcheck": "剧本核对",
             "storyboard": "分镜", "outline": "总纲", "asset": "素材卡"}


def shown_part(doc, data):
    return {k: v for k, v in data.items() if k not in VISUAL_ONLY.get(doc, ())} if isinstance(data, dict) else data


MAX_RENDER_SECONDS = 900


def bill_render(task, ev):
    """渲染机每次渲染、自检的忙碌秒数，按机型单价记账；算在这个会话此刻所在的那一轮"""
    try:
        secs = float(ev.get("seconds") or 0)
    except (TypeError, ValueError):
        return
    # 这条事件是会话里写的（会话能写本任务的 events/），不全信：一次渲染最多 15 分钟，时间只认最近 1 小时内的
    if not 0 < secs <= MAX_RENDER_SECONDS:
        print("render_usage seconds out of range, ignore", task["id"], secs); return
    ch = str(ev.get("chapter")) if re.fullmatch(r"[0-9]{2}", str(ev.get("chapter") or "")) else None
    now = c.now_ms()
    try:
        at = int(ev.get("at") or now)
    except (TypeError, ValueError):
        at = now
    if abs(now - at) > 3600_000:
        at = now
    found = billing.find_session(c.session_id(task["id"], ch), at)
    turn = found[1] if found else {"turnId": (task.get("turn") or {}).get("id"), "label": "", "chapter": ch, "free": False}
    inst = re.sub(r"[^a-z0-9.]", "", str(ev.get("instance") or ""))[:30] or "unknown"
    host = re.sub(r"[^a-z0-9-]", "", str(ev.get("host") or ""))[:30] or "unknown"
    # 运维日志：哪个任务的哪个会话用了哪台机器（用户看不到）。并行的任务应该各占一台
    print(json.dumps({"render_usage": task["id"], "session": c.render_session(task["id"], ch), "instance": inst, "host": host,
                      "op": ev.get("op"), "seconds": secs, "scenes": ev.get("scenes")}))
    what = {"render": "渲染", "qa": "自检", "model": "3D 渲染"}.get(ev.get("op"), "渲染")
    billing.record({"id": task["id"], "sub": task["sub"], "email": task.get("email", "")}, at, f"r-{str(ev.get('run') or at)[:40]}", "render", turn,
                   {"seconds": secs}, model=inst, billable=not turn.get("free"),
                   note=(f"{what}，用时 {secs:.1f} 秒" if ev.get("op") == "model" else f"{what} {int(ev.get('scenes') or 0)} 镜，用时 {secs:.1f} 秒")
                   + ("；安全策略误拦后自动重做，不计费" if turn.get("free") else ""))


def process(sub, task_id, ev):
    task = c.get_task(task_id)
    if not task or task["sub"] != sub:
        return
    if ev.get("type") == "render_usage":  # 渲染机写来的用量（章节会话的也在这里记）
        return bill_render(task, ev)
    ch = ev.get("chapter")
    if ch is not None:
        if re.fullmatch(r"[0-9]{2}", str(ch)) and chs.get(task_id, ch):
            process_chapter(task, str(ch), ev)
        return
    pre = c.prefix(sub, task_id)
    t = ev.get("type")
    now = c.now_ms()
    if t == "step":
        name = ev.get("name")
        if name not in dict(c.steps_of(task)):
            return
        note = str(ev.get("note") or "")[:300]
        if gate.check(note):
            blocked(task_id, "步骤说明", gate.check(note)); note = ""
        st = STATE.get(ev.get("state"), "running")
        cur = (task.get("steps") or {}).get(name) or {}
        val = {"state": st, "note": note or cur.get("note", ""),
               "startedAt": cur.get("startedAt") if st != "running" else now, "endedAt": now if st != "running" else None}
        if st != "running" and not val["startedAt"]:
            val["startedAt"] = now
        c.update_task(task_id, "SET steps.#n = :v, updatedAt = :now, gsi1sk = :now", {"#n": name}, {":v": val, ":now": now})
    elif t == "publish":
        doc, key = ev.get("doc"), str(ev.get("key") or "")
        if doc not in DOC_NAMES or key != f"{pre}/pub/{doc}.json":
            return
        data = c.read_json(key)
        gname = genre_name(task.get("request")) if doc == "brief" and isinstance(data, dict) else None
        if gname:  # 用户指定了写作方法（内置的或生成的）：以用户的为准，不算 Agent 决定的
            data["kind"] = gname
            data["decided"] = [x for x in (data.get("decided") or []) if x != "kind"]
        err = schema_check(doc, data)
        if err:
            c.set_fields(task_id, lastError=f"{doc} 格式不对：{err}"); return
        why = gate.check(gate.texts_of(shown_part(doc, data)))
        if why:
            blocked(task_id, DOC_NAMES[doc], why); return
        if doc == "notes":  # 资料摘要要交代每一份资料（会话里的 slate-publish 已经查过，这里以任务记录为准再查一遍）
            want = [x["id"] for x in ((task.get("request") or {}).get("refs") or {}).get("items", [])]
            miss = [i for i in want if i not in {x.get("id") for x in data.get("items", [])}]
            if miss:
                c.set_fields(task_id, lastError=f"资料摘要没有交代资料 {', '.join(miss)}"); return
        fields = {}
        if doc == "brief" and data.get("title"):
            fields["title"] = data["title"]
        if doc == "asset" and data.get("name"):  # 3D 图片：素材卡里的名称就是任务标题
            fields["title"] = data["name"]
        c.update_task(task_id, "SET docs.#d = :v" + "".join(f", #{k} = :{k}" for k in fields) + ", updatedAt = :now, gsi1sk = :now",
                      {"#d": doc, **{f"#{k}": k for k in fields}}, {":v": data, ":now": now, **{f":{k}": v for k, v in fields.items()}})
    elif t == "say":
        text = str(ev.get("text") or "")[:2000].strip()
        if not text:
            return
        why = gate.check(text)
        if why:
            blocked(task_id, "消息", why)
            text = "（这条消息没有通过内容检查，已隐藏）"
        node = flows.node_of(task)  # 工作流模式：消息记在这一轮所属的节点（文字 / 音画）下
        c.add_message(task_id, "agent", text, kind="plan" if ev.get("kind") == "plan" else "text", extra={"node": node} if node else None)
        c.set_fields(task_id)
    elif t == "clip":
        scene, key = str(ev.get("scene") or ""), str(ev.get("key") or "")
        if not re.fullmatch(r"[0-9]{2}", scene) or not re.fullmatch(re.escape(pre) + r"/clips/[0-9a-f]{8,64}\.mp4", key):
            return
        val = {"key": key, "hash": ev.get("hash"), "dur": ev.get("dur"), "at": now}
        c.update_task(task_id, "SET clips.#s = :v, updatedAt = :now, gsi1sk = :now", {"#s": scene}, {":v": val, ":now": now})
    elif t == "version":
        key = str(ev.get("key") or "")
        if not re.fullmatch(re.escape(pre) + r"/final/[0-9a-zA-Z_-]+\.mp4", key):
            return
        if any(v.get("key") == key for v in task.get("versions") or []):
            return
        n = len(task.get("versions") or []) + 1
        val = {"n": n, "key": key, "dur": ev.get("dur"), "at": now, "turnId": ev.get("turnId"), "scenes": ev.get("scenes"),
               # 这一版对应的分镜指纹：工作流里文字节点之后又改了哪几镜，和它比
               "sb": flows.scene_sig((task.get("docs") or {}).get("storyboard"))}
        c.update_task(task_id, "SET versions = list_append(if_not_exists(versions, :empty), :v), turnFlags.version = :t, "
                               "updatedAt = :now, gsi1sk = :now", values={":v": [val], ":empty": [], ":t": True, ":now": now})
    elif t == "model":  # 3D 图片的一个新版本：slate-model export 上传到 model/v<n>/ 后发出
        n = ev.get("n")
        files = ev.get("files") or {}
        base = f"{pre}/model/v{n}/"
        keys = [files.get(k) for k in ("module", "glb", "comparison", "explodeGif", "exploded", "printSrc")] + list((files.get("views") or {}).values())
        if not isinstance(n, int) or n < 1 or not files.get("module") or any(k and not str(k).startswith(base) for k in keys):
            return
        if any(m.get("n") == n for m in task.get("models") or []):
            return
        try:  # 模型代码太大不收：浏览器预览和检查都按它的大小花时间
            if c.s3.head_object(Bucket=c.DATA_BUCKET, Key=files["module"])["ContentLength"] > library.MAX_MODULE_BYTES:
                print("model module too large, ignore", task_id, n); return
        except Exception:
            traceback.print_exc(); return
        steps = [{"label": str(s.get("label") or "")[:60], "parts": [str(p)[:41] for p in (s.get("parts") or [])][:40]}
                 for s in (ev.get("steps") or [])[:30] if isinstance(s, dict)]
        val = {"n": n, "files": {k: files[k] for k in ("module", "glb", "comparison", "views", "explodeGif", "exploded", "printSrc") if files.get(k)},
               "steps": steps, "at": now, "turnId": ev.get("turnId")}
        c.update_task(task_id, "SET models = list_append(if_not_exists(models, :empty), :v), turnFlags.version = :t, "
                               "updatedAt = :now, gsi1sk = :now", values={":v": [val], ":empty": [], ":t": True, ":now": now})
    elif t in ("style", "writing"):  # 风格创建的一版：画风（slate-style export，style/v<n>/）或写作方法（export-writing，writing/v<n>/），复制到 styles/<id>/v<n>/
        kind = "visual" if t == "style" else "writing"
        val = styles.new_version(task, ev, pre, kind) if c.product_of(task) == "style" else None
        if val:
            field = "styleVersions" if kind == "visual" else "writingVersions"
            c.update_task(task_id, f"SET {field} = list_append(if_not_exists({field}, :empty), :v), turnFlags.version = :t, "
                                   "updatedAt = :now", values={":v": [{"n": val["n"], "at": now}], ":empty": [], ":t": True, ":now": now})
    elif t == "awaiting_confirmation":
        c.update_task(task_id, "SET turnFlags.awaiting = :t, updatedAt = :now", values={":t": True, ":now": now})
    elif t == "chapters_ready":
        c.update_task(task_id, "SET turnFlags.chaptersReady = :t, updatedAt = :now", values={":t": True, ":now": now})
    elif t == "revise_chapters":
        known = {x["id"] for x in ((task.get("docs") or {}).get("outline") or {}).get("chapters") or []}
        ids = [x for x in ev.get("chapters") or [] if x in known]
        note = str(ev.get("note") or "")[:2000]
        if ids and not gate.check(note):
            c.update_task(task_id, "SET turnFlags.reviseChapters = :v, updatedAt = :now", values={":v": {"chapters": ids, "note": note}, ":now": now})
    elif t in ("fail", "error"):
        msg = str(ev.get("message") or "")[:300]
        if gate.check(msg):
            msg = "Agent 报告了一个错误"
        if t == "fail":
            c.update_task(task_id, "SET turnFlags.fail = :m, lastError = :m, updatedAt = :now", values={":m": msg, ":now": now})
        else:
            c.set_fields(task_id, lastError=msg)


def process_chapter(task, ch, ev):
    """章节会话的事件：进度、分镜、片段、本章成片、失败都写进章节记录；给用户的消息带上章名"""
    task_id, pre, t, now = task["id"], c.prefix(task["sub"], task["id"]), ev.get("type"), c.now_ms()
    if t == "step":
        name = ev.get("name")
        if name not in chs.CHAPTER_STEPS:
            return
        note = str(ev.get("note") or "")[:300]
        if gate.check(note):
            note = ""
        st = STATE.get(ev.get("state"), "running")
        chs.update(task_id, ch, "SET steps.#n = :v, updatedAt = :now", {"#n": name},
                   {":v": {"state": st, "note": note, "at": now}, ":now": now})
        c.set_fields(task_id)  # 刷新任务的 updatedAt，任务列表按它排序
    elif t == "publish":
        if ev.get("doc") != "storyboard" or str(ev.get("key") or "") != f"{pre}/pub/chapters/{ch}/storyboard.json":
            return
        data = c.read_json(ev["key"])
        err = schema_check("storyboard", data)
        if err:
            chs.set_fields(task_id, ch, lastError=f"分镜格式不对：{err}"); return
        why = gate.check(gate.texts_of(shown_part("storyboard", data)))
        if why:
            blocked(task_id, f"第 {ch} 章分镜", why); return
        chs.set_fields(task_id, ch, storyboard=data)
    elif t == "clip":
        scene, key = str(ev.get("scene") or ""), str(ev.get("key") or "")
        if not re.fullmatch(r"[0-9]{2}", scene) or not re.fullmatch(re.escape(pre) + r"/clips/[0-9a-f]{8,64}\.mp4", key):
            return
        val = {"key": key, "hash": ev.get("hash"), "dur": ev.get("dur"), "at": now}
        chs.update(task_id, ch, "SET clips.#s = :v, updatedAt = :now", {"#s": scene}, {":v": val, ":now": now})
    elif t == "chapter_final":
        key = str(ev.get("key") or "")
        if not re.fullmatch(re.escape(pre) + rf"/chapters/{ch}/[0-9a-zA-Z_-]+\.mp4", key):
            return
        chs.update(task_id, ch, "SET #f = :v, flags.#f = :t, updatedAt = :now", {"#f": "final"},  # final 是 DynamoDB 保留字，路径里也要用占位符
                   {":v": {"key": key, "dur": ev.get("dur"), "at": now}, ":t": True, ":now": now})
    elif t == "say":
        text = str(ev.get("text") or "")[:2000].strip()
        if not text:
            return
        if gate.check(text):
            blocked(task_id, "消息", gate.check(text)); text = "（这条消息没有通过内容检查，已隐藏）"
        rec = chs.get(task_id, ch) or {}
        c.add_message(task_id, "agent", f"【第 {int(ch)} 章 {rec.get('title', '')}】{text}", kind="plan" if ev.get("kind") == "plan" else "text")
        c.set_fields(task_id)
    elif t in ("fail", "error"):
        msg = str(ev.get("message") or "")[:300]
        if gate.check(msg):
            msg = "Agent 报告了一个错误"
        if t == "fail":
            chs.update(task_id, ch, "SET flags.#f = :m, lastError = :m, updatedAt = :now", {"#f": "fail"}, {":m": msg, ":now": now})
        else:
            chs.set_fields(task_id, ch, lastError=msg)
