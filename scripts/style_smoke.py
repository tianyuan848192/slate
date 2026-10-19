"""风格创建的线上冒烟测试（docs/style-creator-design.md 第十一节）：用测试管理员走管理端接口，用户端用 scripts/smoke.py 做测试片。

python scripts/style_smoke.py create <参考视频> --name 纸面科普 --slug paper-kepu [--cat 插画讲解] [--notes …]
       [--outputs visual,writing] [--wname 写作方法名称] [--group 讲解|宣传]   一段视频同时出画风 film-<短名> 和写作方法 write-<短名>
python scripts/style_smoke.py watch <风格 id>          每 30 秒看一次生成进度，生成结束后打印这一版的检查和分数
python scripts/style_smoke.py beta <风格 id> --v 1     内测发布，再检查：普通用户的风格库里没有、管理员的有（带 beta）
python scripts/style_smoke.py video <风格 id> "<描述>"  管理员在用户端用这个风格做一支测试片（画风用 --skill，写作方法用 --genre）
python scripts/style_smoke.py publish <风格 id> --v 1  公开发布，再检查普通用户的风格库里有了
python scripts/style_smoke.py feedback <风格 id> --v 1 "<意见>"
"""
import argparse, json, os, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from admin_smoke import ADM, MAIN, ROOT, call, cognito_login  # noqa: E402

ADMIN = json.load(open(os.path.join(ROOT, ".slate", "test-admin.json")))
USER = json.load(open(os.path.join(ROOT, ".slate", "test-user.json")))


def admin_token():
    return cognito_login(ADM["AdminClientId"], ADMIN["email"], ADMIN["password"])


def skills_of(who):
    tok = cognito_login(MAIN["ClientId"], who["email"], who["password"])
    req = urllib.request.Request(MAIN["Url"].rstrip("/") + "/api/skills", headers={"Authorization": tok})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    return {x["id"]: x for x in r["items"] + r.get("genres", [])}  # 画风和写作方法 id 前缀不同，不会撞


def must(s, r, what):
    if s >= 300:
        sys.exit(f"{what} 失败：{s} {r}")
    return r


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create"); c.add_argument("video"); c.add_argument("--name", required=True); c.add_argument("--slug", required=True)
    c.add_argument("--cat", default="插画讲解"); c.add_argument("--notes", default="")
    c.add_argument("--outputs", default="visual", help="visual、writing，或者 visual,writing"); c.add_argument("--wname"); c.add_argument("--group", default="讲解")
    w = sub.add_parser("watch"); w.add_argument("id")
    for name in ("beta", "publish"):
        p = sub.add_parser(name); p.add_argument("id"); p.add_argument("--v", type=int, required=True)
    v = sub.add_parser("video"); v.add_argument("id"); v.add_argument("description")
    f = sub.add_parser("feedback"); f.add_argument("id"); f.add_argument("--v", type=int, required=True); f.add_argument("text")
    a = ap.parse_args()
    tok = admin_token()
    if a.cmd == "create":
        size = os.path.getsize(a.video)
        r = must(*call(tok, "POST", "/styles", {"name": a.name, "slug": a.slug, "cat": a.cat, "notes": a.notes, "outputs": a.outputs.split(","),
                                                 "wname": a.wname or a.name, "group": a.group,
                                                 "rights": True, "file": {"name": os.path.basename(a.video), "size": size, "contentType": "video/mp4"}}), "新建")
        req = urllib.request.Request(r["upload"]["url"], data=open(a.video, "rb").read(), method="PUT", headers=r["upload"]["headers"])
        urllib.request.urlopen(req, timeout=300).read()
        print("上传完成", r.get("ids") or r["id"], size)
        print(must(*call(tok, "POST", f"/styles/{r['id']}/start", {}), "开始生成"))
    elif a.cmd == "watch":
        t0 = time.time()
        while True:
            tok = admin_token()  # 令牌一小时过期，生成要一两个小时
            d = must(*call(tok, "GET", f"/styles/{a.id}"), "详情")
            t = d.get("task") or {}
            steps = " ".join(f"{s['id']}:{s['state'][0]}" for s in t.get("steps") or [])
            print(f"[{int(time.time() - t0):5d}s] {d['status']:10s} 任务 {t.get('status')} {steps} 用量 {t.get('credits')}", flush=True)
            if d["status"] not in ("generating", "draft"):
                break
            time.sleep(30)
        for m in (t.get("messages") or [])[-3:]:
            print("  💬", m["role"], (m["text"] or "")[:400])
        for ver in d["versions"][-1:]:
            print(json.dumps({k: ver[k] for k in ("n", "summary", "checks", "files", "canPublish")}, ensure_ascii=False, indent=1))
            for s in ver.get("segments") or []:
                print("  段", s["id"], s.get("desc"), "轮廓", s.get("structure"), "动作", s.get("motion"), "色差", s.get("paletteDeltaE"))
            for tr in ver["trials"]:
                print("  试写", tr["label"], tr.get("topic") or "", tr.get("scores"))
            if ver.get("reviewFiles"):
                print("  验证材料", ver["reviewFiles"])
        if t.get("failure"):
            print("失败：", t["failure"])
    elif a.cmd in ("beta", "publish"):
        print(must(*call(tok, "POST", f"/styles/{a.id}/{a.cmd}", {"v": a.v}), a.cmd))
        time.sleep(2)
        user, admin = skills_of(USER), skills_of(ADMIN)
        print("普通用户看得到：", a.id in user, user.get(a.id, {}).get("beta"))
        print("管理员看得到：", a.id in admin, "内测" if admin.get(a.id, {}).get("beta") else "公开")
    elif a.cmd == "video":
        sys.exit(subprocess.call([os.path.join(ROOT, ".venv", "bin", "python"), os.path.join(ROOT, "scripts", "smoke.py"), "--email", ADMIN["email"],
                                  "--password", ADMIN["password"], "create", a.description, "--genre" if a.id.startswith("write-") else "--skill", a.id, "--no-web"]))
    elif a.cmd == "feedback":
        print(must(*call(tok, "POST", f"/styles/{a.id}/feedback", {"v": a.v, "text": a.text}), "按意见重新生成"))


if __name__ == "__main__":
    main()
