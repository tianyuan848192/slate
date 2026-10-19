"""admin Lambda：管理端 API（独立的 API Gateway 入口，路径都以 /api 开头）。

鉴权两道：API Gateway 的 Cognito 授权器验签；这里再检查令牌来自管理端的应用客户端（aud），并且用户在 admin 组里。
功能：用户管理、模型与密钥、操作日志（接口说明见 docs/admin-batch1-design.md 第 5 节），
风格创建（admin_styles.py，docs/style-creator-design.md 第十一节）。
"""
import json, os, re, secrets, string, time, traceback, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key

import admin_styles
from lib import audit, billing, models
from lib import common as c
from lib.common import ApiError

POOL = os.environ.get("USER_POOL_ID", "")
ADMIN_CLIENT_ID = os.environ.get("ADMIN_CLIENT_ID", "")
MINIMAX_SECRET_ARN = os.environ.get("MINIMAX_SECRET_ARN", "")
ADMIN_GROUP = "admin"
CN = timezone(timedelta(hours=8))  # 用量按北京时间分月
cog = boto3.client("cognito-idp", region_name=c.REGION)
sm = boto3.client("secretsmanager", region_name=c.REGION)


def resp(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
            "body": c.json_dumps(body)}


def handler(event, context):
    try:
        claims = (event.get("requestContext", {}).get("authorizer") or {}).get("claims") or {}
        if not claims.get("sub"):
            raise ApiError(401, "unauthorized", "请先登录")
        groups = re.findall(r"[\w-]+", str(claims.get("cognito:groups") or ""))
        if claims.get("aud") != ADMIN_CLIENT_ID or ADMIN_GROUP not in groups or not _still_admin(claims):
            raise ApiError(403, "forbidden", "只有管理员能使用管理端")
        me = {"sub": claims["sub"], "email": claims.get("email", "")}
        method = event.get("httpMethod", "GET")
        path = re.sub(r"^/api", "", event.get("path", "")) or "/"
        body = json.loads(event["body"]) if event.get("body") else {}
        return route(method, path, body, event.get("queryStringParameters") or {}, me)
    except ApiError as e:
        return resp(e.status, {"error": {"code": e.code, "message": e.message}})
    except Exception:
        traceback.print_exc()
        return resp(500, {"error": {"code": "internal", "message": "服务出错了，请稍后再试"}})


_live = {}  # 用户名 → (查询时间, 是不是启用中的管理员)


def _still_admin(claims):
    """token 里的组是签发那一刻的：取消管理员、停用以后，旧 token 最多还能用 1 小时。所以每个请求再向用户池确认一次（缓存 30 秒）"""
    name = claims.get("cognito:username") or claims["sub"]
    at, ok = _live.get(name, (0, False))
    if time.time() - at < 30:
        return ok
    try:
        u = cog.admin_get_user(UserPoolId=POOL, Username=name)
        groups = cog.admin_list_groups_for_user(UserPoolId=POOL, Username=name, Limit=60)["Groups"]
        ok = bool(u.get("Enabled")) and _attrs(u).get("sub") == claims["sub"] and any(g["GroupName"] == ADMIN_GROUP for g in groups)
    except cog.exceptions.UserNotFoundException:
        ok = False
    _live[name] = (time.time(), ok)
    return ok


def route(method, path, body, qs, me):
    m = lambda pat: re.fullmatch(pat, path)  # noqa: E731
    if method == "GET" and path == "/me":
        return resp(200, me)
    if method == "GET" and path == "/users":
        return resp(200, {"items": list_users(qs.get("q", "").strip(), qs.get("status", "all"))})
    if method == "POST" and path == "/users":
        return resp(201, create_user(body, me))
    if (r := m(r"/users/([\w-]+)")) and method == "GET":
        return resp(200, user_detail(r.group(1)))
    if (r := m(r"/users/([\w-]+)/tasks")) and method == "GET":
        return resp(200, {"items": user_tasks(r.group(1))})
    if (r := m(r"/users/([\w-]+)/(disable|enable|reset-password)")) and method == "POST":
        return resp(200, user_action(r.group(1), r.group(2), body, me))
    if (r := m(r"/users/([\w-]+)/role")) and method == "PUT":
        return resp(200, set_role(r.group(1), bool(body.get("admin")), me))
    if method == "GET" and path == "/models":
        return resp(200, models_view())
    if method == "PUT" and path == "/models/minimax":
        return resp(200, save_minimax(body, me))
    if method == "POST" and path == "/models/test":
        return resp(200, test_source(body, me))
    if method == "GET" and path == "/usage":
        return resp(200, usage_overview(qs))
    if (r := m(r"/users/([\w-]+)/usage")) and method == "GET":
        return resp(200, user_usage(r.group(1), qs))
    if (r := m(r"/users/([\w-]+)/quota")) and method == "PUT":
        return resp(200, set_quota(r.group(1), body, me))
    if (r := m(r"/tasks/([0-9a-f-]{36})/usage")) and method == "GET":
        return task_usage(r.group(1), qs)
    if (r := m(r"/tasks/([0-9a-f-]{36})/adjust")) and method == "POST":
        return resp(200, adjust_task(r.group(1), body, me))
    if path == "/billing" and method in ("GET", "PUT"):
        return resp(200, billing_view() if method == "GET" else save_billing(body, me))
    if path == "/styles":
        if method == "GET":
            return resp(200, {"items": admin_styles.list_styles()})
        if method == "POST":
            return resp(201, admin_styles.create(body, me))
    if (r := m(r"/styles/((?:film|write)-[a-z0-9-]+)")) and method == "GET":
        return resp(200, admin_styles.detail(r.group(1)))
    if (r := m(r"/styles/((?:film|write)-[a-z0-9-]+)/file")) and method == "GET":
        return resp(200, admin_styles.file(r.group(1), qs))
    if (r := m(r"/styles/((?:film|write)-[a-z0-9-]+)/(start|retry|feedback|reject|beta|unbeta|publish|retire)")) and method == "POST":
        sid, action = r.groups()
        if action == "start":
            return resp(200, admin_styles.start(sid, me))
        if action == "retry":
            return resp(200, admin_styles.retry(sid, me))
        if action == "feedback":
            return resp(200, admin_styles.feedback(sid, body, me))
        return resp(200, admin_styles.act(sid, action, body, me))
    if method == "GET" and path == "/audit":
        return resp(200, {"items": audit.recent(int(qs.get("limit", 200)), qs.get("before"))})
    raise ApiError(404, "not_found", "没有这个接口")


# ======================================================================= 用户

def _attrs(u):
    return {a["Name"]: a["Value"] for a in (u.get("Attributes") or u.get("UserAttributes") or [])}


def _admins():
    out, tok = set(), None
    while True:
        r = cog.list_users_in_group(UserPoolId=POOL, GroupName=ADMIN_GROUP, **({"NextToken": tok} if tok else {}))
        out |= {_attrs(u).get("sub") for u in r["Users"]}
        tok = r.get("NextToken")
        if not tok:
            return out


def _status(u):
    if not u.get("Enabled", True):
        return "disabled"
    return "invited" if u.get("UserStatus") == "FORCE_CHANGE_PASSWORD" else "active"


def _brief(u, admins):
    a = _attrs(u)
    return {"sub": a.get("sub"), "email": a.get("email", u.get("Username")), "name": a.get("name", ""),
            "status": _status(u), "admin": a.get("sub") in admins,
            "created": int(u["UserCreateDate"].timestamp() * 1000) if u.get("UserCreateDate") else None}


def _all_users():
    out, tok = [], None
    while True:
        r = cog.list_users(UserPoolId=POOL, **({"PaginationToken": tok} if tok else {}))
        out += r["Users"]
        tok = r.get("PaginationToken")
        if not tok:
            return out


def _month(ms):
    return datetime.fromtimestamp(int(ms) / 1000, CN).strftime("%Y-%m")


def _task_rows():
    """所有任务的摘要（不读成片和素材）：用户、状态、时间、成片时长"""
    items, kw = [], dict(FilterExpression="sk = :m AND begins_with(pk, :t)", ExpressionAttributeValues={":m": "META", ":t": "TASK#"},
                         ProjectionExpression="#i, #s, createdAt, updatedAt, #st, versions, title", ExpressionAttributeNames={"#i": "id", "#s": "sub", "#st": "status"})
    while True:
        r = c.table().scan(**kw)
        items += r["Items"]
        if "LastEvaluatedKey" not in r:
            return [c.plain(x) for x in items]
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def _video_seconds(t):
    vs = t.get("versions") or []
    return float(vs[-1].get("dur") or 0) if vs else 0.0


def list_users(q, status):
    admins, rows = _admins(), _task_rows()
    this = datetime.now(CN).strftime("%Y-%m")
    stats = defaultdict(lambda: {"monthTasks": 0, "monthSeconds": 0.0, "monthDone": 0, "monthFailed": 0, "last": None, "total": 0})
    for t in rows:
        s = stats[t.get("sub")]
        s["total"] += 1
        s["last"] = max(s["last"] or 0, int(t.get("updatedAt") or 0))
        if _month(t.get("createdAt") or 0) == this:
            s["monthTasks"] += 1
            s["monthSeconds"] += _video_seconds(t)
            s["monthDone"] += t.get("status") == "completed"
            s["monthFailed"] += t.get("status") == "failed"
    out = []
    users = _all_users()
    cr = billing.many([_attrs(u).get("sub") for u in users])
    for u in users:
        b = _brief(u, admins)
        if status != "all" and b["status"] != status:
            continue
        if q and q.lower() not in f"{b['email']} {b['name']}".lower():
            continue
        s = stats[b["sub"]]
        fin = s["monthDone"] + s["monthFailed"]
        out.append({**b, "monthTasks": s["monthTasks"], "monthMinutes": round(s["monthSeconds"] / 60, 1), "totalTasks": s["total"],
                    "success": round(s["monthDone"] / fin, 3) if fin else None, "last": s["last"],
                    "monthCredits": cr.get(b["sub"], {}).get("used", 0), "quota": cr.get(b["sub"], {}).get("quota")})
    return sorted(out, key=lambda x: (-x["monthTasks"], x["email"]))


def _get_user(sub):
    r = cog.list_users(UserPoolId=POOL, Filter=f'sub = "{sub}"', Limit=1)["Users"]
    if not r:
        raise ApiError(404, "not_found", "没有这个用户")
    return r[0]


def _tasks_of(sub):
    items, kw = [], dict(IndexName="byUser", KeyConditionExpression=Key("gsi1pk").eq(f"USER#{sub}"), ScanIndexForward=False)
    while True:
        r = c.table().query(**kw)
        items += r["Items"]
        if "LastEvaluatedKey" not in r:
            return [c.plain(x) for x in items]
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def user_detail(sub):
    u = _get_user(sub)
    b = _brief(u, _admins())
    tasks = _tasks_of(sub)
    months = defaultdict(lambda: {"tasks": 0, "seconds": 0.0, "done": 0, "failed": 0})
    for t in tasks:
        mm = months[_month(t.get("createdAt") or 0)]
        mm["tasks"] += 1
        mm["seconds"] += _video_seconds(t)
        mm["done"] += t.get("status") == "completed"
        mm["failed"] += t.get("status") == "failed"
    now = datetime.now(CN)
    keys = [f"{(now.year * 12 + now.month - 1 - i) // 12}-{(now.month - 1 - i) % 12 + 1:02d}" for i in range(11, -1, -1)]
    mc = billing.months_of(sub, keys)
    hist = [{"month": k, "tasks": months[k]["tasks"], "minutes": round(months[k]["seconds"] / 60, 1),
             "done": months[k]["done"], "failed": months[k]["failed"], "credits": mc.get(k, 0)} for k in keys]
    last = max([int(t.get("updatedAt") or 0) for t in tasks] or [0]) or None
    sm = billing.summary(sub)
    return {**b, "lastActive": last, "totalTasks": len(tasks), "months": hist,
            "credits": {"month": sm["month"], "used": sm["used"], "quota": sm["quota"], "custom": sm["custom"]}}


def user_tasks(sub):
    out = []
    for t in _tasks_of(sub)[:200]:
        req = t.get("request") or {}
        skills = ((t.get("docs") or {}).get("brief") or {}).get("skills") or (req.get("options") or {}).get("skills", {}).get("ids") or []
        three = req.get("product") == "model3d"
        out.append({"id": t["id"], "product": req.get("product") or "video", "title": t.get("title") or (req.get("description") or "")[:24],
                    "status": t.get("status"), "seconds": _video_seconds(t), "versions": len(t.get("models" if three else "versions") or []), "skills": skills,
                    "createdAt": t.get("createdAt"), "updatedAt": t.get("updatedAt"), "failure": (t.get("failure") or {}).get("message"),
                    "credits": round(float(t.get("credits") or 0), 2)})
    return out


# ======================================================================= 用量和计费

def usage_overview(qs):
    d0, d1 = billing.date_range(qs)
    days, users = billing.all_users_days(d0, d1)
    return {"from": d0, "to": d1, "total": round(sum(days.values()), 2), "days": billing.day_list(d0, d1, days), "users": users}


def user_usage(sub, qs):
    _get_user(sub)
    d0, d1 = billing.date_range(qs)
    days = billing.days_of(sub, d0, d1)
    lo, hi = billing.day_start_ms(d0), billing.day_start_ms(d1) + 86400000
    tasks = [{"id": t["id"], "title": ((t.get("docs") or {}).get("brief") or {}).get("title") or t.get("title"),
              "credits": round(float(t.get("credits") or 0), 2), "createdAt": t.get("createdAt"), "status": t.get("status")}
             for t in _tasks_of(sub) if lo <= int(t.get("createdAt") or 0) < hi]
    return {"from": d0, "to": d1, "total": round(sum(days.values()), 2), "days": billing.day_list(d0, d1, days), "tasks": tasks}


def set_quota(sub, body, me):
    u = _get_user(sub)
    v = body.get("monthly")
    if v is not None:
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise ApiError(400, "bad_quota", "额度要填数字")
        if not 0 <= v <= 1e7:
            raise ApiError(400, "bad_quota", "额度要在 0 到 1000 万之间")
    billing.set_quota(sub, v)
    audit.write(me["email"], "修改额度", _attrs(u).get("email", sub), "恢复默认" if v is None else f"每月 {v:g} Credit")
    return billing.summary(sub)


def _task(task_id):
    t = c.get_task(task_id)
    if not t:
        raise ApiError(404, "not_found", "没有这个任务")
    return t


def task_usage(task_id, qs):
    t = _task(task_id)
    if qs.get("format") == "csv":
        return {"statusCode": 200, "headers": {"Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
                                               "Content-Disposition": f"attachment; filename=\"usage-{t['id'][:8]}.csv\""},
                "body": billing.usage_csv(t["id"])}
    rows, total = billing.usage_rows(t["id"])
    return resp(200, {"items": rows, "total": total})


def adjust_task(task_id, body, me):
    t = _task(task_id)
    reason = str(body.get("reason") or "").strip()[:200]
    try:
        cr = float(body.get("credits"))
    except (TypeError, ValueError):
        raise ApiError(400, "bad_credits", "调整的 Credit 要填数字")
    if not reason:
        raise ApiError(400, "no_reason", "写一下调整原因")
    if cr == 0 or abs(cr) > 1e6:
        raise ApiError(400, "bad_credits", "调整的 Credit 不能是 0，也不能太大")
    billing.adjust(t, cr, reason, me["email"])
    audit.write(me["email"], "调整 Credit", f"任务 {t['id'][:8]}（{t.get('email', '')}）", f"{'退还' if cr < 0 else '补扣'} {abs(cr):g}：{reason}")
    rows, total = billing.usage_rows(t["id"])
    return {"credits": round(float(c.get_task(t["id"]).get("credits") or 0), 2), "total": total}


def billing_view():
    cfg = billing.config(fresh=True)
    return {k: cfg.get(k) for k in ("version", "ratio", "defaultMonthly", "models", "voice", "render", "fx", "updatedAt", "updatedBy")}


def save_billing(body, me):
    cur = billing.config(fresh=True)

    def num(v, lo, hi, what):
        x = float(v)
        if not lo <= x <= hi:
            raise ApiError(400, "bad_price", f"{what}超出范围（{lo:g}～{hi:g}）")
        return x
    try:
        cfg = {"ratio": num(body.get("ratio", cur["ratio"]), 0.01, 100, "比例"),
               "defaultMonthly": num(body.get("defaultMonthly", cur["defaultMonthly"]), 0, 1e7, "默认月额度"),
               "fx": {"CNY": num((body.get("fx") or cur["fx"]).get("CNY", 7.2), 1, 20, "汇率")},
               "voice": {"per10kChars": num((body.get("voice") or cur["voice"]).get("per10kChars", 3.5), 0, 1000, "配音单价"), "currency": "CNY"},
               "models": {}, "render": {}}
        for it, p in (body.get("render") or cur["render"]).items():
            if not re.fullmatch(r"[a-z0-9]+\.[a-z0-9]+", it):
                raise ApiError(400, "bad_instance", f"机型不对：{it[:30]}")
            cfg["render"][it] = {"name": str(p.get("name") or it)[:40], "perHour": num(p.get("perHour", 0), 0, 1000, f"{it} 的单价")}
        for mid, p in (body.get("models") or cur["models"]).items():
            if not re.fullmatch(r"[\w.:-]{3,120}", mid):
                raise ApiError(400, "bad_model", f"模型 id 不对：{mid[:40]}")
            cfg["models"][mid] = {"name": str(p.get("name") or mid)[:40],
                                  **{k: num(p.get(k, 0), 0, 1000, f"{mid} 的单价") for k in ("input", "cacheRead", "cacheWrite", "output")}}
    except (TypeError, ValueError, AttributeError):
        raise ApiError(400, "bad_price", "价格要填数字")
    new = billing.save_config(cfg, me["email"])
    audit.write(me["email"], "修改计费设置", "价格表", f"第 {new['version']} 版：1 美元 = {new['ratio']:g} Credit，默认每月 {new['defaultMonthly']:g}")
    return billing_view()


def _temp_password():
    """满足用户池的密码规则：至少 8 位，大小写字母和数字都有"""
    while True:
        p = "Sl-" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(12))
        if any(ch.isupper() for ch in p) and any(ch.islower() for ch in p) and any(ch.isdigit() for ch in p):
            return p


def create_user(body, me):
    email = str(body.get("email") or "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ApiError(400, "bad_email", "邮箱格式不对")
    name = str(body.get("name") or "").strip()[:40]
    temp = _temp_password()
    attrs = [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}] + ([{"Name": "name", "Value": name}] if name else [])
    try:
        r = cog.admin_create_user(UserPoolId=POOL, Username=email, UserAttributes=attrs, TemporaryPassword=temp, MessageAction="SUPPRESS")
    except cog.exceptions.UsernameExistsException:
        raise ApiError(409, "exists", "这个邮箱已经开通过了")
    sub = _attrs(r["User"]).get("sub")
    if body.get("admin"):
        cog.admin_add_user_to_group(UserPoolId=POOL, Username=email, GroupName=ADMIN_GROUP)
    audit.write(me["email"], "开通账号", email, "管理员" if body.get("admin") else "普通用户")
    return {"sub": sub, "email": email, "tempPassword": temp}


def user_action(sub, act, body, me):
    u = _get_user(sub)
    email = _attrs(u).get("email", u["Username"])
    if act in ("disable",) and _attrs(u).get("sub") == me["sub"]:  # 用查到的 sub 比：路径里的写法可能不规范
        raise ApiError(400, "self", "不能停用自己的账号")
    _live.clear()
    if act == "disable":
        cog.admin_disable_user(UserPoolId=POOL, Username=u["Username"])
        cog.admin_user_global_sign_out(UserPoolId=POOL, Username=u["Username"])  # 已经登录的会话也作废
        audit.write(me["email"], "停用账号", email, body.get("reason", ""))
        return {"ok": True}
    if act == "enable":
        cog.admin_enable_user(UserPoolId=POOL, Username=u["Username"])
        audit.write(me["email"], "启用账号", email, body.get("reason", ""))
        return {"ok": True}
    temp = _temp_password()  # 重置密码：设一个临时密码，对方下次登录时必须修改
    cog.admin_set_user_password(UserPoolId=POOL, Username=u["Username"], Password=temp, Permanent=False)
    cog.admin_user_global_sign_out(UserPoolId=POOL, Username=u["Username"])  # 账号被盗时重置密码要能把对方踢下线
    audit.write(me["email"], "重置密码", email)
    return {"ok": True, "tempPassword": temp}


def set_role(sub, admin, me):
    u = _get_user(sub)
    email, sub = _attrs(u).get("email", u["Username"]), _attrs(u).get("sub")  # 用查到的 sub：路径里的写法可能不规范
    admins = _admins()
    _live.clear()
    if not admin:
        if sub == me["sub"]:
            raise ApiError(400, "self", "不能取消自己的管理员身份")
        if admins - {sub} == set():
            raise ApiError(400, "last_admin", "至少要保留一个管理员")
        cog.admin_remove_user_from_group(UserPoolId=POOL, Username=u["Username"], GroupName=ADMIN_GROUP)
        cog.admin_user_global_sign_out(UserPoolId=POOL, Username=u["Username"])  # 刷新令牌作废，拿不到新的管理员 token
    else:
        cog.admin_add_user_to_group(UserPoolId=POOL, Username=u["Username"], GroupName=ADMIN_GROUP)
    audit.write(me["email"], "设为管理员" if admin else "取消管理员", email)
    return {"ok": True, "admin": admin}


# ======================================================================= 模型与密钥

MODEL_POLICY = os.environ.get("MODEL_POLICY", "")  # 调用模型的托管策略名（挂在 Agent 角色和 llm Lambda 上）


def route_view(purpose):
    """一个用途给管理端看：主模型、被内容安全策略拦下时依次换的模型、来源"""
    ch = models.chain(purpose)
    return {"use": models.PURPOSES[purpose], "model": models.label(ch[0]["model"]), "alt": [models.label(x["model"]) for x in ch[1:]],
            "source": models.IAM}


def models_view():
    cfg = models.load(fresh=True)
    mm = cfg.get("minimax") or {}
    current = _minimax_key()
    configured = bool(current)
    return {
        "updatedAt": cfg.get("updatedAt"), "updatedBy": cfg.get("updatedBy"),
        "source": {"kind": "iam", "name": models.IAM, "policy": MODEL_POLICY},
        "routes": [
            route_view("agent"), route_view("vision"), route_view("video"),
            {"use": "配音", "model": "MiniMax speech-2.8-hd", "alt": [], "source": "MiniMax 中国区" if configured else "Amazon Polly（IAM 角色）",
             "fallback": "Amazon Polly（IAM 角色）" if configured else None},
        ],
        "minimax": {"configured": configured, "mask": models.mask(current) if current else None, "test": mm.get("test")},
    }


def _minimax_key():
    """当前的 MiniMax Key（可能是部署脚本写入的）；没配置返回空字符串。只在后端用来算掩码和做测试"""
    try:
        v = sm.get_secret_value(SecretId=MINIMAX_SECRET_ARN)["SecretString"].strip()
    except Exception:
        return ""
    return "" if not v or v.startswith("PLACEHOLDER") else v


def _need_key(body):
    k = str(body.get("apiKey") or "").strip()
    if len(k) < 8:
        raise ApiError(400, "bad_key", "API Key 太短，检查一下是否粘贴完整")
    return k


def save_minimax(body, me):
    key = _need_key(body)
    sm.put_secret_value(SecretId=MINIMAX_SECRET_ARN, SecretString=key)
    cfg = models.load(fresh=True)
    cfg["minimax"] = {"mask": models.mask(key), "test": None, "updatedAt": c.now_ms()}
    models.save(cfg, me["email"])
    audit.write(me["email"], "更换密钥", "MiniMax 中国区", models.mask(key))
    return models_view()


def _post(url, body, headers, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}：{e.read()[:200].decode('utf-8', 'ignore')}")


def test_source(body, me):
    """MiniMax 连通测试：合成一个字。body 里带 apiKey 时用它（保存前先试），否则用已经保存的 Key"""
    if body.get("source") != "minimax":
        raise ApiError(400, "bad_source", "只能测试 MiniMax 配音；模型都用本账号的 IAM 角色调用，不用配置 Key")
    cfg = models.load(fresh=True)
    t0 = time.time()
    try:
        key = str(body.get("apiKey") or "").strip() or _minimax_key()
        if not key:
            raise ApiError(400, "incomplete", "还没有配置 MiniMax API Key")
        d = _post("https://api.minimax.cn/v1/t2a_v2", {"model": "speech-2.8-turbo", "text": "好", "voice_setting": {"voice_id": "Chinese (Mandarin)_Warm_Bestie"},
                                                       "audio_setting": {"format": "mp3"}, "output_format": "hex"}, {"Authorization": f"Bearer {key}"})
        br = d.get("base_resp") or {}
        if br.get("status_code") != 0:
            raise RuntimeError(f"{br.get('status_code')}：{br.get('status_msg')}")
        result = {"ok": True, "ms": int((time.time() - t0) * 1000), "msg": "合成测试语音成功", "at": c.now_ms()}
    except ApiError:
        raise
    except Exception as ex:
        result = {"ok": False, "ms": int((time.time() - t0) * 1000), "msg": str(ex)[:300], "at": c.now_ms()}
    if not body.get("apiKey"):  # 测的是已保存的 Key，就把结果记在卡片上
        cfg["minimax"] = {**(cfg.get("minimax") or {}), "test": result}
        models.save(cfg, me["email"])
    audit.write(me["email"], "测试连通", "MiniMax 中国区", f"{'正常' if result['ok'] else '失败'}，{result['ms']} 毫秒：{result['msg'][:120]}")
    return result
