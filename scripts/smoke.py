"""端到端冒烟测试：像前端一样调用 Slate（Cognito 登录 → 建任务 → 轮询 → 下载成片）。

用法：
  python scripts/smoke.py --email a@b.com --password '...' create "给产品经理讲清楚 RAG，30 秒" [--confirm] [--no-web]
  python scripts/smoke.py ... watch <taskId>
  python scripts/smoke.py ... say <taskId> "第 1 镜标题大一点" [--scope 01]
  python scripts/smoke.py ... confirm <taskId>
地址取自 .slate/outputs-<STACK>.json。
"""
import argparse, json, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def outputs(stack):
    return json.load(open(os.path.join(ROOT, ".slate", f"outputs-{stack}.json")))[stack]


def http(method, url, body=None, headers=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def login(out, email, password):
    url = "https://cognito-idp.us-east-1.amazonaws.com/"
    h = {"Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"}
    req = urllib.request.Request(url, method="POST", headers=h, data=json.dumps(
        {"AuthFlow": "USER_PASSWORD_AUTH", "ClientId": out["ClientId"], "AuthParameters": {"USERNAME": email, "PASSWORD": password}}).encode())
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if "AuthenticationResult" not in r:
        sys.exit(f"登录需要处理质询：{r.get('ChallengeName')}")
    return r["AuthenticationResult"]["IdToken"]


def show(t, last):
    steps = " ".join(f"{s['name']}:{s['state'][0]}" for s in t["steps"])
    line = f"[{t['elapsed']:>4}s] {t['status']:<22} {t['statusText']:<14} {steps}"
    if line != last.get("line"):
        print(line, flush=True); last["line"] = line
    for m in t["messages"][last.get("n", 0):]:
        print(f"    💬 {m['role']}/{m['kind']}: {m['text'][:200]}", flush=True)
    last["n"] = len(t["messages"])
    if t.get("failure"):
        print("    ❌", t["failure"]["message"])


def upload(api, tok, path, purpose="ref"):
    import mimetypes
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    st, r = http("POST", f"{api}/uploads", {"filename": os.path.basename(path), "contentType": ctype, "size": os.path.getsize(path),
                                            "purpose": purpose}, {"Authorization": tok})
    if st != 200:
        sys.exit(f"申请上传失败：{st} {r}")
    req = urllib.request.Request(r["url"], method="PUT", data=open(path, "rb").read(), headers=r["headers"])
    urllib.request.urlopen(req, timeout=120).read()
    print("uploaded", path, "->", r["uploadId"])
    return r["uploadId"]


def watch(api, tok, tid, until=("completed", "failed", "awaiting_confirmation"), timeout=3600):
    last, t0 = {}, time.time()
    while time.time() - t0 < timeout:
        st, t = http("GET", f"{api}/tasks/{tid}", headers={"Authorization": tok})
        if st != 200:
            print("GET 失败", st, t); time.sleep(5); continue
        show(t, last)
        if t["status"] in until:
            return t
        time.sleep(5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True); ap.add_argument("--password", required=True)
    ap.add_argument("--stack", default=os.environ.get("STACK", "Slate"))
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create"); c.add_argument("description"); c.add_argument("--confirm", action="store_true"); c.add_argument("--no-web", action="store_true")
    c.add_argument("--duration", type=int); c.add_argument("--ratio")
    c.add_argument("--voice", help="音色 id（见 agent/voices.json），不填时交给 Agent")
    c.add_argument("--skill", action="append", default=[], help="指定风格 Skill，可多次")
    c.add_argument("--genre", help="写法 id（见 agent/skills/genres.json），不填时交给 Agent")
    c.add_argument("--model", action="append", default=[], help="从素材库引用的 3D 图片（3D 任务号），可多次")
    c.add_argument("--ref", action="append", default=[], help="参考资料文件（pdf docx md txt csv xlsx，不超过 1 MB），可多次")
    c.add_argument("--ref-text", action="append", default=[], help="粘贴的参考文字，写成 标题=内容，可多次")
    c.add_argument("--ref-link", action="append", default=[], help="参考链接，可多次")
    c.add_argument("--strict", action="store_true", help="强制引用：事实、数字和术语只能来自资料")
    c.add_argument("--pic", action="append", default=[], help="视频里用的普通图片，写成 文件路径=描述（png jpg webp，不超过 10 MB），可多次")
    w = sub.add_parser("watch"); w.add_argument("id")
    s = sub.add_parser("say"); s.add_argument("id"); s.add_argument("text"); s.add_argument("--scope", default="all")
    md = sub.add_parser("model", help="建一个 3D 图片任务"); md.add_argument("description")
    md.add_argument("--image", action="append", default=[], help="参考照片（同一物体的不同角度，最多 4 张），可多次")
    md.add_argument("--explode", action="store_true", help="做成能拆解的模型（出拆解图和拆解动图）")
    md.add_argument("--no-web", action="store_true", help="不上网查外形资料")
    pr = sub.add_parser("print", help="从 3D 任务导出打印文件"); pr.add_argument("id")
    pr.add_argument("--printer", default="a1"); pr.add_argument("--height", type=float, default=120)
    pr.add_argument("--mode", default="whole", choices=["whole", "parts"]); pr.add_argument("--colors", type=int, default=4)
    pr.add_argument("--format", default="3mf", choices=["3mf", "stl"])
    f = sub.add_parser("confirm"); f.add_argument("id")
    rt = sub.add_parser("retry"); rt.add_argument("id")
    a = ap.parse_args()
    out = outputs(a.stack)
    api = out["Url"].rstrip("/") + "/api"
    tok = login(out, a.email, a.password)
    if a.cmd == "create":
        body = {"mode": "quick", "web_search": not a.no_web, "description": a.description, "genre": a.genre}
        items = [{"kind": "file", "uploadId": upload(api, tok, f, "ref"), "name": os.path.basename(f)} for f in a.ref]
        items += [{"kind": "text", "title": t.split("=", 1)[0], "text": t.split("=", 1)[1]} for t in a.ref_text]
        items += [{"kind": "link", "url": u} for u in a.ref_link]
        body["refs"] = {"web": not a.no_web, "strict": a.strict, "items": items}
        if a.model:
            body["models"] = a.model
        if a.pic:  # docs/image-refs-design.md：每张都要写描述
            body["images"] = [{"kind": "file", "uploadId": upload(api, tok, x.split("=", 1)[0], "image"), "name": os.path.basename(x.split("=", 1)[0]),
                               "desc": x.split("=", 1)[1] if "=" in x else ""} for x in a.pic]
        advanced = any([a.confirm, a.duration, a.ratio, a.skill, a.voice])
        if advanced:
            spec = {"enabled": bool(a.duration or a.ratio or a.voice), "ratio": a.ratio or "16:9", "duration": a.duration or 30,
                    "resolution": "1080p", "fps": 30, "voice": True, "voice_id": a.voice or "auto", "subtitles": True, "bgm": True}
            body.update(mode="advanced", options={
                "confirm_storyboard": a.confirm, "spec": spec,
                "skills": {"enabled": bool(a.skill), "ids": a.skill}})
        st, r = http("POST", f"{api}/tasks", body, {"Authorization": tok})
        print("create:", st, r)
        if st != 201:
            sys.exit(1)
        tid = r["id"]
    elif a.cmd == "model":
        body = {"product": "model3d", "description": a.description, "images": [upload(api, tok, f, "image") for f in a.image],
                "explode": a.explode, "web_search": not a.no_web}
        st, r = http("POST", f"{api}/tasks", body, {"Authorization": tok})
        print("create:", st, r)
        if st != 201:
            sys.exit(1)
        tid = r["id"]
    elif a.cmd == "print":
        st, r = http("POST", f"{api}/tasks/{a.id}/print", {"printer": a.printer, "height": a.height, "mode": a.mode,
                                                             "colors": a.colors, "format": a.format}, {"Authorization": tok})
        if st != 200:
            print("print:", st, r)
            sys.exit(1)
        dst = os.path.join("/tmp", f"slate-{a.id[:8]}-{r['file']}")
        urllib.request.urlretrieve(r["download"], dst)
        print(json.dumps(r["report"], ensure_ascii=False, indent=1))
        print(f"打印文件 → {dst}（{os.path.getsize(dst) // 1024} KB）")
        return
    elif a.cmd == "say":
        print(http("POST", f"{api}/tasks/{a.id}/messages", {"text": a.text, "scope": a.scope}, {"Authorization": tok}))
        tid = a.id
    elif a.cmd == "retry":
        print(http("POST", f"{api}/tasks/{a.id}/retry", {}, {"Authorization": tok}))
        tid = a.id
    elif a.cmd == "confirm":
        print(http("POST", f"{api}/tasks/{a.id}/confirm", {}, {"Authorization": tok}))
        tid = a.id
    else:
        tid = a.id
    t = watch(api, tok, tid)
    if t and t.get("versions"):
        v = t["versions"][-1]
        dst = os.path.join("/tmp", f"slate-{tid[:8]}-v{v['n']}.mp4")
        urllib.request.urlretrieve(v["url"], dst)
        print(f"成片第 {v['n']} 版：{v['dur']} 秒 → {dst}")
    m = (t or {}).get("model") or {}
    if m.get("versions"):
        v = m["versions"][-1]
        dst = os.path.join("/tmp", f"slate-{tid[:8]}-m{v['n']}")
        os.makedirs(dst, exist_ok=True)
        for x in v["views"]:
            urllib.request.urlretrieve(x["url"], os.path.join(dst, f"{x['angle']:03d}.png"))
        for k, name in (("comparison", "cmp.png"), ("glb", "model.glb")):
            if v.get(k):
                urllib.request.urlretrieve(v[k], os.path.join(dst, name))
        for k, name in (("gif", "explode.gif"), ("image", "exploded.png")):
            if (v.get("explode") or {}).get(k):
                urllib.request.urlretrieve(v["explode"][k], os.path.join(dst, name))
        print(f"3D 第 {v['n']} 版：{(m.get('asset') or {}).get('name')} → {dst}")
    print(json.dumps({"id": tid, "status": t and t["status"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
