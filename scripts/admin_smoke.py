"""管理端冒烟测试：用测试管理员登录管理端（Cognito 管理端客户端），走一遍用户管理、权限保护、模型与密钥接口。

用法：python scripts/admin_smoke.py
- 测试管理员的账号在 .slate/test-admin.json；普通测试用户在 .slate/test-user.json。
- 会临时开通一个账号，测完用 AWS CLI 删除；不会改动 MiniMax 和其他已保存的密钥。
"""
import json, os, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK = os.environ.get("STACK", "Slate")
OUT = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{STACK}.json")))
MAIN, ADM = OUT[STACK], OUT[f"{STACK}-admin"]
API = ADM["AdminUrl"].rstrip("/") + "/api"


def cognito_login(client_id, email, password):
    req = urllib.request.Request("https://cognito-idp.us-east-1.amazonaws.com/", method="POST", data=json.dumps({
        "AuthFlow": "USER_PASSWORD_AUTH", "ClientId": client_id, "AuthParameters": {"USERNAME": email, "PASSWORD": password}}).encode(),
        headers={"Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["AuthenticationResult"]["IdToken"]


def call(tok, method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"：{extra}" if extra and not cond else ""))


def main():
    adm = json.load(open(os.path.join(ROOT, ".slate", "test-admin.json")))
    usr = json.load(open(os.path.join(ROOT, ".slate", "test-user.json")))
    tok = cognito_login(ADM["AdminClientId"], adm["email"], adm["password"])
    print("权限")
    s, me = call(tok, "GET", "/me"); check("管理员能登录管理端", s == 200 and me.get("email") == adm["email"], me)
    s, _ = call(cognito_login(MAIN["ClientId"], adm["email"], adm["password"]), "GET", "/me"); check("用户端客户端的令牌被拒绝（403）", s == 403, s)
    s, _ = call(cognito_login(ADM["AdminClientId"], usr["email"], usr["password"]), "GET", "/me"); check("普通用户被拒绝（403）", s == 403, s)
    s, _ = call(tok, "PUT", f"/users/{me['sub']}/role", {"admin": False}); check("不能取消自己的管理员身份", s == 400, s)
    s, _ = call(tok, "POST", f"/users/{me['sub']}/disable", {}); check("不能停用自己", s == 400, s)

    print("用户管理")
    s, users = call(tok, "GET", "/users"); check("用户列表", s == 200 and len(users["items"]) >= 2, s)
    test_user = next(u for u in users["items"] if u["email"] == usr["email"])
    check("列表里有任务统计", "monthTasks" in test_user and test_user["totalTasks"] > 0, test_user)
    s, d = call(tok, "GET", f"/users/{test_user['sub']}"); check("用户详情（12 个月）", s == 200 and len(d["months"]) == 12, s)
    s, t = call(tok, "GET", f"/users/{test_user['sub']}/tasks"); check("用户的任务列表", s == 200 and t["items"] and "title" in t["items"][0], s)
    temp_email = f"slate-admin-smoke-{int(time.time())}@example.com"
    s, cr = call(tok, "POST", "/users", {"email": temp_email, "name": "冒烟测试"}); check("开通账号（返回临时密码）", s == 201 and cr.get("tempPassword"), cr)
    sub = cr.get("sub")
    try:
        s, _ = call(tok, "POST", "/users", {"email": temp_email}); check("重复开通被拒绝（409）", s == 409, s)
        s, r = call(tok, "POST", f"/users/{sub}/reset-password", {}); check("重置密码", s == 200 and r.get("tempPassword"), r)
        s, _ = call(tok, "POST", f"/users/{sub}/disable", {"reason": "冒烟测试"}); check("停用", s == 200, s)
        s, d = call(tok, "GET", f"/users/{sub}"); check("停用后状态是 disabled", d.get("status") == "disabled", d.get("status"))
        s, _ = call(tok, "POST", f"/users/{sub}/enable", {}); check("启用", s == 200, s)
        s, _ = call(tok, "PUT", f"/users/{sub}/role", {"admin": True}); check("设为管理员", s == 200, s)
        s, d = call(tok, "GET", f"/users/{sub}"); check("角色已更新", d.get("admin") is True, d.get("admin"))
        s, _ = call(tok, "PUT", f"/users/{sub}/role", {"admin": False}); check("取消管理员", s == 200, s)
    finally:
        subprocess.run(["aws", "cognito-idp", "admin-delete-user", "--user-pool-id", MAIN["UserPoolId"], "--username", temp_email], check=False)

    print("模型与密钥")
    s, m = call(tok, "GET", "/models"); check("读取配置", s == 200 and m["minimax"]["configured"], m)
    check("模型来源是本账号 IAM 角色", m["source"]["kind"] == "iam" and all(r["source"] == m["source"]["name"] for r in m["routes"][:3]), m["routes"][:3])
    check("显示调用模型的策略名", m["source"]["policy"].endswith("-models"), m["source"])
    check("不再有模型 Key 的配置", "bedrock_key" not in m and "openai" not in m, list(m))
    check("响应里没有完整的 Key", "sk-cp-" not in json.dumps(m) or "•" in m["minimax"]["mask"], m["minimax"])
    s, r = call(tok, "POST", "/models/test", {"source": "minimax"}); check("MiniMax 连通测试", s == 200 and r.get("ok"), r)
    s, _ = call(tok, "POST", "/models/test", {"source": "bedrock_key"}); check("只能测试 MiniMax", s == 400, s)
    s, _ = call(tok, "PUT", "/models/order", {"order": ["openai"]}); check("来源优先级的接口已经去掉", s == 404, s)
    s, a = call(tok, "GET", "/audit"); check("操作日志", s == 200 and any(x["act"] == "开通账号" for x in a["items"]), s)
    print("全部通过" if ok else "有失败的检查")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
