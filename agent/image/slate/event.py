"""向前端报告进度和结果的几条命令（事件先写到 S3，由服务端校验后再展示给用户）。

slate-event step <name> <start|done|skip> [--note 文本]
    name：视频是 research（资料整理）analyze（分析需求）script（写剧本）storyboard（写分镜）
          code（写动画代码）render（渲染画面）compose（合成配音和字幕）；
          3D 图片是 analyze（看图分析）spec（建模规格）model（建模）review（比对修正）export（导出）；
          风格创建是 analyze（看视频）listen（听旁白）traits（提炼要素）skill（写说明书）engine（写引擎和示范镜头）writing（写写作方法）check（自检打分）
slate-event awaiting-confirmation          写完分镜（长片是写完总纲）、需要用户确认时
slate-event chapters-ready                 长片：总纲和共用组件都准备好了，可以开始各章并行制作
slate-event revise-chapters 03,05 --note "<要改什么>"   长片的全片修改：指定要重做的章和修改要求
slate-event fail "<原因>"                   实在无法完成时，报告失败原因（会显示给用户）
slate-publish <notes|brief|sources|script|storyboard|outline|asset> <文件>   校验 JSON 后发布（剧本会先和参考资料核对；asset 是 3D 素材卡）
slate-say "<文本>" [--kind plan|info]      给用户发一条消息（plan = 改动计划）
"""
import argparse, json, os, sys

import jsonschema

from .common import OPT, chapter, die, emit, load_json, path, upload

STEPS = ["analyze", "research", "script", "storyboard", "code", "render", "compose", "spec", "model", "review", "export",
         "traits", "skill", "engine", "check", "listen", "writing"]
DOCS = ["notes", "brief", "sources", "script", "storyboard", "outline", "asset"]
SCHEMAS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schemas")


def event_main():
    ap = argparse.ArgumentParser(prog="slate-event", description="报告进度")
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("step"); st.add_argument("name", choices=STEPS); st.add_argument("state", choices=["start", "done", "skip"])
    st.add_argument("--note", default="")
    sub.add_parser("awaiting-confirmation")
    sub.add_parser("chapters-ready")
    rc = sub.add_parser("revise-chapters"); rc.add_argument("chapters", help="要重做的章号，逗号分隔，例如 03,05"); rc.add_argument("--note", required=True)
    fl = sub.add_parser("fail"); fl.add_argument("reason")
    a = ap.parse_args()
    if a.cmd == "step":
        if len(a.note) > 300:
            die("note 太长（最多 300 字）")
        emit("step", name=a.name, state=a.state, note=a.note)
    elif a.cmd == "fail":
        emit("fail", message=a.reason[:300])
    elif a.cmd in ("chapters-ready", "revise-chapters"):
        outline = load_json(path("outline.json"))
        if not outline:
            die("还没有 outline.json：先写总纲并用 slate-publish outline outline.json 发布")
        known = [ch["id"] for ch in outline["chapters"]]
        if a.cmd == "chapters-ready":
            emit("chapters_ready", chapters=known)
        else:
            ids = [x.strip() for x in a.chapters.split(",") if x.strip()]
            bad = [x for x in ids if x not in known]
            if bad or not ids:
                die(f"章号不对：{', '.join(bad) or '（空）'}，总纲里有 {', '.join(known)}")
            if not a.note.strip() or len(a.note) > 2000:
                die("--note 为空或太长（最多 2000 字）")
            emit("revise_chapters", chapters=ids, note=a.note.strip())
    else:
        emit("awaiting_confirmation")
    print("ok")


def validate(doc, data):
    schema = json.load(open(os.path.join(SCHEMAS, f"{doc}.json")))
    errs = sorted(jsonschema.Draft7Validator(schema).iter_errors(data), key=lambda e: list(e.path))
    return [f"{'/'.join(map(str, e.path)) or '(根)'}：{e.message}" for e in errs[:10]]


def publish_main():
    ap = argparse.ArgumentParser(prog="slate-publish", description="校验并发布 notes/brief/sources/script/storyboard/outline/asset")
    ap.add_argument("doc", choices=DOCS); ap.add_argument("file")
    a = ap.parse_args()
    try:
        data = json.load(open(a.file, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        die(f"读不了 {a.file}：{e}")
    errs = validate(a.doc, data)
    if a.doc == "storyboard" and not errs:
        ids = [s["id"] for s in data["scenes"]]
        if len(set(ids)) != len(ids):
            errs.append("scenes 里的 id 有重复")
        styles = sorted({x["skill"] for x in data["scenes"] if x.get("skill")})
        if len(styles) > 2:
            errs.append(f"全片用到了 {len(styles)} 个风格（{', '.join(styles)}），最多两个：主风格和一个插入风格，同一镜不能混用")
        errs += _image_errs([i for x in data["scenes"] for i in x.get("images") or []], data.get("unused_images") or [], "镜")
    if a.doc == "outline" and not errs:
        ids = [ch["id"] for ch in data["chapters"]]
        if ids != [f"{i:02d}" for i in range(1, len(ids) + 1)]:
            errs.append("chapters 的 id 要从 01 开始连续编号")
        errs += _image_errs([i for ch in data["chapters"] for i in ch.get("images") or []], [], "章")
    if a.doc == "notes" and not errs:
        from .refs import check_notes
        errs += check_notes(data)
    if errs:
        die("不符合格式要求：\n" + "\n".join(errs))
    check = None
    if a.doc == "script":
        check = _check_script(data)
    canon = path(f"{a.doc}.json")
    if os.path.abspath(a.file) != os.path.abspath(canon):
        json.dump(data, open(canon, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ch = chapter()  # 长片的章节会话：各章的分镜分开存，不能互相覆盖
    k = upload(canon, *(("pub", "chapters", ch) if ch else ("pub",)), f"{a.doc}.json", content_type="application/json")
    if k:
        emit("publish", doc=a.doc, key=k)
    if check:  # 核对结果也发布，生成页显示
        cp = path("scriptcheck.json")
        json.dump(check, open(cp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        k2 = upload(cp, *(("pub", "chapters", ch) if ch else ("pub",)), "scriptcheck.json", content_type="application/json")
        if k2:
            emit("publish", doc="scriptcheck", key=k2)
    out = {"published": a.doc, "file": f"{a.doc}.json"}
    if check:
        out["check"] = {"rounds": check["rounds"], "ok": check["ok"], "unresolved": check["blocking"]}
    print(json.dumps(out, ensure_ascii=False))


def _image_errs(used, unused, unit):
    """用户给的图片（input/images/index.json）：编号要存在；分镜里每张都要用到，实在不合适的写进 unused_images 并说明原因。
    长片：总纲要把每张图分到某一章，各章的分镜要用到总纲分给这一章的图"""
    have = {x["id"] for x in (load_json(path("input", "images", "index.json")) or {}).get("items", []) if not x.get("error")}
    errs = [f"没有图片 {i}（看 input/images/index.json 里的编号）" for i in sorted(set(used) | {x["id"] for x in unused}) if i not in have]
    need = have
    if unit == "镜" and chapter():
        mine = next((c for c in (load_json(path("outline.json")) or {}).get("chapters", []) if c.get("id") == chapter()), {})
        need = have & set(mine.get("images") or [])
    left = sorted(need - set(used) - {x["id"] for x in unused})
    if left:
        errs.append(f"用户给的图片 {', '.join(left)} 没有安排进任何一{unit}：每张都要用到；实在不合适的，写进分镜的 unused_images 并说明原因"
                    if unit == "镜" else f"用户给的图片 {', '.join(left)} 没有分到任何一章：在 chapters[].images 里写明哪一章用")
    return errs


def _check_script(data):
    """剧本发布前和参考资料核对（docs/references-design.md）：有要拦的问题就发布失败、返回清单，最多两轮；
    第三次照常发布，没解决的问题记进核对结果给用户看。没有资料或核对调不通时不核对"""
    from .refs import check_script
    res = check_script(data)
    if res is None:
        return None
    st_p = path(".script_check_rounds")
    rounds = int(open(st_p).read() or 0) if os.path.exists(st_p) else 0
    res["rounds"] = rounds + 1
    if res["blocking"] and rounds < 2:
        open(st_p, "w").write(str(rounds + 1))
        kinds = {"contradiction": "和资料矛盾", "unsupported": "资料里找不到依据", "term": "术语用法和资料不一致"}
        lines = [f"- [{kinds[i['kind']]}] {i['text']}（资料 {i['ref'] or '—'}）→ {i['suggestion']}"
                 for i in res["issues"] if res["strict"] or i["kind"] == "contradiction"]
        die(f"剧本和参考资料核对没通过（第 {rounds + 1} 轮，最多 3 轮）。改好以后重新发布：\n" + "\n".join(lines))
    if os.path.exists(st_p):
        os.remove(st_p)
    return res


def say_main():
    ap = argparse.ArgumentParser(prog="slate-say", description="给用户发一条消息")
    ap.add_argument("text"); ap.add_argument("--kind", choices=["plan", "info"], default="info")
    a = ap.parse_args()
    if not a.text.strip() or len(a.text) > 2000:
        die("消息为空或太长（最多 2000 字）")
    emit("say", text=a.text.strip(), kind=a.kind)
    print("ok")
