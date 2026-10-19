"""api Lambda：API Gateway（Cognito 授权）后面的全部 REST 接口，契约见 docs/api.md。"""
import datetime, json, os, re, time, traceback

import boto3

from lib import common as c
from lib.views import detail_view, list_view
from lib import billing
from lib import chapters as chs
from lib import flows
from lib import library
from lib import styles
from lib import validate

from lib.common import ApiError, start_turn



def resp(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                                               "Access-Control-Allow-Origin": "*"},
            "body": c.json_dumps(body)}


_live = {}  # 用户名 → (查询时间, 账号是否仍然可用)
_cog = None


def _still_active(claims):
    """令牌是签发那一刻的：停用、重置密码以后，旧令牌最多还能用 1 小时。所以每个请求再向用户池确认一次（缓存 60 秒）。
    用户池本身出错（限流等）时放行，不因为它让整站不可用"""
    global _cog
    name = claims.get("cognito:username") or claims["sub"]
    at, ok = _live.get(name, (0, True))
    if time.time() - at < 60:
        return ok
    pool = os.environ.get("USER_POOL_ID")
    if not pool:
        return True
    try:
        _cog = _cog or boto3.client("cognito-idp", region_name=c.REGION)
        u = _cog.admin_get_user(UserPoolId=pool, Username=name)
        ok = bool(u.get("Enabled")) and u.get("UserStatus") not in ("FORCE_CHANGE_PASSWORD", "RESET_REQUIRED") and \
            any(a["Name"] == "sub" and a["Value"] == claims["sub"] for a in u.get("UserAttributes") or [])
    except Exception as e:
        if "UserNotFoundException" not in repr(e):
            traceback.print_exc(); return True
        ok = False
    _live[name] = (time.time(), ok)
    return ok


def handler(event, context):
    try:
        claims = (event.get("requestContext", {}).get("authorizer") or {}).get("claims") or {}
        sub = claims.get("sub")
        if not sub or not _still_active(claims):
            raise ApiError(401, "unauthorized", "请先登录")
        # 管理员（admin 组）在用户端和普通用户一样，只多看到内测中的生成风格
        user = {"sub": sub, "email": claims.get("email", ""), "admin": "admin" in re.findall(r"[\w-]+", str(claims.get("cognito:groups") or ""))}
        method = event.get("httpMethod", "GET")
        path = re.sub(r"^/api", "", event.get("path", "")) or "/"
        body = json.loads(event["body"]) if event.get("body") else {}
        qs = event.get("queryStringParameters") or {}
        return route(method, path, body, qs, user)
    except ApiError as e:
        return resp(e.status, {"error": e.code, "message": e.message})
    except json.JSONDecodeError:
        return resp(400, {"error": "bad_json", "message": "请求格式不对"})
    except Exception:
        traceback.print_exc()
        return resp(500, {"error": "internal", "message": "服务出了点问题，请稍后再试"})


def route(method, path, body, qs, user):
    if method == "GET" and path == "/me":
        return resp(200, me(user))
    if method == "GET" and path == "/skills":
        admin = user.get("admin", False)  # 画风在 items，写作方法在 genres；生成的跟在内置的后面（公开的所有人可见，内测的只有管理员可见）
        return resp(200, {"items": c.catalog() + styles.catalog_items(admin), "genres": c.genres() + styles.writing_items(admin)})
    if method == "GET" and path == "/voices":
        return resp(200, {"items": c.voices()})
    if method == "GET" and path == "/usage":
        return resp(200, my_usage(user, qs))
    if method == "POST" and path == "/uploads":
        return resp(200, create_upload(user, body))
    if method == "POST" and path == "/tasks":
        return resp(201, create_task(user, body))
    if method == "GET" and path == "/tasks":
        return resp(200, {"items": list_view(c.tasks_of(user["sub"]), qs.get("status", "all"))})
    if method == "GET" and path == "/flows":
        return resp(200, {"items": flows.list_of(user["sub"])})
    if method == "POST" and path == "/flows":
        return resp(201, flows.create(user["sub"], body))
    m = re.fullmatch(r"/flows/([0-9a-f-]{36})", path)
    if m and method == "GET":
        return resp(200, flows.view(user["sub"], m.group(1)))
    if m and method == "PATCH":
        return resp(200, flows.update(user["sub"], m.group(1), body))
    if m and method == "DELETE":
        return resp(200, flows.remove(user["sub"], m.group(1)))
    if method == "GET" and path == "/library":
        return resp(200, {"items": library.list_items(user["sub"], qs.get("kind", "video"), qs.get("q", ""))})
    m = re.fullmatch(r"/library/(video|model3d|file|image)/((?:f-)?[0-9a-f-]{36})", path)
    if m and method == "PATCH":
        return resp(200, library.update(user["sub"], m.group(1), m.group(2), body))
    if m and method == "DELETE":
        return resp(200, library.remove(user["sub"], m.group(1), m.group(2)))
    m = re.fullmatch(r"/tasks/([0-9a-f-]{36})(/[a-z]+)?", path)
    if m:
        task = owned(m.group(1), user)
        action = m.group(2)
        if method == "GET" and not action:
            return resp(200, detail_view(task, c.messages(task["id"])))
        if method == "POST" and action == "/confirm":
            return resp(200, confirm(task, body))
        if method == "POST" and action == "/messages":
            return resp(200, send_message(task, body))
        if method == "POST" and action == "/av":
            return resp(200, flow_av(task, body, user))
        if method == "POST" and action == "/retry":
            return resp(200, retry(task))
        if method == "GET" and action == "/usage":
            return usage_resp(task, qs)
        if method == "GET" and action == "/module":
            return resp(200, model_module(task, qs.get("v")))
        if method == "POST" and action == "/print":
            return resp(200, print_file(task, body))
    raise ApiError(404, "not_found", "没有这个接口")


def model_module(task, v):
    """3D 任务某一版的模型代码，给前端的 3D 预览用（前端转成 Blob 再 import）"""
    vs = task.get("models") or []
    m = next((x for x in vs if str(x["n"]) == str(v)), None) if v else (vs[-1] if vs else None)
    if not m:
        raise ApiError(404, "not_found", "这个 3D 图片还没有成品")
    obj = c.s3.get_object(Bucket=c.DATA_BUCKET, Key=m["files"]["module"])
    if obj["ContentLength"] > library.MAX_MODULE_BYTES:
        raise ApiError(422, "unsafe_model", "这个 3D 图片的模型代码太大，暂时不能预览")
    code = obj["Body"].read().decode("utf-8")
    if library.unsafe(code):  # 会话导出时已经查过；这里再查一遍，不给浏览器执行可疑代码
        raise ApiError(422, "unsafe_model", "这个 3D 图片的模型代码没有通过安全检查，暂时不能预览")
    factory = ((task.get("docs") or {}).get("asset") or {}).get("factory")
    if not factory:
        hit = re.search(r"export\s+function\s+(create\w+)", code)
        factory = hit.group(1) if hit else None
    return {"code": code, "factory": factory}


PRINT_TYPES = {"3mf": "application/vnd.ms-package.3dmanufacturing-3dmodel+xml", "stl": "model/stl", "zip": "application/zip"}


def print_file(task, body):
    """按机型、高度、出法、颜色数生成 3D 打印文件（docs/library-3d-design.md 第六节），返回下载链接和报告"""
    from lib import printfile
    vs = task.get("models") or []
    v = body.get("v")
    m = next((x for x in vs if str(x["n"]) == str(v)), None) if v else (vs[-1] if vs else None)
    if not m or not m["files"].get("printSrc"):
        raise ApiError(400, "not_printable", "这一版没有 3D 打印数据，在对话里让 Agent 重新导出一版")
    printer, mode, fmt = body.get("printer", "a1"), body.get("mode", "whole"), body.get("format", "3mf")
    if printer not in printfile.PRINTERS or mode not in ("whole", "parts") or fmt not in ("3mf", "stl"):
        raise ApiError(400, "bad_print_options", "机型、出法或格式不对")
    try:
        height, colors = float(body.get("height", 120)), int(body.get("colors", 4))
    except (TypeError, ValueError):
        raise ApiError(400, "bad_print_options", "高度和颜色数要填数字")
    if colors not in (1, 4, 8, 16):
        raise ApiError(400, "bad_print_options", "颜色数只能是 1、4、8 或 16")
    asset = library.asset_of(task) or {}
    names = {p["id"]: p.get("name") or p["id"] for p in asset.get("parts") or []}
    obj = c.s3.get_object(Bucket=c.DATA_BUCKET, Key=m["files"]["printSrc"])
    if obj["ContentLength"] > 32 << 20:
        raise ApiError(422, "print_too_large", "这个 3D 图片的打印源文件太大，没法导出")
    try:
        src = printfile.loads(obj["Body"].read())
    except ValueError as e:
        raise ApiError(422, "print_too_large", f"没法导出打印文件：{e}")
    rest = [p["id"] for p in src["parts"] if p["id"] not in names]
    if len(rest) == 1:  # 素材卡只列能动的零件，剩下的那一块就是不动的主体（比如缸体）
        names[rest[0]] = "主体"
    try:
        data, fname, report = printfile.build(src, printer, height, mode, colors if fmt == "3mf" else 1, fmt, names)
    except ValueError as e:
        raise ApiError(400, "print_failed", str(e))
    ext = fname.rsplit(".", 1)[-1]
    key = f"{c.prefix(task['sub'], task['id'])}/print/v{m['n']}-{printer}-{height:g}mm-{mode}-{colors}c.{ext}"
    c.s3.put_object(Bucket=c.DATA_BUCKET, Key=key, Body=data, ContentType=PRINT_TYPES[ext])
    name = f"{asset.get('name') or task.get('title') or '模型'}-{height:g}mm-{'整体' if mode == 'whole' else '零件分开'}.{ext}"
    return {"download": c.media_url(key, download_name=name), "file": name, "report": report}


def owned(task_id, user):
    t = c.get_task(task_id)
    if not t or t.get("sub") != user["sub"] or c.product_of(t) == "style":  # 风格创建任务只在管理端
        raise ApiError(404, "not_found", "找不到这个任务")
    return t


# ---------- 额度 ----------

def _today():
    return datetime.datetime.utcnow().strftime("%Y-%m-%d")


def quota(sub):
    items = c.tasks_of(sub, limit=200)
    running = sum(1 for t in items if t.get("status") in ("queued", "running"))
    q = c.table().get_item(Key={"pk": f"QUOTA#{sub}#{_today()}", "sk": "META"}).get("Item") or {}
    return {"running": running, "runningLimit": c.RUNNING_LIMIT, "today": int(q.get("n", 0)), "dailyLimit": c.DAILY_LIMIT}


def take_daily(sub):
    from botocore.exceptions import ClientError
    try:
        c.table().update_item(Key={"pk": f"QUOTA#{sub}#{_today()}", "sk": "META"}, UpdateExpression="ADD n :one",
                              ConditionExpression="attribute_not_exists(n) OR n < :lim",
                              ExpressionAttributeValues={":one": 1, ":lim": c.DAILY_LIMIT})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ApiError(429, "daily_limit", f"今天已经创建了 {c.DAILY_LIMIT} 个任务，明天再来吧")
        raise


def me(user):
    return {**user, "quota": quota(user["sub"]), "credits": billing.summary(user["sub"])}


# ---------- 用量 ----------

def my_usage(user, qs):
    d0, d1 = billing.date_range(qs)
    days = billing.days_of(user["sub"], d0, d1)
    lo, hi = billing.day_start_ms(d0), billing.day_start_ms(d1) + 86400000
    tasks = [{"id": t["id"], "title": ((t.get("docs") or {}).get("brief") or {}).get("title") or t.get("title"),
              "credits": round(float(t.get("credits") or 0), 2), "createdAt": t.get("createdAt"), "status": t.get("status")}
             for t in c.tasks_of(user["sub"], limit=500) if lo <= int(t.get("createdAt") or 0) < hi]
    return {"from": d0, "to": d1, "total": round(sum(days.values()), 2), "days": billing.day_list(d0, d1, days),
            "tasks": [t for t in tasks if t["credits"] > 0 or t["status"] in ("running", "queued")], "month": billing.summary(user["sub"])}


def usage_resp(task, qs):
    """一个任务的用量明细；?format=csv 导出"""
    if qs.get("format") == "csv":
        return {"statusCode": 200, "headers": {"Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
                                               "Content-Disposition": f"attachment; filename=\"usage-{task['id'][:8]}.csv\""},
                "body": billing.usage_csv(task["id"])}
    rows, total = billing.usage_rows(task["id"])
    return resp(200, {"items": rows, "total": total})


# ---------- 上传 ----------

UPLOAD_TYPES = {".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def create_upload(user, body):
    name = c.safe_name(body.get("filename"), 121)
    if not name or len(name) > 120:
        raise ApiError(400, "bad_filename", "文件名不对")
    size = int(body.get("size") or 0)
    if size <= 0:
        raise ApiError(400, "empty_file", "文件是空的")
    if body.get("purpose") == "image":  # 3D 图片任务的参考照片
        _check_image(name, size)
    else:  # 参考资料：只收文字类文件，每个不超过 1 MB
        _check_ref(name, size)
    ctype = UPLOAD_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")  # 按扩展名定，不用浏览器报的类型
    uid = "u-" + c.new_id()
    key = f"u/{user['sub']}/uploads/{uid}/{name}"
    # 签名带上文件大小：传上来的大小不一样，S3 直接拒收
    url = c.s3.generate_presigned_url("put_object", Params={"Bucket": c.DATA_BUCKET, "Key": key, "ContentType": ctype, "ContentLength": size},
                                      ExpiresIn=900)
    return {"uploadId": uid, "url": url, "headers": {"Content-Type": ctype}}


def _check_ref(name, size):
    if not name.lower().endswith(validate.REF_EXT):
        raise ApiError(400, "bad_ref_type", f"参考资料只支持 {'、'.join(e[1:] for e in validate.REF_EXT)}：{name[:40]}")
    if size > validate.REF_MAX_BYTES:
        raise ApiError(400, "ref_too_large", f"参考资料每个文件不超过 1 MB：{name[:40]}")


def _check_image(name, size):
    if not name.lower().endswith(validate.IMAGE_EXT):
        raise ApiError(400, "bad_image_type", f"照片只支持 png、jpg、webp：{name[:40]}")
    if size > validate.IMAGE_MAX_BYTES:
        raise ApiError(400, "image_too_large", f"照片每张不超过 10 MB：{name[:40]}")


def _upload_obj(sub, uid, what="参考资料"):
    """找到用户上传的文件，返回 (S3 键, 文件名, 大小, ETag)；还没上传完成时报错"""
    if not re.fullmatch(r"u-[0-9a-f-]{36}", uid or ""):
        raise ApiError(400, "bad_upload", "上传记录不对，请重新上传")
    pre = f"u/{sub}/uploads/{uid}/"
    objs = c.s3.list_objects_v2(Bucket=c.DATA_BUCKET, Prefix=pre).get("Contents", [])
    if not objs:
        raise ApiError(400, "upload_missing", f"有{what}还没上传完成，请稍等或重新上传")
    return objs[0]["Key"], objs[0]["Key"][len(pre):], objs[0]["Size"], objs[0].get("ETag", "").strip('"')


def _check_uploads(sub, req):
    """扣当天的次数之前，先确认上传的文件和引用的素材都在、格式和大小都对（预签名上传限制不了大小，这里按实际大小再查一遍）。
    返回 {上传编号或素材编号: (S3 键, 文件名, 大小, ETag)}"""
    found = {}
    if req["product"] == "model3d":
        for uid in req["images"]:
            _, name, size, _e = found[uid] = _upload_obj(sub, uid, "照片")
            _check_image(name, size)
        return found
    for x in req["refs"]["items"]:
        if x["kind"] == "file":
            _, name, size, _e = found[x["uploadId"]] = _upload_obj(sub, x["uploadId"])
            _check_ref(name, size)
        elif x["kind"] == "library":
            f = library.get_file(sub, x["fileId"])
            if not f:
                raise ApiError(400, "library_file_missing", "引用的素材库文件已经删除了，请重新选择")
            found[x["fileId"]] = (f["key"], f["name"], f.get("size") or 0, f.get("etag", ""))
    for x in req["images"]:
        if x["kind"] == "file":
            _, name, size, _e = found[x["uploadId"]] = _upload_obj(sub, x["uploadId"], "图片")
            _check_image(name, size)
        else:
            f = library.get_file(sub, x["fileId"])
            if not f or not library.is_kind(f, "image"):
                raise ApiError(400, "library_file_missing", "引用的素材库图片已经删除了，请重新选择")
            found[x["fileId"]] = (f["key"], f["name"], f.get("size") or 0, f.get("etag", ""))
    for tid in req["models"]:
        t = c.get_task(tid)
        if not t or t.get("sub") != sub or c.product_of(t) != "model3d" or not t.get("models"):
            raise ApiError(400, "model_missing", "引用的 3D 图片找不到了，请重新选择")
        found[tid] = t
    return found


def _save_models(sub, task_id, req, found):
    """引用的 3D 图片放进任务的 input/models/<编号>/：最新版的模型代码、素材卡和两张参考图（正面、斜侧）"""
    req["modelRefs"] = [_copy_model(sub, task_id, found[tid], f"m{i:02d}") for i, tid in enumerate(req["models"], 1)]


def _copy_model(sub, task_id, t, mid):
    """一个 3D 图片的最新版复制进任务的 input/models/<mid>/，返回 {id, taskId, version, name, factory}"""
    pre = c.prefix(sub, task_id)
    m = library.latest_model(t)
    f = m["files"]
    copies = [(f["module"], "model.js"), *[(f["views"][a], f"view-{a}.png") for a in ("0", "35") if a in f.get("views", {})]]
    if f.get("exploded"):
        copies.append((f["exploded"], "view-exploded.png"))  # 拆开的样子，带零件标注
    for src, name in copies:
        c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/input/models/{mid}/{name}", CopySource={"Bucket": c.DATA_BUCKET, "Key": src})
    asset = (t.get("docs") or {}).get("asset") or {}
    card = library.asset_of(t) or {"name": library.name_of(t)}  # 带上用户改过的名称、标签和最新一版的拆解步骤
    c.s3.put_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/input/models/{mid}/asset.json", ContentType="application/json",
                    Body=json.dumps(card, ensure_ascii=False, indent=1).encode())
    return {"id": mid, "taskId": t["id"], "version": m["n"], "name": card["name"], "factory": asset.get("factory") or "createModel"}


def _save_images(sub, task_id, req, found):
    """3D 任务的参考照片放进任务的 input/images/，按上传顺序编号"""
    pre = c.prefix(sub, task_id)
    files = []
    for i, uid in enumerate(req["images"], 1):
        key, name, size, _ = found[uid]
        rel = f"input/images/{i:02d}{os.path.splitext(name)[1].lower()}"
        c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/{rel}", CopySource={"Bucket": c.DATA_BUCKET, "Key": key})
        files.append({"file": rel, "name": name, "size": size})
    req["imageFiles"] = files
    req.pop("images")


def _save_pictures(sub, task_id, req, found):
    """视频里用的普通图片：原图放进任务的 input/images/orig/，写清单 manifest.json（编号、文件名、描述）。
    开工前会话里运行 slate-image index 整理图片、写目录。上传的图片带着描述进素材库"""
    if not req["images"]:
        return
    pre = c.prefix(sub, task_id)
    for x in req["images"]:
        key, name, size, etag = found[x.get("uploadId") or x["fileId"]]
        x.update(name=name, size=size, orig=f"input/images/orig/{x['id']}{os.path.splitext(name)[1].lower()}")
        c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/{x['orig']}", CopySource={"Bucket": c.DATA_BUCKET, "Key": key})
        if x["kind"] == "file":
            try:
                x["fileId"] = library.add_file(sub, key, name, size, etag, kind="image", desc=x["desc"])
            except Exception:
                traceback.print_exc()
        elif library.get_file(sub, x["fileId"]).get("desc") != x["desc"]:  # 选用时改了描述：素材库里也换成新的
            library.update(sub, "image", x["fileId"], {"desc": x["desc"]})
        x.pop("uploadId", None)
    c.s3.put_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/input/images/manifest.json", ContentType="application/json",
                    Body=json.dumps({"items": [{k: x.get(k) for k in ("id", "name", "desc", "orig")} for x in req["images"]]},
                                    ensure_ascii=False).encode())


def _save_refs(sub, task_id, refs, found):
    """参考资料放进任务的 input/refs/：文件复制过去，粘贴的文字写成文件（不存进任务记录），再写一份清单 manifest.json。
    开工前 turn Lambda 抓取链接、在会话里运行 slate-refs build 生成目录"""
    pre = c.prefix(sub, task_id)
    items = []
    for x in refs["items"]:
        rid = x["id"]
        if x["kind"] in ("file", "library"):
            key, name, size, etag = found[x.get("uploadId") or x["fileId"]]
            x.update(file=f"input/refs/files/{rid}-{c.safe_name(name) or 'file'}", title=name, source="素材库" if x["kind"] == "library" else name, size=size)
            c.s3.copy_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/{x['file']}", CopySource={"Bucket": c.DATA_BUCKET, "Key": key})
            if x["kind"] == "file":  # 上传的参考资料文件顺便进素材库，下次可以直接选
                try:
                    x["fileId"] = library.add_file(sub, key, name, size, etag)
                except Exception:
                    traceback.print_exc()
            x.pop("uploadId", None)
        elif x["kind"] == "text":
            x.update(file=f"input/refs/files/{rid}.md", source="粘贴的文字", chars=len(x["text"]))
            c.s3.put_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/{x['file']}", Body=x.pop("text").encode("utf-8"), ContentType="text/markdown")
        else:
            x.update(title=x["url"], source=x["url"])
        items.append({**{k: x.get(k) for k in ("id", "kind", "title", "note", "source", "file", "url")},
                      **({"kind": "file"} if x["kind"] == "library" else {})})
    if items:
        c.s3.put_object(Bucket=c.DATA_BUCKET, Key=f"{pre}/input/refs/manifest.json", ContentType="application/json",
                        Body=json.dumps({"web": refs["web"], "strict": refs["strict"], "items": items}, ensure_ascii=False).encode())


# ---------- 任务 ----------

def create_task(user, body):
    ids = ((body.get("options") or {}).get("skills") or {}).get("ids") or []
    builtin = {x["id"] for x in c.catalog()}
    admin = user.get("admin", False)
    # 选了内置目录以外的画风、写作方法时才去查生成的（公开的；管理员还有内测中的）
    generated = styles.visible(admin) if any(i not in builtin for i in ids) else {}
    gid = body.get("genre") or None
    writing = styles.visible(admin, "writing", user["sub"]) if gid and not c.genre_of(gid) else {}
    req = validate.task_request(body, generated, writing)  # 抛 ValueError 表示参数不对
    billing.check_quota(user["sub"])
    q = quota(user["sub"])
    if q["running"] >= c.RUNNING_LIMIT:
        raise ApiError(429, "running_limit", f"同时最多 {c.RUNNING_LIMIT} 个任务在生成，等前面的完成后再建")
    if req.get("flow"):
        flows.get(user["sub"], req["flow"])  # 画板要是自己的
    found = _check_uploads(user["sub"], req)
    take_daily(user["sub"])
    task_id = c.new_id()
    if req["product"] == "model3d":
        _save_images(user["sub"], task_id, req, found)
    else:
        opts = req["options"]
        for k in ("script", "assets"):  # 讲解稿和素材都已下线，新任务没有文件；老任务的记录里还有 files
            opts[k].pop("uploads", None)
            opts[k]["files"] = []
        _save_refs(user["sub"], task_id, req["refs"], found)
        _save_models(user["sub"], task_id, req, found)
        _save_pictures(user["sub"], task_id, req, found)
        picked = [i for i in req["options"]["skills"]["ids"] if i in generated]
        if picked:  # 生成的风格：当时的版本复制进任务目录，以后风格更新或下架，这个任务照常能改、能重渲
            req["styleRefs"] = styles.copy_into_task(user["sub"], task_id, picked, generated)
        if req.get("genre") in writing:  # 生成的写作方法：同样把当时那一版复制进任务目录（input/writing/<id>/）
            req["writingRef"] = styles.copy_into_task(user["sub"], task_id, [req["genre"]], writing, "writing")[0]
    now = c.now_ms()
    title = re.sub(r"\s+", " ", req["description"])[:24]
    item = {"pk": f"TASK#{task_id}", "sk": "META", "id": task_id, "sub": user["sub"], "email": user["email"],
            "gsi1pk": f"USER#{user['sub']}", "gsi1sk": now, "title": title, "mode": req["mode"], "request": req,
            "status": "queued", "steps": c.empty_steps(c.steps_of({"request": req})), "docs": {}, "clips": {}, "versions": [], "turn": None,
            "failure": None, "createdAt": now, "updatedAt": now}
    c.put_task(item)
    styles.record_tests(item, (req.get("styleRefs") or []) + ([req["writingRef"]] if req.get("writingRef") else []), user)
    node = {"node": "text"} if req.get("flow") and req["product"] == "video" else None  # 工作流：第一轮是文字节点的
    c.add_message(task_id, "user", req["description"], kind="text", extra=node)
    start_turn(item, "start", check=False, extra=node)
    return {"id": task_id}


def confirm(task, body):
    if task["status"] != "awaiting_confirmation":
        raise ApiError(409, "bad_state", "现在不需要确认分镜")
    billing.check_quota(task["sub"])
    outline = (task.get("docs") or {}).get("outline")
    if outline and not chs.all_of(task["id"]):  # 长片：确认的是总纲（前端把每章当作一行分镜来改）
        return confirm_outline(task, outline, body.get("storyboard"))
    sb = body.get("storyboard")
    if sb is not None:
        err = validate.storyboard(sb)
        if err:
            raise ApiError(400, "bad_storyboard", f"分镜格式不对：{err}")
    node = {"node": "av"} if task["request"].get("flow") else {}  # 工作流任务在生成页确认：算音画节点的
    c.add_message(task["id"], "user", "确认分镜，开始生成", kind="text", extra=node or None)
    start_turn(task, "confirm", extra={"storyboard": sb, **node})
    return {"ok": True}


def confirm_outline(task, outline, edited):
    if edited is not None:
        rows = {str(x.get("id")): x for x in (edited.get("scenes") or []) if isinstance(x, dict)}
        for ch in outline["chapters"]:
            e = rows.get(ch["id"])
            if not e:
                continue
            title, narration = str(e.get("title") or ch["title"]).strip()[:20], str(e.get("narration") or "").strip()
            if not narration or len(narration) > 6000:
                raise ApiError(400, "bad_outline", f"第 {int(ch['id'])} 章的讲稿为空或太长（最多 6000 字）")
            ch.update(title=title or ch["title"], narration=narration, summary=str(e.get("visual") or ch["summary"]).strip()[:300])
        err = validate.schema_check("outline", outline)
        if err:
            raise ApiError(400, "bad_outline", f"总纲格式不对：{err}")
    c.update_task(task["id"], "SET docs.#o = :o, #c = :t", names={"#o": "outline", "#c": "outlineConfirmed"}, values={":o": outline, ":t": True})
    c.add_message(task["id"], "user", "确认总纲，开始各章制作", kind="text")
    chs.start(c.get_task(task["id"]), [x["id"] for x in outline["chapters"]], "start")
    return {"ok": True}


def send_message(task, body):
    if task["status"] in ("queued", "running"):
        raise ApiError(409, "busy", "Agent 正在工作，等这一轮完成后再发")
    text = str(body.get("text") or "").strip()
    if not text:
        raise ApiError(400, "empty", "先写下要改什么")
    billing.check_quota(task["sub"])
    if len(text) > 2000:
        raise ApiError(400, "too_long", "一次最多 2000 字")
    scope = str(body.get("scope") or "all")
    m = re.fullmatch(r"([0-9]{2})(?:-([0-9]{2}))?", scope)
    if scope != "all" and not m:
        raise ApiError(400, "bad_scope", "修改范围不对")
    if m and chs.all_of(task["id"]) and m.group(1) not in {x["id"] for x in ((task.get("docs") or {}).get("outline") or {}).get("chapters") or []}:
        raise ApiError(400, "bad_scope", "修改范围不对：总纲里没有这一章")
    flow = _flow_node(task, body)
    c.add_message(task["id"], "user", text, kind="text", scope=scope, extra={"node": flow["node"]} if flow else None)
    if flow:  # 工作流：文字节点的修改只改剧本和分镜；音画节点的就是平常的修改
        start_turn(task, "revise", text=text, extra={"scope": scope, **flow})
        return {"ok": True}
    if m and chs.all_of(task["id"]):  # 长片：改某一章（"03"）或某一章的某一镜（"03-12"），交给那一章的会话
        if task["status"] == "awaiting_confirmation":
            raise ApiError(409, "bad_state", "先确认总纲，各章做出来以后再按镜修改")
        chs.start(task, [m.group(1)], "revise", text=text, extra={"scope": m.group(2) or "all"})
    else:
        start_turn(task, "revise", text=text, extra={"scope": scope})
    return {"ok": True}


def _flow_node(task, body):
    """工作流任务的消息属于哪个节点：前端说了就按前端的，没说时（在生成页发的）出片前算文字节点、出片后算音画节点。
    文字节点可以带上分镜表里直接改过的分镜。返回 turn 的附加字段；不是工作流任务时返回 None"""
    if not task["request"].get("flow"):
        if body.get("node"):
            raise ApiError(400, "bad_node", "这个任务不是工作流模式建的")
        return None
    node = body.get("node") or ("av" if task.get("versions") else "text")
    if node not in ("text", "av"):
        raise ApiError(400, "bad_node", "节点不对")
    if node == "text" and not (task.get("docs") or {}).get("storyboard"):
        raise ApiError(409, "bad_state", "文字节点还没写完分镜，等这一轮做完再改")
    if node == "av" and not task.get("versions"):
        raise ApiError(409, "bad_state", "音画节点出片以后才能在这里修改")
    out = {"node": node}
    sb = body.get("storyboard") if node == "text" else None
    if sb is not None:
        err = validate.storyboard(sb)
        if err:
            raise ApiError(400, "bad_storyboard", f"分镜格式不对：{err}")
        out["storyboard"] = sb
    return out


# ---------- 工作流模式的音画节点（docs/workflow-mode-design.md） ----------

SPEC_LABEL = {"ratio": "画幅", "resolution": "清晰度", "fps": "帧率", "voice_id": "音色", "subtitles": "字幕", "bgm": "背景音乐"}


def _fmt_spec(k, v):
    if k == "voice_id":
        return next((x["name"] for x in c.voices() if x["id"] == v), "按内容挑选")
    if k in ("subtitles", "bgm"):
        return "开" if v else "关"
    return f"{v} 帧" if k == "fps" else str(v)


def _style_names(task, ids):
    names = {**{s["id"]: s["name"] for s in c.catalog()}, **{x["id"]: x["name"] for x in task["request"].get("styleRefs") or []}}
    return " + ".join(names.get(i, i) for i in ids) or "交给 Agent 按内容挑"


def _apply_flow_settings(task, body, user):
    """音画节点当前的设置（视觉风格、规格和声音、连着的 3D 图片）和任务记录比，有变化就改进任务记录，返回给 Agent 看的改动清单"""
    r = task["request"]
    o = r["options"]
    changes = []
    # 视觉风格：主风格 + 最多一个插入风格；没选时交给 Agent
    ids = list(dict.fromkeys(str(i) for i in ((body.get("skills") or {}).get("ids") or [])))[:2]
    old = o["skills"]["ids"] if o["skills"].get("enabled") else []
    if ids != old:
        have = {x["id"] for x in r.get("styleRefs") or []}
        builtin = {s["id"] for s in c.catalog()}
        extra = [i for i in ids if i not in builtin and i not in have]
        if extra:  # 新选了管理员生成的风格：和建任务时一样，把当时的版本复制进任务目录
            vis = styles.visible(user.get("admin", False))
            if any(i not in vis for i in extra):
                raise ApiError(400, "bad_skills", "选的画风不存在或已经下架，请重新选择")
            refs = styles.copy_into_task(task["sub"], task["id"], extra, vis)
            r["styleRefs"] = [*(r.get("styleRefs") or []), *refs]
            styles.record_tests(task, refs, user)
        changes.append(f"视觉风格：{_style_names(task, old)} → {_style_names(task, ids)}"
                       + ("（按做片手册第 6 节“只换风格”处理：讲稿和配音不动）" if ids else ""))
        o["skills"] = {"enabled": bool(ids), "ids": ids}
    # 规格和声音（时长跟着文字节点的分镜走，这里不改）
    sp, cur = body.get("spec") or {}, o["spec"]
    new = {"ratio": sp.get("ratio") if sp.get("ratio") in validate.RATIOS else cur.get("ratio"),
           "resolution": sp.get("resolution") if sp.get("resolution") in validate.RESOLUTIONS else cur.get("resolution"),
           "fps": int(sp["fps"]) if sp.get("fps") in validate.FPS else cur.get("fps"),
           "voice_id": validate._voice_id(sp["voice_id"]) if "voice_id" in sp else cur.get("voice_id"),
           "subtitles": bool(sp["subtitles"]) if "subtitles" in sp else cur.get("subtitles"),
           "bgm": bool(sp["bgm"]) if "bgm" in sp else cur.get("bgm")}
    for k, v in new.items():
        if cur.get(k) != v:
            changes.append(f"{SPEC_LABEL[k]}：{_fmt_spec(k, cur.get(k))} → {_fmt_spec(k, v)}")
            cur[k] = v
    # 连着的 3D 图片：新连的复制进来，出了新版本的换成新文件，断开的不再用
    want = list(dict.fromkeys(str(m) for m in body.get("models") or []))
    if len(want) > validate.VIDEO_MAX_MODELS or any(not re.fullmatch(r"[0-9a-f-]{36}", m) for m in want):
        raise ApiError(400, "bad_models", f"一个音画节点最多连 {validate.VIDEO_MAX_MODELS} 个 3D 图片")
    refs = r.get("modelRefs") or []
    by_task = {m["taskId"]: m for m in refs}
    kept, used = [], {m["id"] for m in refs}
    for tid in want:
        t = c.get_task(tid)
        if not t or t.get("sub") != task["sub"] or c.product_of(t) != "model3d" or not t.get("models"):
            raise ApiError(400, "model_missing", "连着的 3D 图片还没做好，或者已经删除了")
        old_ref = by_task.get(tid)
        if old_ref:
            if old_ref["version"] != library.latest_model(t)["n"]:
                nr = _copy_model(task["sub"], task["id"], t, old_ref["id"])
                changes.append(f"3D 图片 {nr['id']}（{nr['name']}）更新到第 {nr['version']} 版，{nr['id']} 目录里的文件已经换成新的")
                kept.append(nr)
            else:
                kept.append(old_ref)
        else:
            mid = next(f"m{i:02d}" for i in range(1, 10) if f"m{i:02d}" not in used)
            used.add(mid)
            nr = _copy_model(task["sub"], task["id"], t, mid)
            changes.append(f"新加了 3D 图片 {mid}（{nr['name']}），模型和素材卡在 input/models/{mid}/，读素材卡后安排进合适的镜头")
            kept.append(nr)
    for m in refs:
        if m["taskId"] not in want:
            changes.append(f"去掉了 3D 图片 {m['id']}（{m['name']}），镜头里不要再用它")
    r["modelRefs"], r["models"] = kept, want
    return changes


def flow_av(task, body, user):
    """音画节点运行：还没出片时就是确认分镜；出片以后就是"重跑"，按最新的分镜和设置更新成片，只重做变了的镜头"""
    if not task["request"].get("flow"):
        raise ApiError(400, "not_flow", "这个任务不是工作流模式建的")
    if task["status"] in ("queued", "running"):
        raise ApiError(409, "busy", "Agent 正在工作，等这一轮完成后再运行")
    video = bool(task.get("versions"))
    if not video and task["status"] != "awaiting_confirmation":
        raise ApiError(409, "bad_state", "上一轮没有完成，先重试" if task["status"] == "failed" else "文字节点还没写完分镜")
    billing.check_quota(task["sub"])
    note = str(body.get("note") or "").strip()
    if len(note) > 2000:
        raise ApiError(400, "too_long", "一次最多 2000 字")
    sb = body.get("storyboard")
    if sb is not None:
        err = validate.storyboard(sb)
        if err:
            raise ApiError(400, "bad_storyboard", f"分镜格式不对：{err}")
    changes = _apply_flow_settings(task, body, user)
    if video:
        changed, removed = flows.changed_scenes(task)
        if changed or removed:
            changes.insert(0, "文字节点改过分镜：" + "；".join(filter(None, [changed and f"第 {'、'.join(changed)} 镜改了或是新加的",
                                                                          removed and f"去掉了第 {'、'.join(removed)} 镜"])))
        if sb is not None:
            changes.insert(0, "用户在分镜表里直接改了旁白（见 storyboard）")
        if not changes and not note:
            raise ApiError(400, "nothing_to_do", "成片已经是最新的，没有要重跑的改动")
    c.set_fields(task["id"], request=task["request"])
    head = "重跑音画" if video else "确认分镜，开始生成"
    c.add_message(task["id"], "user", f"{head}：{note}" if note else head, kind="text", extra={"node": "av"})
    extra = {"node": "av", "changes": changes, **({"storyboard": sb} if sb is not None else {})}
    if video:
        start_turn(task, "revise", text=note or None, extra={**extra, "scope": "all", "rerun": True})
    else:
        start_turn(task, "confirm", text=note or None, extra=extra)
    return {"ok": True, "changes": changes}


def retry(task):
    if task["status"] != "failed":
        raise ApiError(409, "bad_state", "只有失败的任务可以重试")
    billing.check_quota(task["sub"])
    failure = task.get("failure") or {}
    reason = failure.get("message", "")
    c.add_message(task["id"], "user", "让 Agent 修复后重试", kind="text")
    if failure.get("chapters"):  # 长片：只重做没完成的章
        chs.start(task, failure["chapters"], "retry", text=reason)
    elif failure.get("stitch"):  # 长片：各章都好了，只是拼接失败
        c.set_fields(task["id"], status="running", failure=None, turn={"id": "pending", "kind": "chapters", **c.turn_secrets()}, stitching=False)
        chs.stitch(c.get_task(task["id"]))
    else:
        start_turn(task, "retry", text=reason)
    return {"ok": True}
