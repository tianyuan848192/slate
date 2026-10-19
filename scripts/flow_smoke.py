"""工作流模式的端到端测试（docs/workflow-mode-design.md）：像画板一样调用接口，走一遍
文字节点运行 → 文字节点对话（出片前）→ 音画节点运行 → 文字节点对话（出片后）→ 音画节点重跑。

用法：python scripts/flow_smoke.py --email a@b.com --password '...' ["描述"]
每一步检查：任务状态、消息记在哪个节点、出片后改文字不会出新版本、重跑带上改过的镜头。画板留着，可以在网页上打开看。
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import http, login, outputs, show  # noqa: E402

FAILS = []


def check(name, ok, extra=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + str(extra)) if extra else ''}", flush=True)
    if not ok:
        FAILS.append(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True); ap.add_argument("--password", required=True)
    ap.add_argument("--stack", default=os.environ.get("STACK", "Slate"))
    ap.add_argument("desc", nargs="?", default="为什么天是蓝的？给小学高年级的学生讲清楚瑞利散射，语气轻松。")
    a = ap.parse_args()
    out = outputs(a.stack)
    api = out["Url"].rstrip("/") + "/api"
    tok = lambda: login(out, a.email, a.password)  # noqa: E731  每次重新登录，测试跑一个小时也不会过期

    def call(method, path, body=None):
        return http(method, f"{api}{path}", body, {"Authorization": tok()})

    def wait(tid, until, timeout=3600):
        last, t0 = {}, time.time()
        time.sleep(8)
        while time.time() - t0 < timeout:
            st, t = call("GET", f"/tasks/{tid}")
            if st == 200:
                show(t, last)
                if t["status"] in until:
                    return t
            time.sleep(10)
        sys.exit("等太久了")

    av_cfg = {"main": "", "insert": "", "voice": "auto", "sub": True, "bgm": False, "ratio": "16:9", "res": "1080p", "fps": 30}
    text_cfg = {"desc": a.desc, "refs": [], "web": False, "strict": False, "genre": "science", "dur": 15, "edits": {}}
    doc = lambda task=None: {"nodes": [{"k": "t", "type": "text", "x": 60, "y": 60, "cfg": text_cfg, **({"task": task} if task else {})},  # noqa: E731
                                       {"k": "a", "type": "av", "x": 500, "y": 100, "cfg": av_cfg}], "edges": [["t", "a", "text"]]}
    st, r = call("POST", "/flows", {"kind": "canvas", "name": "工作流冒烟测试", "doc": doc()})
    check("建画板", st == 201, r)
    fid = r["id"]
    body = {"mode": "advanced", "flow": fid, "description": a.desc, "web_search": False, "genre": "science",
            "refs": {"web": False, "strict": False, "items": []}, "models": [],
            "options": {"skills": {"enabled": False, "ids": []}, "confirm_storyboard": True,
                        "spec": {"enabled": True, "ratio": "16:9", "duration": 15, "resolution": "1080p", "fps": 30,
                                 "voice": True, "voice_id": "auto", "subtitles": True, "bgm": False}}}
    st, r = call("POST", "/tasks", {**body, "options": {**body["options"], "spec": {**body["options"]["spec"], "duration": 600}}})
    check("长片不能用工作流", st == 400 and r.get("error") == "flow_long", r.get("error"))
    st, r = call("POST", "/tasks", body)
    check("文字节点运行：建任务", st == 201, r)
    tid = r["id"]
    call("PATCH", f"/flows/{fid}", {"doc": doc(tid)})
    t0 = time.time()

    t = wait(tid, ("awaiting_confirmation", "failed", "completed"))
    check("文字节点停在分镜", t["status"] == "awaiting_confirmation" and not t["versions"], t["status"])
    check("消息都记在文字节点", all(m.get("node") == "text" for m in t["messages"]), {m.get("node") for m in t["messages"]})
    check("任务详情带画板信息", (t.get("flow") or {}).get("id") == fid and t["flow"]["node"] == "text", t.get("flow"))
    n_scenes = len(t["storyboard"]["scenes"])
    first = t["storyboard"]["scenes"][0]["narration"]

    st, r = call("POST", f"/tasks/{tid}/messages", {"text": "第 2 镜的旁白再口语一点", "node": "av"})
    check("没出片时音画节点不能对话", st == 409, r.get("message"))
    st, r = call("POST", f"/tasks/{tid}/messages", {"text": "第 2 镜的旁白再口语一点", "node": "text"})
    check("文字节点对话（出片前）", st == 200, r)
    t = wait(tid, ("awaiting_confirmation", "failed", "completed"))
    check("改完仍然停在分镜，没有出片", t["status"] == "awaiting_confirmation" and not t["versions"], t["status"])
    check("代码、渲染、合成都没动", all(s["state"] == "pending" for s in t["steps"] if s["name"] in ("code", "render", "compose")),
          [(s["name"], s["state"]) for s in t["steps"]])

    st, r = call("POST", f"/tasks/{tid}/av", {"skills": {"ids": []}, "spec": {"ratio": "16:9", "resolution": "1080p", "fps": 30, "voice_id": "auto",
                                                                           "subtitles": True, "bgm": False}, "models": []})
    check("音画节点运行（确认分镜）", st == 200, r)
    t = wait(tid, ("completed", "failed"))
    check("出片", t["status"] == "completed" and len(t["versions"]) == 1, t["status"])
    check("音画这一轮的消息记在音画节点", any(m.get("node") == "av" and m["role"] == "agent" for m in t["messages"]))
    clips1 = {s["id"]: (s.get("clip") or {}).get("url", "").split("?")[0] for s in t["storyboard"]["scenes"]}

    st, r = call("POST", f"/tasks/{tid}/messages", {"text": "第 1 镜换一个更抓人的开场问题，别的镜头不要动", "node": "text"})
    check("文字节点对话（出片后）", st == 200, r)
    t = wait(tid, ("completed", "failed", "awaiting_confirmation"))
    check("只改了文字，没有出新版本", len(t["versions"]) == 1, len(t["versions"]))
    ch = (t.get("flow") or {}).get("changed") or []
    check("音画节点能看出改了哪几镜", bool(ch), ch)
    check("第 1 镜的旁白改了", t["storyboard"]["scenes"][0]["narration"] != first, t["storyboard"]["scenes"][0]["narration"][:40])

    st, r = call("POST", f"/tasks/{tid}/av", {"skills": {"ids": []}, "spec": {"ratio": "16:9", "resolution": "1080p", "fps": 30, "voice_id": "auto",
                                                                           "subtitles": True, "bgm": False}, "models": []})
    check("音画节点重跑", st == 200 and r["changes"] and r["changes"][0].startswith("文字节点改过分镜"), r.get("changes"))
    t = wait(tid, ("completed", "failed"))
    check("出了第 2 版", t["status"] == "completed" and len(t["versions"]) == 2, t["status"])
    clips2 = {s["id"]: (s.get("clip") or {}).get("url", "").split("?")[0] for s in t["storyboard"]["scenes"]}
    same = [k for k in clips1 if clips1[k] and clips1[k] == clips2.get(k)]
    check("没改的镜头直接复用了片段", len(same) >= 1, f"复用 {same}，共 {n_scenes} 镜，改了 {ch}")
    st, r = call("POST", f"/tasks/{tid}/av", {"skills": {"ids": []}, "spec": {"ratio": "16:9", "resolution": "1080p", "fps": 30, "voice_id": "auto",
                                                                           "subtitles": True, "bgm": False}, "models": []})
    check("没有改动时不让重跑", st == 400 and r.get("error") == "nothing_to_do", r.get("error"))
    print(f"\n任务 {tid}，画板 {fid}，用时 {int(time.time() - t0)} 秒，{t['billing']['credits']} Credit")
    print(f"打开画板：{out['Url'].rstrip('/')}/#flow/{fid}")
    print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED：{FAILS}")


if __name__ == "__main__":
    main()
