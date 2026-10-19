"""slate-model：3D 图片的渲染和导出（建模手册 core-model3d 用）。

slate-model view <model.js> [--out 目录] [--ref 参考图…] [--angles 0,90,180,270,35] [--size 768] [--explode]
    多角度图 <目录>/views/<角度>.png；有参考图时拼一张对比图 <目录>/cmp.png，交给 slate-look 比对。
    --explode：按全部拆开的样子拍（<目录>/exploded/<角度>.png，带素材卡里的零件名标注），检查拆解数据
slate-model sketch <示意图.svg> [--out 图.png]
    没有参考照片时，把按描述画的示意图渲染成 PNG，当参考图用
slate-model export <model.js>
    出一个新版本：1024 的多角度图、对比图（参考图取 input/images/）、GLB、3D 打印源数据；
    模型有拆解数据时再加拆解图（带零件标注）和拆解 GIF 动图。上传到 model/v<n>/ 并通知前端。
    3D 图片只出图片和文件，不出视频：成品页的 3D 预览可以拖动旋转、拖滑杆拆开。
    先用 slate-publish asset 发布素材卡；导出时核对素材卡里的工厂函数名和零件 id 都在模型里，打印检查的问题会列出来。
优先交给 GPU 渲染机（每次几秒到十几秒），调不通时退回 AgentCore Browser（CPU 软件渲染，慢一些）。
"""
import argparse, asyncio, glob, json, os

from . import model3d
from .common import die, emit, load_json, path, upload

DEFAULT_SIZE = 768


# 渲染机传回的文件名 → capture() 返回的 files 里的键
SINGLE = {"explode.mp4": "explode", "model.glb": "glb", "print-src.json.gz": "print_src"}


def _remote(job, size, glb, extract, out_dir):
    """交给渲染机；调不通时返回 None"""
    from . import remote
    if not remote.enabled():
        return None
    res = remote.call("model", [model3d.SCENE], model={"job": job, "size": size, "glb": glb, "extract": extract})
    if res is None or res.get("error"):
        return None
    files = {}
    for rel, k in (res.get("files") or {}).items():
        local = os.path.join(out_dir, rel)
        remote.download(k, local)
        head, name = os.path.split(rel)
        if head in ("views", "exploded"):
            files.setdefault(head, {})[str(int(name[:3]))] = local
        elif rel in SINGLE:
            files[SINGLE[rel]] = local
    return {"info": res.get("info") or {}, "files": files, "errors": res.get("errors") or [], "print_check": res.get("print_check") or [],
            "renderer": res.get("instance")}


def render(src, job, out_dir, size=DEFAULT_SIZE, glb=False, extract=False):
    job = model3d.prepare(src, job)
    os.makedirs(out_dir, exist_ok=True)
    res = _remote(job, size, glb, extract, out_dir)
    if res is None:
        try:
            res = asyncio.run(model3d.capture(job, out_dir, size=size, glb=glb, extract=extract))
        except Exception as e:  # 多半是模型代码在浏览器里报错（页面初始化出错：…）
            die(f"渲染失败：{str(e)[:600]}")
        res["renderer"] = "browser"
    info = res["info"]
    if not info.get("finite"):
        res["errors"].insert(0, "模型的包围盒不对（尺寸是 0 或不是有限数），检查几何和缩放")
    return res


def _refs(args_ref):
    return [p for p in args_ref if os.path.isfile(p)]


def _summary(res, extra=None):
    info = res["info"]
    out = {"factory": info.get("factory"), "meshes": info.get("meshes"), "triangles": info.get("triangles"), "size": info.get("size"),
           "parts": info.get("parts"), "renderer": res.get("renderer"), **(extra or {})}
    if res.get("errors"):
        out["page_errors"] = res["errors"]
    return out


def _labels():
    """素材卡里的零件名：拆解图的标注用"""
    return {p["id"]: p.get("name") or p["id"] for p in (load_json(path("asset.json"), {}) or {}).get("parts") or []}


def cmd_view(a):
    angles = [int(x) for x in a.angles.split(",") if x.strip()]
    job = {"angles": angles, **({"explode": 999, "labels": _labels()} if a.explode else {})}  # 999：超过步数就是全部拆开
    res = render(a.model, job, a.out, size=a.size)
    if a.explode and not res["info"].get("steps"):
        die("模型里没有拆解数据（sculptRuntime.explode.steps），先写好再看拆开的样子")
    views = [(int(k), v) for k, v in res["files"].get("exploded" if a.explode else "views", {}).items()]
    views.sort(key=lambda x: angles.index(x[0]) if x[0] in angles else 99)
    extra = {"views": [v for _, v in views]}
    refs = _refs(a.ref)
    if refs and views:
        extra["comparison"] = model3d.sheet(refs, views, os.path.join(a.out, "cmp.png"))
    if a.explode:
        extra["steps"] = res["info"].get("steps")
    print(json.dumps(_summary(res, extra), ensure_ascii=False))


def gif(mp4, out, width=480, fps=12):
    """拆解动图的 GIF 版（放进 PPT、网页、聊天软件）：调色板两遍法，颜色不脏"""
    import subprocess
    from .common import ffmpeg
    vf = f"fps={fps},scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", mp4, "-vf", vf, out], check=True)
    os.remove(mp4)  # 视频只是中间文件，不留在工作区（会进任务存档）
    return out


def cmd_sketch(a):
    try:
        errors = asyncio.run(model3d.sketch(a.model, a.out))
    except Exception as e:
        die(f"示意图渲染失败：{str(e)[:400]}")
    print(json.dumps({"sketch": a.out, **({"page_errors": errors} if errors else {})}, ensure_ascii=False))


def cmd_export(a):
    asset = load_json(path("asset.json"))
    if not asset:
        die("还没有素材卡：先写 asset.json，用 slate-publish asset asset.json 发布，再导出")
    try:
        factory = model3d.check_module(a.model)
    except ValueError as e:
        die(str(e))
    if asset.get("factory") != factory:
        die(f"素材卡里的 factory 是 {asset.get('factory')}，模型代码导出的是 {factory}，改成一致后重新发布素材卡")
    vers = load_json(path("model", "versions.json"), []) or []
    n = len(vers) + 1
    out_dir = path("model", "export", f"v{n}")
    views = render(a.model, {"angles": list(model3d.ANGLES)}, out_dir, size=1024, glb=True, extract=True)
    parts = set(views["info"].get("parts") or [])
    missing = [p["id"] for p in asset.get("parts") or [] if p["id"] not in parts]
    steps = views["info"].get("steps") or []
    missing += sorted({i for st in steps for i in st["parts"]} - parts)
    if missing:
        die(f"素材卡或拆解数据里的零件 {', '.join(sorted(set(missing)))} 在模型的 sculptRuntime.nodes 里找不到；模型里有：{', '.join(sorted(parts)) or '（没有）'}")
    boom = anim = None
    if steps:  # 有拆解数据：拆解图（带零件标注）和拆解 GIF（先渲染成视频再转 GIF，视频本身不上传）
        boom = render(a.model, {"angles": [35], "explode": 999, "labels": _labels()}, out_dir, size=1024)["files"]["exploded"]["35"]
        anim = gif(render(a.model, {"explodeAnim": 8}, out_dir, size=720)["files"]["explode"], os.path.join(out_dir, "explode.gif"))
    refs = sorted(glob.glob(path("input", "images", "*")))
    vlist = sorted(((int(k), v) for k, v in views["files"]["views"].items()), key=lambda x: list(model3d.ANGLES).index(x[0]))
    cmp_path = model3d.sheet(refs, vlist, os.path.join(out_dir, "cmp.png")) if refs else None
    base = ("model", f"v{n}")
    files = {"module": upload(a.model, *base, "model.js", content_type="application/javascript"),
             "glb": upload(views["files"]["glb"], *base, "model.glb", content_type="model/gltf-binary"),
             "views": {k: upload(v, *base, "views", f"{int(k):03d}.png", content_type="image/png") for k, v in views["files"]["views"].items()}}
    if cmp_path:
        files["comparison"] = upload(cmp_path, *base, "cmp.png", content_type="image/png")
    if views["files"].get("print_src"):
        files["printSrc"] = upload(views["files"]["print_src"], *base, "print-src.json.gz", content_type="application/gzip")
    if anim:
        files["explodeGif"] = upload(anim, *base, "explode.gif", content_type="image/gif")
        files["exploded"] = upload(boom, *base, "exploded.png", content_type="image/png")
    if files["module"]:  # 本地调试（没有凭证）时不发事件
        emit("model", n=n, files=files, steps=steps[:30])
    vers.append({"n": n, "files": files})
    os.makedirs(path("model"), exist_ok=True)
    json.dump(vers, open(path("model", "versions.json"), "w"), ensure_ascii=False, indent=1)
    extra = {"version": n, "views": [v for _, v in vlist], "glb": views["files"].get("glb"), "comparison": cmp_path}
    if steps:
        extra.update(steps=steps, exploded=boom, gif=anim)
    if views.get("print_check"):
        extra["print_check"] = views["print_check"]  # 3D 打印会出问题的地方，修完再导出一版
    print(json.dumps(_summary(views, extra), ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(prog="slate-model", description="3D 图片：多角度图、拆解图、导出新版本")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("view"); v.add_argument("model"); v.add_argument("--out", default=path("model", "review"))
    v.add_argument("--ref", nargs="*", default=[]); v.add_argument("--angles", default=",".join(map(str, model3d.ANGLES)))
    v.add_argument("--size", type=int, default=DEFAULT_SIZE)
    v.add_argument("--explode", action="store_true", help="按全部拆开的样子拍，带零件标注")
    k = sub.add_parser("sketch"); k.add_argument("model", metavar="svg"); k.add_argument("--out", default=path("model", "ref", "sketch.png"))
    e = sub.add_parser("export"); e.add_argument("model")
    a = ap.parse_args()
    if not os.path.isfile(a.model):
        die(f"找不到文件 {a.model}")
    try:
        {"view": cmd_view, "sketch": cmd_sketch, "export": cmd_export}[a.cmd](a)
    except ValueError as e:
        die(str(e))


if __name__ == "__main__":
    main()
