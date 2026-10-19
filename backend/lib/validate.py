"""请求参数清洗和 JSON Schema 校验（Schema 与会话镜像里的 slate-publish 同源）。"""
import json, os, re

import fastjsonschema

from .common import LONG_SECONDS, ApiError, catalog, genre_of

HERE = os.path.dirname(os.path.abspath(__file__))
_validators = {}

RATIOS = ("16:9", "9:16", "1:1", "4:5")
MIN_SECONDS, MAX_SECONDS = 10, 36000  # 自定义时长：10 秒到 10 小时（只挡明显填错的值）
RESOLUTIONS = ("720p", "1080p")
# 参考资料（docs/references-design.md）
REF_EXT = (".pdf", ".docx", ".md", ".txt", ".csv", ".xlsx")
REF_MAX_BYTES = 1024 * 1024
REF_MAX_ITEMS, REF_MAX_LINKS, REF_MAX_TEXT = 10, 5, 20000
# 3D 图片（docs/library-3d-design.md）：参考照片，以及视频里引用的 3D 素材个数
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")
IMAGE_MAX_BYTES = 10 * 1024 * 1024
MODEL_MAX_IMAGES, VIDEO_MAX_MODELS = 4, 3
# 视频里用的普通图片（docs/image-refs-design.md）：每张都要写描述，Agent 按描述决定放在哪几镜、怎么用
VIDEO_MAX_IMAGES, IMAGE_DESC_MAX = 8, 200
UPLOAD_RE = r"u-[0-9a-f-]{36}"
FPS = (30, 60)


def schema_check(doc, data):
    """返回 None 表示通过，否则返回第一条错误。"""
    if doc not in _validators:
        _validators[doc] = fastjsonschema.compile(json.load(open(os.path.join(HERE, "schemas", f"{doc}.json"))))
    try:
        _validators[doc](data)
        return None
    except fastjsonschema.JsonSchemaException as e:
        return str(e.message)[:200]


def storyboard(sb):
    err = schema_check("storyboard", sb)
    if not err:
        ids = [s["id"] for s in sb["scenes"]]
        if len(set(ids)) != len(ids):
            err = "镜头编号有重复"
        elif len({s["skill"] for s in sb["scenes"] if s.get("skill")}) > 2:
            err = "全片用到的风格最多两个（主风格和一个插入风格）"
    return err


def _s(v, n):
    return str(v or "").strip()[:n]


def _b(v):
    return bool(v)


def task_request(body, generated=(), writing=()):
    """把前端提交的建任务请求清洗成服务端认可的结构；不合法时抛 ApiError(400)。
    generated / writing：这个用户能选的生成画风、生成写作方法的 id（公开的；管理员还有内测中的），和内置的一样可以选"""
    if body.get("product") == "model3d":
        return model_request(body)
    mode = body.get("mode")
    if mode not in ("quick", "advanced"):
        raise ApiError(400, "bad_mode", "创建模式不对")
    flow = flow_id(body)
    if flow and mode != "advanced":
        raise ApiError(400, "bad_flow", "工作流模式的任务要带上规格和画风设置")
    desc = _s(body.get("description"), 4000)
    if not desc:
        raise ApiError(400, "empty_description", "先写一段描述，说清楚想做一支什么样的片子")
    o = (body.get("options") or {}) if mode == "advanced" else {}
    skills, spec = (o.get(k) or {} for k in ("skills", "spec"))
    out = {
        # 讲解稿（由参考资料取代）和素材（上传图片、风格参考网站）都已下线，老前端传了也忽略。老任务的记录里仍保留原来的值
        "script": {"enabled": False, "outline": "", "verbatim": False, "uploads": []},
        "assets": {"enabled": False, "force": False, "uploads": [], "sites": []},
        "skills": {"enabled": _b(skills.get("enabled")), "ids": []},
        "spec": {"enabled": _b(spec.get("enabled"))},
        "confirm_storyboard": _b(o.get("confirm_storyboard")),
    }
    if out["skills"]["enabled"]:
        known = {s["id"] for s in catalog()} | set(generated)
        ids = [i for i in (skills.get("ids") or []) if i in known][:2]  # 主风格 + 最多一个插入风格
        if not ids:
            raise ApiError(400, "empty_skills", "勾选了画风 Skills，选一个或取消勾选")
        out["skills"]["ids"] = ids
    if out["spec"]["enabled"]:
        sp = spec
        ratio = sp.get("ratio") if sp.get("ratio") in RATIOS else "16:9"
        try:
            dur = int(round(float(sp.get("duration") or 60)))
        except (TypeError, ValueError):
            raise ApiError(400, "bad_duration", "时长要填数字")
        if not MIN_SECONDS <= dur <= MAX_SECONDS:
            raise ApiError(400, "bad_duration", f"时长要在 {MIN_SECONDS} 秒到 {MAX_SECONDS // 3600} 小时之间")
        out["spec"].update(ratio=ratio, duration=dur,
                           resolution=sp.get("resolution") if sp.get("resolution") in RESOLUTIONS else "1080p",
                           fps=int(sp.get("fps")) if sp.get("fps") in FPS else 30,
                           voice=_b(sp.get("voice", True)), voice_id=_voice_id(sp.get("voice_id")),
                           subtitles=_b(sp.get("subtitles", True)), bgm=_b(sp.get("bgm")))
    if flow:  # 工作流模式（docs/workflow-mode-design.md）：文字节点写完分镜一定停下，等音画节点运行；长片第一版不支持
        if not out["spec"]["enabled"]:
            raise ApiError(400, "bad_flow", "工作流模式的任务要带上规格设置")
        if out["spec"]["duration"] > LONG_SECONDS:
            raise ApiError(400, "flow_long", "工作流模式暂时只支持 3 分钟以内的片子，更长的片子请用自由模式")
        out["confirm_storyboard"] = True
    # 写法（剧本怎么组织）和风格（画面）互相独立；快速模式也可以选，不选时由 Agent 判断
    genre = body.get("genre") or None
    if genre is not None and not genre_of(genre) and genre not in writing:
        raise ApiError(400, "bad_genre", "没有这种写作方法，请重新选择")
    refs = _refs(body)
    models = list(dict.fromkeys(str(m) for m in body.get("models") or []))
    if len(models) > VIDEO_MAX_MODELS or any(not re.fullmatch(r"[0-9a-f-]{36}", m) for m in models):
        raise ApiError(400, "bad_models", f"从素材库引用的 3D 图片最多 {VIDEO_MAX_MODELS} 个")
    return {"product": "video", "mode": mode, "web_search": refs["web"], "description": desc, "genre": genre, "refs": refs,
            "options": out, "models": models, "images": _images(body), **({"flow": flow} if flow else {})}


def _images(body):
    """视频里用的普通图片：上传的（uploadId）或素材库里的（fileId），每张都要有描述。按顺序编号 i01、i02……"""
    raw = body.get("images") or []
    if not isinstance(raw, list) or len(raw) > VIDEO_MAX_IMAGES:
        raise ApiError(400, "too_many_images", f"图片最多 {VIDEO_MAX_IMAGES} 张")
    out, seen = [], set()
    for it in raw:
        it = it if isinstance(it, dict) else {}
        desc = re.sub(r"\s+", " ", str(it.get("desc") or "")).strip()
        if not desc:
            raise ApiError(400, "empty_image_desc", "每张图片都要写一句描述：这是什么、想在片子里怎么用")
        if len(desc) > IMAGE_DESC_MAX:
            raise ApiError(400, "image_desc_too_long", f"图片的描述每张不超过 {IMAGE_DESC_MAX} 个字")
        if it.get("kind") == "library":
            fid = str(it.get("fileId") or "")
            if not re.fullmatch(r"f-[0-9a-f-]{36}", fid):
                raise ApiError(400, "bad_library_file", "素材库里的图片编号不对，请重新选择")
            x = {"kind": "library", "fileId": fid}
        elif it.get("kind") == "file":
            uid = str(it.get("uploadId") or "")
            name = _s(it.get("name"), 120)
            if not re.fullmatch(UPLOAD_RE, uid):
                raise ApiError(400, "bad_upload", "图片的上传记录不对，请重新上传")
            if name and not name.lower().endswith(IMAGE_EXT):
                raise ApiError(400, "bad_image_type", f"图片只支持 png、jpg、webp：{name[:40]}")
            x = {"kind": "file", "uploadId": uid, "name": name}
        else:
            raise ApiError(400, "bad_image", "图片的类型不对")
        k = x.get("fileId") or x["uploadId"]
        if k in seen:
            continue
        seen.add(k)
        out.append({**x, "desc": desc})
    for i, x in enumerate(out, 1):
        x["id"] = f"i{i:02d}"
    return out


def flow_id(body):
    """建任务时带的画板编号（工作流模式）；没有时返回 None"""
    flow = body.get("flow")
    if flow is None:
        return None
    if not re.fullmatch(r"[0-9a-f-]{36}", str(flow)):
        raise ApiError(400, "bad_flow", "画板编号不对，请刷新页面再试")
    return str(flow)


def model_request(body):
    """3D 图片任务：一段描述，加 0～4 张同一物体不同角度的照片；联网搜索默认开（查具体型号的尺寸、配色、材质）"""
    desc = _s(body.get("description"), 2000)
    if not desc:
        raise ApiError(400, "empty_description", "先写一段描述，说清楚要做一个什么样的物体")
    images = list(dict.fromkeys(str(u) for u in body.get("images") or []))
    if len(images) > MODEL_MAX_IMAGES:
        raise ApiError(400, "too_many_images", f"照片最多 {MODEL_MAX_IMAGES} 张")
    if any(not re.fullmatch(UPLOAD_RE, u) for u in images):
        raise ApiError(400, "bad_upload", "照片的上传记录不对，请重新上传")
    flow = flow_id(body)
    return {"product": "model3d", "mode": "quick", "web_search": _b(body.get("web_search", True)), "explode": _b(body.get("explode")),
            "description": desc, "images": images, **({"flow": flow} if flow else {})}


def _refs(body):
    """参考资料：内部资料（文件、粘贴的文字）和外部资料（链接、联网搜索），以及强制引用开关。两种模式都可以带"""
    r = body.get("refs") or {}
    web = _b(r.get("web", body.get("web_search", True)))
    items = []
    for it in (r.get("items") or [])[:REF_MAX_ITEMS]:
        kind, note = it.get("kind"), _s(it.get("note"), 200)
        if kind == "library":  # 素材库里的文件：建任务时复制进来，和上传的文件一样处理
            fid = str(it.get("fileId") or "")
            if not re.fullmatch(r"f-[0-9a-f-]{36}", fid):
                raise ApiError(400, "bad_library_file", "素材库里的文件编号不对，请重新选择")
            items.append({"kind": "library", "fileId": fid, "note": note})
        elif kind == "file":
            uid = str(it.get("uploadId") or "")
            if not re.fullmatch(UPLOAD_RE, uid):
                raise ApiError(400, "bad_upload", "参考资料的上传记录不对，请重新上传")
            name = _s(it.get("name"), 120)
            if name and not name.lower().endswith(REF_EXT):
                raise ApiError(400, "bad_ref_type", f"参考资料只支持 {'、'.join(e[1:] for e in REF_EXT)}：{name[:40]}")
            items.append({"kind": "file", "uploadId": uid, "name": name, "note": note})
        elif kind == "text":
            text = str(it.get("text") or "").strip()
            if not text:
                continue
            if len(text) > REF_MAX_TEXT:
                raise ApiError(400, "ref_text_too_long", f"粘贴的文字每段不超过 {REF_MAX_TEXT} 字")
            items.append({"kind": "text", "title": _s(it.get("title"), 60) or "粘贴的文字", "text": text, "note": note})
        elif kind == "link":
            url = _s(it.get("url"), 500)
            if not re.match(r"^https?://[^\s]+$", url):
                raise ApiError(400, "bad_ref_link", f"链接地址不对：{url[:60]}")
            items.append({"kind": "link", "url": url, "note": note})
        else:
            raise ApiError(400, "bad_ref", "参考资料的类型不对")
    if sum(1 for x in items if x["kind"] == "link") > REF_MAX_LINKS:
        raise ApiError(400, "too_many_links", f"链接最多 {REF_MAX_LINKS} 个")
    for i, x in enumerate(items, 1):
        x["id"] = f"r{i:02d}"
    # 强制引用只针对用户给的资料：一份资料都没有时不生效（只开联网搜索不算）
    return {"web": web, "strict": _b(r.get("strict")) and bool(items), "items": items}


def _voice_id(v):
    """音色：目录里的 id，或 auto（由 Agent 按内容挑）"""
    from .common import voices
    return v if v in {x["id"] for x in voices()} else "auto"


def agent_brief(task):
    """给 Agent 的任务说明（第一条消息）。"""
    r = task["request"]
    if r.get("product") == "style":
        # 风格创建（只在管理端）：参考视频由 admin Lambda 放在 input/ref/ 下；Skill 写在 style/<id>/
        # 一段参考视频可以同时产出画风和写作方法（docs/skills-two-dimensions.md），outputs 列出这次要哪几种
        st, wr = r.get("style"), r.get("writing")
        outputs = r.get("outputs") or ["visual"]
        out = {"kind": "slate.style", "version": 1, "outputs": outputs, "reference": f"input/ref/{r['source']}", "workdir": "/root/task"}
        if st:
            out.update(style={k: st.get(k) for k in ("id", "name", "cat", "notes")}, skill_dir=f"style/{st['id']}/")
        if wr:
            out.update(writing={k: wr.get(k) for k in ("id", "name", "group", "notes")}, writing_dir=f"writing/{wr['id']}/")
        return out
    if r.get("product") == "model3d":
        # 参考照片由 api Lambda 放在 input/images/ 下，按上传顺序编号
        return {"kind": "slate.model3d", "version": 1, "user_content": {"description": r["description"]}, "web_search": r.get("web_search", False),
                "explode": r.get("explode", False),
                "images": [x["file"] for x in r.get("imageFiles") or []], "workdir": "/root/task"}
    o = r["options"]
    return {
        "kind": "slate.task", "version": 1, "mode": r["mode"], "web_search": r["web_search"],
        "genre": genre_brief(r.get("genre"), r.get("writingRef")),
        # 参考资料：目录在 input/refs/index.json（开工前由系统生成）；strict 为 true 时强制引用
        "references": ({"strict": r["refs"]["strict"], "web": r["refs"]["web"], "count": len(r["refs"]["items"]), "index": "input/refs/index.json"}
                       if r.get("refs") else None),
        "user_content": {"description": r["description"], "outline": o["script"].get("outline", "")},
        "options": {
            "script": {"enabled": o["script"]["enabled"], "verbatim": o["script"]["verbatim"], "files": o["script"].get("files", [])},
            "assets": {"enabled": o["assets"]["enabled"], "force": o["assets"]["force"], "files": o["assets"].get("files", []),
                       "sites": o["assets"]["sites"]},
            # 管理员生成的风格（docs/style-creator-design.md）：文件已经放进 input/styles/<id>/，说明书路径在 guide
            "skills": {**o["skills"], **({"generated": [{"id": x["id"], "name": x["name"], "guide": f"input/styles/{x['id']}/SKILL.md"}
                                                         for x in r["styleRefs"]]} if r.get("styleRefs") else {})},
            "spec": o["spec"],
            "confirm_storyboard": o["confirm_storyboard"],
        },
        # 长片按章节并行制作（做片手册第 10 节）：这一轮只写总纲
        "long_video": bool(o["spec"].get("enabled") and int(o["spec"].get("duration") or 0) > LONG_SECONDS),
        # 从素材库引用的 3D 图片（做片手册"3D 素材"一节）：模型文件和素材卡已经放进 input/models/<编号>/
        "models": [{"id": m["id"], "name": m["name"], "dir": f"input/models/{m['id']}/", "module": f"input/models/{m['id']}/model.js",
                    "factory": m["factory"], "card": f"input/models/{m['id']}/asset.json"} for m in r.get("modelRefs") or []] or None,
        # 用户给的普通图片（做片手册"图片"一节）：开工前整理好放在 input/images/，目录里有每张的描述
        "images": {"count": len(r["images"]), "index": "input/images/index.json"} if r.get("images") else None,
        # 工作流模式（做片手册第 11 节）：文字节点和音画节点分开运行、分开修改
        **({"flow": True} if r.get("flow") else {}),
        "workdir": "/root/task",
    }


def genre_id_of(name):
    from .common import genres
    return next((g["id"] for g in genres() if g["name"] == name), None)


def genre_name(r):
    """任务选的写作方法的中文名：内置的查目录，生成的用建任务时复制进来的那一版"""
    gid = (r or {}).get("genre")
    ref = (r or {}).get("writingRef")
    if ref and gid and ref.get("id") == gid:
        return ref["name"]
    g = genre_of(gid) if gid else None
    return g["name"] if g else None


def genre_brief(gid, ref=None):
    """用户选的写作方法：{id, name, guide}，没选时为 None（由 Agent 判断）。
    内置的说明在做片手册里；管理员生成的（ref 是建任务时复制进来的那一版）在任务目录的 input/writing/<id>/，另带所属的一类"""
    if ref and gid and ref.get("id") == gid:
        return {"id": gid, "name": ref["name"], "guide": f"input/writing/{gid}/SKILL.md", "group": ref.get("group") or "讲解", "generated": True}
    g = genre_of(gid) if gid else None
    return {"id": g["id"], "name": g["name"], "guide": f"/.agents/skills/core-director/genres/{g['id']}.md"} if g else None


def chapter_brief(task, ch):
    """章节会话的任务说明：全片背景 + 这一章的讲稿（以服务端存的总纲为准，用户确认时可能改过）"""
    outline = (task.get("docs") or {}).get("outline") or {}
    chs = outline.get("chapters") or []
    i = next((k for k, x in enumerate(chs) if x["id"] == ch), None)
    if i is None:
        raise ApiError(400, "no_chapter", f"总纲里没有第 {ch} 章")
    me = chs[i]
    return {
        "kind": "slate.chapter", "version": 1, "chapter": me, "of": len(chs),
        "previous": {k: chs[i - 1][k] for k in ("id", "title", "closing") if k in chs[i - 1]} if i > 0 else None,
        "next": {k: chs[i + 1][k] for k in ("id", "title", "opening") if k in chs[i + 1]} if i + 1 < len(chs) else None,
        "look": outline.get("look"), "voice": outline.get("voice"), "title": outline.get("title"),
        "task": {**(b := agent_brief(task)), "options": {**b["options"], "confirm_storyboard": False},  # 总纲已确认，各章不再停下确认分镜
                 "genre": b["genre"] or genre_brief(genre_id_of(((task.get("docs") or {}).get("brief") or {}).get("kind")))},  # 用户没选时用主会话定的写法
        "workdir": "/root/task",
    }
