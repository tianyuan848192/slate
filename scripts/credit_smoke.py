"""Credit 计费的冒烟测试：用户端和管理端的用量接口、CSV 导出、额度用完返回 402、管理员调整。

用法：python scripts/credit_smoke.py <任务 ID>      任务要属于 .slate/test-user.json 的测试用户，并且已经有用量
- 会临时把测试用户的月额度改成 0.01 来验证 402，测完恢复成原来的设置；
- 会对这个任务先退还再补扣 0.01 Credit（两条调整记录，合计不变）。
"""
import json, os, sys, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.environ.get("STACK", "Slate")
OUT = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{STACK}.json")))
MAIN, ADM = OUT[STACK], OUT[f"{STACK}-admin"]
USER_API, ADMIN_API = MAIN["Url"].rstrip("/") + "/api", ADM["AdminUrl"].rstrip("/") + "/api"


def login(client_id, who):
    acc = json.load(open(os.path.join(ROOT, ".slate", f"test-{who}.json")))
    req = urllib.request.Request("https://cognito-idp.us-east-1.amazonaws.com/", method="POST", data=json.dumps({
        "AuthFlow": "USER_PASSWORD_AUTH", "ClientId": client_id, "AuthParameters": {"USERNAME": acc["email"], "PASSWORD": acc["password"]}}).encode(),
        headers={"Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["AuthenticationResult"]["IdToken"]


def call(base, tok, method, path, body=None, raw=False):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            return r.status, (data.decode("utf-8"), r.headers.get("Content-Type")) if raw else json.loads(data or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"：{extra}" if extra and not cond else ""))


def main():
    tid = sys.argv[1]
    ut, at = login(MAIN["ClientId"], "user"), login(ADM["AdminClientId"], "admin")
    u = lambda *a, **k: call(USER_API, ut, *a, **k)
    a = lambda *a_, **k: call(ADMIN_API, at, *a_, **k)

    print("用户端")
    s, me = u("GET", "/me"); cr = me.get("credits") or {}
    check("/me 带本月额度", s == 200 and {"month", "used", "quota", "remaining"} <= set(cr), me)
    s, lst = u("GET", "/tasks"); row = next((x for x in lst.get("items", []) if x["id"] == tid), {})
    check("任务列表带 credits", s == 200 and row.get("credits", 0) > 0, row)
    s, t = u("GET", f"/tasks/{tid}"); b = t.get("billing") or {}
    check("任务详情带按轮次的用量", s == 200 and b.get("credits", 0) > 0 and b.get("turns"), b)
    s, us = u("GET", f"/tasks/{tid}/usage")
    kinds = {x["kind"] for x in us.get("items", [])}
    check("明细有主 Agent 和配音", s == 200 and {"model", "voice"} <= kinds, kinds)
    check("明细合计 = 任务合计", abs(us.get("total", -1) - b.get("credits", 0)) < 0.011, (us.get("total"), b.get("credits")))
    check("轮次小计合计 = 任务合计", abs(sum(x["credits"] for x in b.get("turns", [])) - b.get("credits", 0)) < 0.011 * max(1, len(b.get("turns", []))))
    s, (csv, ctype) = u("GET", f"/tasks/{tid}/usage?format=csv", raw=True)
    check("CSV 导出", s == 200 and "csv" in (ctype or "") and csv.startswith("﻿时间"), (s, ctype, csv[:40]))
    s, mu = u("GET", "/usage")
    check("用量页", s == 200 and mu.get("days") and any(x["id"] == tid for x in mu.get("tasks", [])), str(mu)[:200])
    check("用量页本月合计 = /me 已用", abs(mu.get("total", -1) - cr.get("used", 0)) < 0.011, (mu.get("total"), cr.get("used")))
    s, _ = u("GET", "/billing"); check("普通用户看不到价格表", s in (403, 404), s)

    print("管理端")
    s, users = a("GET", "/users"); me_row = next((x for x in users.get("items", []) if x.get("email") == me.get("email")), {})
    sub = me_row.get("sub")
    check("用户列表带本月 Credit 和额度", s == 200 and me_row.get("monthCredits", 0) > 0 and me_row.get("quota"), me_row)
    s, d = a("GET", f"/users/{sub}"); check("用户详情带额度", s == 200 and (d.get("credits") or {}).get("used", 0) > 0, d.get("credits"))
    s, ud = a("GET", f"/users/{sub}/usage"); check("用户按日期的用量", s == 200 and any(x["id"] == tid for x in ud.get("tasks", [])), str(ud)[:200])
    s, pu = a("GET", "/usage"); check("全平台用量", s == 200 and any(x["sub"] == sub for x in pu.get("users", [])), str(pu)[:200])
    s, ut_ = a("GET", f"/tasks/{tid}/usage"); check("管理员看任务明细", s == 200 and ut_.get("total") == us.get("total"), (ut_.get("total"), us.get("total")))
    s, bill = a("GET", "/billing"); check("价格表", s == 200 and bill.get("ratio") == 1.5 and bill.get("models"), bill.get("ratio"))
    s, bad = a("PUT", "/billing", {**bill, "ratio": -1}); check("价格表拒绝负比例", s == 400, s)

    print("额度和调整")
    old = (d.get("credits") or {}).get("quota") if (d.get("credits") or {}).get("custom") else None
    s, _ = a("PUT", f"/users/{sub}/quota", {"monthly": 0.01}); check("改额度", s == 200, s)
    s, r = u("POST", "/tasks", {"mode": "quick", "web_search": False, "description": "测试额度：这个任务不应该被创建，15 秒"})
    check("额度用完时新建任务返回 402", s == 402 and r.get("error") == "quota_exceeded", (s, r))
    s, _ = a("PUT", f"/users/{sub}/quota", {"monthly": old}); check("恢复额度", s == 200, s)
    s, me2 = u("GET", "/me"); check("恢复后额度正确", (me2.get("credits") or {}).get("quota") == cr.get("quota"), me2.get("credits"))
    before = b.get("credits", 0)
    s1, _ = a("POST", f"/tasks/{tid}/adjust", {"credits": -0.01, "reason": "冒烟测试：退还"})
    s2, _ = a("POST", f"/tasks/{tid}/adjust", {"credits": 0.01, "reason": "冒烟测试：补扣"})
    s, t2 = u("GET", f"/tasks/{tid}")
    check("调整一退一补，合计不变", s1 == s2 == 200 and abs(t2["billing"]["credits"] - before) < 0.011, (s1, s2, before, t2["billing"]["credits"]))
    s, us2 = u("GET", f"/tasks/{tid}/usage")
    check("调整记录进明细", sum(1 for x in us2.get("items", []) if x["kind"] == "adjust") >= 2)
    print("全部通过" if ok else "有失败项")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
