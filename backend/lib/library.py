"""素材库（docs/library-3d-design.md）：每个用户自己的视频、3D 图片和文件。

- 视频、3D 图片：就是完成了的任务，不另存文件。改名、标签、"从素材库移除"记在任务记录上（libName、libTags、libHidden），
  任务本身不受影响，任务列表里照样看得到。
- 文件：作为参考资料上传过的文件，建任务时自动进库。记录是 pk=LIB#<用户>、sk=FILE#<编号>，
  文件放在 u/<用户>/lib/<编号>/<文件名>，按文件名加内容（ETag）去重，每人最多 MAX_FILES 个。
- 图片（docs/image-refs-design.md）：视频里用过的普通图片，和文件存在一起（type=image），多一个用户写的描述 desc。
"""
import re

from boto3.dynamodb.conditions import Key

from . import common as c

# 模型代码会在用户浏览器的 3D 预览里执行，只能建模，不能碰网络、存储、页面和全局对象（document 只能用来建 canvas）。
# 这是第一道关；真正兜底的是网站的内容安全策略（只允许连本站接口）。同一条规则在 agent/image/slate/model3d.py 也有一份
UNSAFE_RE = re.compile(r"(?<![\w$.'\"`-])(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|cookie"
                       r"|eval|Function|importScripts|postMessage|Worker|navigator|location|globalThis|window|self|innerHTML|outerHTML"
                       r"|insertAdjacentHTML|setTimeout|setInterval|ownerDocument|defaultView|Image|Audio|document)\b(?![-'\"`])"
                       r"|\.(?:constructor|ownerDocument|defaultView)\b|\[\s*['\"`]constructor|\bimport\s*\(")
CANVAS_RE = re.compile(r"\bdocument\.createElement\(\s*(['\"])canvas\1\s*\)|\btypeof\s+document\b")  # 允许的 document 用法：建 canvas、判断有没有页面
MAX_MODULE_BYTES = 1 << 20  # 模型代码的大小上限：正常 15～30 KB


def unsafe(code):
    """返回第一处不允许的写法 (行号, 原文)，没有时返回 None。
    直接查原始代码，注释、字符串里出现也算：先剥掉注释和字符串再查的做法，判断 / 是除号还是正则时总有歧义，
    攻击者能借此让会执行的代码被当成注释或正则抹掉（增量安全扫描 #1、#2）。正常的模型代码用不到这些词"""
    bare = CANVAS_RE.sub("__canvas__()", code)
    hit = UNSAFE_RE.search(bare)
    return (bare[:hit.start()].count("\n") + 1, hit.group(0)) if hit else None
MAX_FILES = 200
KINDS = ("video", "model3d", "file", "image")
STORED = ("file", "image")  # 存在素材库里的（另外两类就是任务本身）
ANGLES = (0, 90, 180, 270, 35)


def _files(sub):
    out, kw = [], dict(KeyConditionExpression=Key("pk").eq(f"LIB#{sub}") & Key("sk").begins_with("FILE#"))
    while True:
        r = c.table().query(**kw)
        out += [c.plain(i) for i in r.get("Items", [])]
        if "LastEvaluatedKey" not in r:
            return out
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def get_file(sub, fid):
    it = c.table().get_item(Key={"pk": f"LIB#{sub}", "sk": f"FILE#{fid}"}).get("Item")
    return c.plain(it) if it else None


def add_file(sub, src_key, name, size, etag, kind="file", desc=None):
    """上传过的参考资料文件、图片进库；同名同内容的已经在库里就不再存（图片换成这次写的描述）。库满了不报错，只是不再收"""
    have = _files(sub)
    for f in have:
        if f["name"] == name and f.get("etag") == etag and (f.get("type") or "file") == kind:
            if desc and f.get("desc") != desc:
                c.table().update_item(Key={"pk": f"LIB#{sub}", "sk": f"FILE#{f['id']}"}, UpdateExpression="SET #d = :d, updatedAt = :t",
                                      ExpressionAttributeNames={"#d": "desc"}, ExpressionAttributeValues={":d": desc, ":t": c.now_ms()})
            return f["id"]
    if len(have) >= MAX_FILES:
        return None
    fid = "f-" + c.new_id()
    key = f"u/{sub}/lib/{fid}/{c.safe_name(name) or 'file'}"
    c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=key, CopySource={"Bucket": c.DATA_BUCKET, "Key": src_key})
    now = c.now_ms()
    c.table().put_item(Item=c.ddb_safe({"pk": f"LIB#{sub}", "sk": f"FILE#{fid}", "id": fid, "name": name, "tags": [], "size": size,
                                        "etag": etag, "key": key, "createdAt": now, "updatedAt": now,
                                        **({"type": "image", "desc": desc or ""} if kind == "image" else {})}))
    return fid


def latest_model(task):
    vs = task.get("models") or []
    return vs[-1] if vs else None


def model_view(m):
    """一个 3D 版本 → 前端用的链接（多角度图、转台、对比图、GLB 下载）"""
    f = m["files"]
    return {"n": m["n"], "at": m.get("at"),
            "views": [{"angle": a, "url": c.media_url(f["views"][str(a)])} for a in ANGLES if str(a) in f.get("views", {})],
            "comparison": c.media_url(f["comparison"]) if f.get("comparison") else None,
            "glb": c.media_url(f["glb"], download_name=f"model-v{m['n']}.glb") if f.get("glb") else None,
            # 拆解：带零件标注的拆解图和 GIF 动图（3D 图片只出图片和文件，不出视频）
            "explode": {"gif": c.media_url(f["explodeGif"], download_name=f"explode-v{m['n']}.gif"), "image": c.media_url(f["exploded"])}
                       if f.get("explodeGif") and f.get("exploded") else None,
            "printable": bool(f.get("printSrc"))}


def name_of(task):
    asset = (task.get("docs") or {}).get("asset") or {}
    brief = (task.get("docs") or {}).get("brief") or {}
    return task.get("libName") or asset.get("name") or brief.get("title") or task.get("title") or "未命名"


def asset_of(task):
    """素材卡：用户在素材库里改过的名称和标签优先"""
    asset = (task.get("docs") or {}).get("asset")
    if not asset:
        return None
    steps = (latest_model(task) or {}).get("steps") or []  # 拆解步骤以最新一版模型里的为准
    return {**asset, "name": name_of(task), "tags": _tags(task), "explode": {"steps": steps} if steps else None}


def _tags(task):
    if task.get("libTags") is not None:
        return task["libTags"]
    return list(((task.get("docs") or {}).get("asset") or {}).get("tags") or [])


def video_item(t):
    title = name_of(t)
    br = (t.get("docs") or {}).get("brief") or {}
    return {"id": t["id"], "kind": "video", "name": title, "tags": _tags(t), "createdAt": t.get("createdAt"), "updatedAt": t.get("updatedAt"),
            "thumb": (br.get("skills") or [None])[0],
            "versions": [{"n": v["n"], "url": c.media_url(v["key"]), "download": c.media_url(v["key"], download_name=f"{title}-第{v['n']}版.mp4"),
                          "dur": v.get("dur")} for v in t.get("versions") or []]}


def model_item(t):
    m = latest_model(t)
    asset = (t.get("docs") or {}).get("asset") or {}
    v = model_view(m)
    return {"id": t["id"], "kind": "model3d", "name": name_of(t), "tags": _tags(t), "summary": asset.get("summary", ""),
            "createdAt": t.get("createdAt"), "updatedAt": t.get("updatedAt"), "version": m["n"],
            "views": v["views"], "glb": v["glb"], "parts": asset.get("parts") or [],
            "explode": bool(v["explode"]), "printable": v["printable"]}


def file_item(f):
    if f.get("type") == "image":
        return image_item(f)
    return {"id": f["id"], "kind": "file", "name": f["name"], "tags": f.get("tags") or [], "size": f.get("size"),
            "createdAt": f.get("createdAt"), "updatedAt": f.get("updatedAt"), "download": c.media_url(f["key"], download_name=f["name"])}


def image_item(f):
    return {"id": f["id"], "kind": "image", "name": f["name"], "desc": f.get("desc") or "", "tags": f.get("tags") or [], "size": f.get("size"),
            "createdAt": f.get("createdAt"), "updatedAt": f.get("updatedAt"), "url": c.media_url(f["key"]),
            "download": c.media_url(f["key"], download_name=f["name"])}


def is_kind(f, kind):
    return (f.get("type") or "file") == kind


def in_library(t, kind):
    if t.get("libHidden") or c.product_of(t) != kind:
        return False
    return bool(t.get("versions")) if kind == "video" else bool(t.get("models"))


def list_items(sub, kind, q=""):
    if kind not in KINDS:
        raise c.ApiError(400, "bad_kind", "素材的类别不对")
    if kind in STORED:
        items = [file_item(f) for f in _files(sub) if is_kind(f, kind)]
    else:
        make = video_item if kind == "video" else model_item
        items = [make(t) for t in c.tasks_of(sub, limit=500) if in_library(t, kind)]
    q = (q or "").strip().lower()
    if q:
        items = [x for x in items if q in x["name"].lower() or q in (x.get("desc") or "").lower() or any(q in str(g).lower() for g in x["tags"])]
    return sorted(items, key=lambda x: int(x.get("updatedAt") or 0), reverse=True)


def _clean(body):
    out = {}
    if "name" in body:
        name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:60]
        if not name:
            raise c.ApiError(400, "empty_name", "名称不能为空")
        if re.search(r"[/\\\x00-\x1f\x7f]", name) or not name.strip("."):  # 文件名会拼进任务里的文件路径
            raise c.ApiError(400, "bad_name", "名称里不能有 / 或 \\")
        out["name"] = name
    if "tags" in body:
        tags = [re.sub(r"\s+", " ", str(x)).strip()[:20] for x in (body.get("tags") or [])]
        out["tags"] = list(dict.fromkeys(x for x in tags if x))[:10]
    if "desc" in body:  # 图片的描述：下次在新视频里选这张图时带出来
        desc = re.sub(r"\s+", " ", str(body.get("desc") or "")).strip()
        if not desc:
            raise c.ApiError(400, "empty_image_desc", "图片的描述不能为空：这是什么、想在片子里怎么用")
        out["desc"] = desc[:200]
    return out


def _owned_task(sub, kind, tid):
    t = c.get_task(tid) if re.fullmatch(r"[0-9a-f-]{36}", tid or "") else None
    if not t or t.get("sub") != sub or not in_library(t, kind):
        raise c.ApiError(404, "not_found", "素材库里没有这一项")
    return t


def update(sub, kind, item_id, body):
    ch = _clean(body)
    if kind in STORED:
        f = get_file(sub, item_id)
        if not f or not is_kind(f, kind):
            raise c.ApiError(404, "not_found", "素材库里没有这个文件")
        if kind == "file":
            ch.pop("desc", None)
        f.update(ch, updatedAt=c.now_ms())
        c.table().put_item(Item=c.ddb_safe({**f, "pk": f"LIB#{sub}", "sk": f"FILE#{item_id}"}))
        return file_item(f)
    if kind not in KINDS:
        raise c.ApiError(400, "bad_kind", "素材的类别不对")
    t = _owned_task(sub, kind, item_id)
    fields = {**({"libName": ch["name"]} if "name" in ch else {}), **({"libTags": ch["tags"]} if "tags" in ch else {})}
    if fields:
        c.set_fields(t["id"], **fields)
    t = c.get_task(t["id"])
    return video_item(t) if kind == "video" else model_item(t)


def remove(sub, kind, item_id):
    if kind in STORED:
        f = get_file(sub, item_id)
        if not f or not is_kind(f, kind):
            raise c.ApiError(404, "not_found", "素材库里没有这个文件")
        c.s3.delete_object(Bucket=c.DATA_BUCKET, Key=f["key"])
        c.table().delete_item(Key={"pk": f"LIB#{sub}", "sk": f"FILE#{item_id}"})
        return {"ok": True}
    if kind not in KINDS:
        raise c.ApiError(400, "bad_kind", "素材的类别不对")
    t = _owned_task(sub, kind, item_id)
    c.set_fields(t["id"], libHidden=True)
    return {"ok": True}
