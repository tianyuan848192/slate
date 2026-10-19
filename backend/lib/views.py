"""把 DynamoDB 里的任务记录整理成前端需要的结构（见 docs/api.md）。"""
from . import billing
from . import chapters as chs
from . import common as c
from . import flows
from . import library
from .validate import genre_name

STEP_LABEL = {**dict(c.STEPS), **dict(c.MODEL_STEPS)}
FILTERS = {"all": None, "active": ("queued", "running", "awaiting_confirmation"), "done": ("completed",), "failed": ("failed",)}
# 已下架的旧风格：不在目录里了，老任务的简报仍要显示中文名
LEGACY_SKILLS = {"editorial": "编辑图解", "swiss": "瑞士网格", "arena": "霓虹擂台", "screencast": "界面秀", "collage": "纸媒拼贴",
                 "papercut": "窗花剪纸", "shanshui": "水墨山水",  # 2026-10-14 下架
                 "whiteboard": "白板手绘讲解", "iso": "等距架构图", "keynote": "发布会大字",
                 "datastory": "数据叙事", "vertical": "竖屏快剪", "line": "极简线条"}


def _spec_text(task):
    br = (task.get("docs") or {}).get("brief") or {}
    sp = task.get("request", {}).get("options", {}).get("spec", {})
    ratio = br.get("ratio") or sp.get("ratio")
    dur = br.get("duration") or sp.get("duration")
    if not ratio:
        return "Agent 按内容定"
    d = int(dur or 0)
    return f"{ratio}，{d // 60} 分钟" if d >= 60 and d % 60 == 0 and d > 60 else f"{ratio}，{d} 秒"


def status_text(task, chapters=None):
    st = task.get("status")
    if st == "queued":
        return "排队中"
    if st == "awaiting_confirmation":
        return "等你确认总纲" if (task.get("docs") or {}).get("outline") and not chapters else "等你确认分镜"
    if st == "running" and (task.get("turn") or {}).get("kind") == "stitch":
        return "拼接整片中"
    if st == "running" and chapters:
        return f"各章制作中，{sum(x['status'] == 'done' for x in chapters)}/{len(chapters)} 章完成"
    if st == "running" and (task.get("turn") or {}).get("kind") == "chapters":
        return "各章制作中"
    if st == "failed":
        return "失败"
    if st == "completed":
        n = len(task.get("models" if c.product_of(task) == "model3d" else "versions") or [])
        return f"已完成，第 {n} 版" if n > 1 else "已完成"
    steps = task.get("steps") or {}
    sb = (task.get("docs") or {}).get("storyboard") or {}
    total = len(sb.get("scenes") or [])
    for name, label in reversed(c.steps_of(task)):
        if (steps.get(name) or {}).get("state") == "running":
            if name == "render" and total:
                return f"渲染中 {len(task.get('clips') or {})}/{total} 镜"
            return f"{label}中"
    return "生成中"


def list_view(tasks, flt="all"):
    allowed = FILTERS.get(flt)
    out = []
    for t in tasks:
        if allowed and t.get("status") not in allowed:
            continue
        br = (t.get("docs") or {}).get("brief") or {}
        three = c.product_of(t) == "model3d"
        m = library.latest_model(t) if three else None
        item = {"id": t["id"], "product": c.product_of(t), "title": library.name_of(t) if three else br.get("title") or t.get("title"),
                "description": t.get("request", {}).get("description", "")[:60],
                "kind": "3D 图片" if three else br.get("kind") or "待定", "spec": None if three else _spec_text(t), "status": t.get("status"),
                "statusText": status_text(t), "thumb": None if three else (br.get("skills") or [None])[0],
                "versions": len(t.get("models" if three else "versions") or []), "failure": t.get("failure"), "updatedAt": t.get("updatedAt"),
                "credits": round(float(t.get("credits") or 0), 2), "flow": t.get("request", {}).get("flow")}
        if m:
            views = m["files"].get("views") or {}
            item["thumbUrl"] = c.media_url(views.get("35") or views.get("0")) if views else None
        out.append(item)
    return out


def _chapter_steps(steps, chapters):
    """长片：分镜、代码、渲染、合成这几步按各章汇总（有一章在做就是进行中，全部做完才算完成）"""
    out = dict(steps)
    n = len(chapters)
    for name in chs.CHAPTER_STEPS:
        states = [((x.get("steps") or {}).get(name) or {}).get("state", "pending") for x in chapters]
        done = sum(s in ("done", "skipped") for s in states)
        st = "done" if done == n else "running" if any(s == "running" for s in states) or done else "pending"
        out[name] = {**(steps.get(name) or {}), "state": st, "note": f"{done}/{n} 章完成"}
    return out


def _outline_rows(outline):
    """确认总纲时，把每章当作一行"分镜"给前端编辑：标题、讲稿、本章要点、计划时长"""
    return {"title": outline.get("title"), "scenes": [{"id": x["id"], "title": x["title"], "narration": x["narration"], "visual": x["summary"],
                                                       "duration": x["duration"], "chapter": x["id"]} for x in outline.get("chapters") or []]}


def _images_view(task):
    """视频里用的普通图片：编号、文件名、描述、缩略图（开工前整理时生成；还没生成时用原图）。分镜每镜的 images 对得上这里的编号"""
    imgs = [x for x in task["request"].get("images") or [] if x.get("orig")]
    if not imgs:
        return []
    pre = c.prefix(task["sub"], task["id"])
    return [{"id": x["id"], "name": x.get("name"), "desc": x.get("desc"), "error": x.get("error"), "fileId": x.get("fileId"),
             "url": c.media_url(f"{pre}/{x.get('thumb') or x['orig']}")} for x in imgs]


def _refs_view(refs):
    """参考资料清单（不含文件路径）：编号、类型、名称、备注、抽出的字数、抓取失败的原因"""
    if not refs:
        return None
    keep = ("id", "kind", "title", "url", "note", "source", "chars", "size", "error", "truncated", "fileId")
    return {"web": refs.get("web"), "strict": refs.get("strict"),
            "items": [{k: x[k] for k in keep if x.get(k) is not None} for x in refs.get("items") or []]}


def _step_list(task, steps, defs):
    """步骤列表；任务已经完成时，Agent 忘了报"完成"的步骤按完成显示"""
    done = task.get("status") == "completed"
    out = []
    for n, _ in defs:
        st = steps.get(n) or {"state": "pending", "note": ""}
        out.append({"name": n, "label": STEP_LABEL[n], **st, **({"state": "done"} if done and st.get("state") == "running" else {})})
    return out


def _common_view(task, msgs, title):
    """视频和 3D 任务共用的字段：状态、用时、对话、能做的操作、失败原因、Credit"""
    st = task.get("status")
    started = task.get("createdAt") or 0
    end = task.get("updatedAt") if st in ("completed", "failed", "awaiting_confirmation") else c.now_ms()
    steps = task.get("steps") or {}
    return {
        "id": task["id"], "product": c.product_of(task), "title": title, "status": st, "statusText": status_text(task), "mode": task.get("mode"),
        "createdAt": task.get("createdAt"), "updatedAt": task.get("updatedAt"), "elapsed": max(0, int((end - started) / 1000)),
        "steps": _step_list(task, steps, c.steps_of(task)),
        "messages": [{"id": m["sk"], "role": m["role"], "kind": m.get("kind", "text"), "text": m["text"],
                      "scope": m.get("scope"), "node": m.get("node"), "at": m["at"]} for m in msgs],
        "canMessage": st in ("completed", "awaiting_confirmation", "failed"),
        "canConfirm": st == "awaiting_confirmation", "canRetry": st == "failed",
        "failure": task.get("failure"),
        "billing": {"credits": round(float(task.get("credits") or 0), 2), "turns": billing.turns_of(task["id"]),
                    # 用量指标每分钟导出一次：任务在跑、或者结束不到 3 分钟时，数字还会变
                    "pending": st in ("running", "queued") or c.now_ms() - int(task.get("updatedAt") or 0) < 180000},
        "flow": _flow_view(task),
    }


def _flow_view(task):
    """工作流模式：画板编号、这一轮（或最近一轮）属于哪个节点，以及分镜在最新一版成片之后又改了哪几镜（音画节点据此标"需要重跑"）"""
    fid = (task.get("request") or {}).get("flow")
    if not fid:
        return None
    out = {"id": fid}
    if c.product_of(task) == "video":
        changed, removed = flows.changed_scenes(task)
        out.update(node=flows.node_of(task), changed=changed, removed=removed)
    return out


def model_detail_view(task, msgs):
    """3D 图片任务的详情（docs/library-3d-design.md 第五节）"""
    pre = c.prefix(task["sub"], task["id"])
    req = task["request"]
    return {**_common_view(task, msgs, library.name_of(task)),
            "request": {"description": req["description"], "web_search": bool(req.get("web_search")), "explode": bool(req.get("explode")),
                        "images": [{"name": x["name"], "url": c.media_url(f"{pre}/{x['file']}")} for x in req.get("imageFiles") or []]},
            "model": {"asset": library.asset_of(task), "versions": [library.model_view(m) for m in task.get("models") or []]},
            "sources": (task.get("docs") or {}).get("sources"),  # 联网搜索的来源（slate-publish sources）
            "brief": None, "script": None, "storyboard": None, "notes": None, "scriptCheck": None,
            "versions": [], "chapters": None, "long": False}


def detail_view(task, msgs):
    if c.product_of(task) == "model3d":
        return model_detail_view(task, msgs)
    docs = task.get("docs") or {}
    steps = task.get("steps") or {}
    clips = task.get("clips") or {}
    sb = docs.get("storyboard")
    chapters = chs.all_of(task["id"]) if docs.get("outline") else []
    if docs.get("outline"):  # 长片：分镜由各章拼成；还没开始各章时显示总纲
        sb = chs.merged_storyboard(task, chapters) if chapters else _outline_rows(docs["outline"])
        if chapters:  # 还没写出分镜的章先占一行，方便看到全片结构
            have = {s["chapter"] for s in sb["scenes"]}
            for x in docs["outline"]["chapters"]:
                if x["id"] not in have:
                    sb["scenes"].append({"id": x["id"], "title": x["title"], "narration": x["narration"][:200], "visual": x["summary"],
                                         "duration": x["duration"], "chapter": x["id"], "chapterTitle": x["title"], "pending": True})
            order = {x["id"]: i for i, x in enumerate(docs["outline"]["chapters"])}
            sb["scenes"].sort(key=lambda s: (order.get(s["chapter"], 99), s["id"]))
            clips = {}
            for sc in sb["scenes"]:
                cl = sc.pop("_clip", None)
                if cl:
                    clips[sc["id"]] = cl
            steps = _chapter_steps(steps, chapters)
    if sb:
        start = 0.0
        scenes = []
        for s in sb.get("scenes", []):
            cl = clips.get(s["id"])
            scenes.append({**s, "start": round(start, 2),
                           "clip": {"url": c.media_url(cl["key"]), "dur": cl.get("dur")} if cl and cl.get("key") else None})
            start += float(s.get("duration") or 0)
        sb = {**sb, "scenes": scenes}
    brief = docs.get("brief")
    if brief:
        names = {**LEGACY_SKILLS, **{s["id"]: s["name"] for s in c.catalog()}}
        brief = {**brief, "skills": [{"id": i, "name": names.get(i, i)} for i in brief.get("skills", [])]}
        vn = {v["id"]: v["name"] for v in c.voices()}
        if brief.get("voice") in vn:  # Agent 写的是音色 id，前端显示中文名
            brief["voice"] = vn[brief["voice"]]
    title = (brief or {}).get("title") or task.get("title")
    versions = [{"n": v["n"], "url": c.media_url(v["key"]), "download": c.media_url(v["key"], download_name=f"{title}-第{v['n']}版.mp4"),
                 "dur": v.get("dur"), "createdAt": v.get("at")} for v in task.get("versions") or []]
    return {
        **_common_view(task, msgs, title),
        "statusText": status_text(task, chapters),
        "steps": _step_list(task, steps, c.STEPS),
        "request": {**{k: task["request"][k] for k in ("description", "web_search", "options")},
                    "refs": _refs_view(task["request"].get("refs")),
                    "models": [{"id": m["id"], "taskId": m["taskId"], "name": m["name"], "version": m.get("version")}
                               for m in task["request"].get("modelRefs") or []] or None,
                    "images": _images_view(task) or None,
                    "genre": ({"id": task["request"]["genre"], "name": gn} if (gn := genre_name(task["request"])) else None)},
        "brief": brief, "sources": docs.get("sources"), "script": docs.get("script"), "storyboard": sb,
        "notes": docs.get("notes"), "scriptCheck": docs.get("scriptcheck"),
        "versions": versions,
        "chapters": [{"id": x["id"], "title": x.get("title"), "duration": x.get("duration"), "status": x["status"],
                      "scenes": len((x.get("storyboard") or {}).get("scenes") or []), "clips": len(x.get("clips") or {}),
                      "failure": (x.get("failure") or {}).get("message")} for x in chapters] or None,
        "long": bool(docs.get("outline")),
    }
