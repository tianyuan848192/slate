"""slate-render NN [NN ...]：渲染一镜或几镜。

把这一镜的帧区间切成若干段，每段开一个 AgentCore Browser 会话：逐帧调用 render(t) → CDP 截图（JPEG）
→ 会话内 ffmpeg 编码成 H.264；最后无损拼接成 clips/NN.mp4。
按"场景代码 + 引用的 Skill 和素材 + 字幕 + 规格"计算内容哈希；哈希没变就直接复用，不重新渲染。
渲染完上传到 clips/<哈希>.mp4，并发出 clip 事件（前端分镜条随之显示这一镜）。
"""
import argparse, asyncio, glob, hashlib, json, math, os, re, shutil, subprocess, sys, tempfile, time

from playwright.async_api import async_playwright

from . import page as pg
from .common import OPT, ctx, die, emit, ffmpeg, load_json, path, s3, spec, storyboard, upload

MAX_SHARDS = int(os.environ.get("SLATE_MAX_SHARDS", "8"))
FRAMES_PER_SHARD = 75
# 用 WebGL 的场景：浏览器用 CPU 软件渲染，一帧要零点几秒到十几秒，每段只分 6 帧、最多开 40 段
MAX_SHARDS_HEAVY = int(os.environ.get("SLATE_MAX_SHARDS_HEAVY", "40"))
FRAMES_PER_SHARD_HEAVY = 6
RUNTIME_VERSION = "1"


def scene_of(sid):
    for s in storyboard()["scenes"]:
        if s["id"] == sid:
            return s
    die(f"分镜里没有第 {sid} 镜")


def _hash_tree(h, root):
    for p in sorted(glob.glob(os.path.join(root, "**", "*"), recursive=True)):
        if os.path.isfile(p):
            h.update(os.path.relpath(p, root).encode()); h.update(open(p, "rb").read())


ASSETS_SHA = os.path.join(OPT, "assets.sha")


def content_hash(sid, cfg):
    sdir = path("scenes", sid)
    h = hashlib.sha256()
    h.update(RUNTIME_VERSION.encode()); h.update(open(pg.RUNTIME, "rb").read())
    h.update(json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode())
    _hash_tree(h, sdir)
    html = "".join(open(p, encoding="utf-8", errors="ignore").read() for p in glob.glob(os.path.join(sdir, "**", "*.*"), recursive=True)
                   if p.endswith((".html", ".js", ".css")))
    for shared in sorted(set(re.findall(r"\.\./(_[A-Za-z0-9_-]+)/", html))):
        if os.path.isdir(path("scenes", shared)):
            h.update(shared.encode()); _hash_tree(h, path("scenes", shared))
    for skill in sorted(set(re.findall(r"/skills/([A-Za-z0-9_-]+)/", html))):
        _hash_tree(h, pg.skill_dir(skill))
    for f in sorted(set(re.findall(r"/input/([^\"')\s]+)", html))):
        p = path("input", f)
        if os.path.isfile(p):
            h.update(open(p, "rb").read())
    # 镜像自带的公共库、three.js 和字体：构建镜像时算好一个摘要，换了镜像里的这些文件，旧片段就不再复用
    if re.search(r"/(core|node_modules|assets)/", html) and os.path.isfile(ASSETS_SHA):
        h.update(open(ASSETS_SHA, "rb").read())
    return h.hexdigest()[:20]


async def shard(pw, i, sid, cfg, f0, f1, out, stats):
    t0 = time.time()
    async with pg.ScenePage(pw, sid, cfg, name=f"slate_r{sid}_{i}_{os.getpid()}") as sp:
        setup = time.time() - t0
        ff = await asyncio.create_subprocess_exec(
            ffmpeg(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(cfg["fps"]), "-c:v", "mjpeg", "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(cfg["fps"]), out,
            stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            for f in range(f0, f1):
                await sp.frame(f / cfg["fps"])
                ff.stdin.write(await sp.jpeg()); await ff.stdin.drain()
        finally:
            ff.stdin.close()
            err = (await ff.stderr.read()).decode()
            await ff.wait()
        if ff.returncode != 0:
            raise RuntimeError(f"ffmpeg 编码失败：{err[-300:]}")
        stats.append({"shard": i, "frames": f1 - f0, "setup_s": round(setup, 1), "s": round(time.time() - t0, 1),
                      "errors": sp.errors[:3], "blocked": sp.blocked[:3]})


def uses_webgl(sid):
    src = "".join(open(p, encoding="utf-8", errors="ignore").read()
                  for p in glob.glob(os.path.join(path("scenes", sid), "**", "*.*"), recursive=True) if p.endswith((".html", ".js", ".mjs")))
    # 场景直接引用的风格文件也算进来（比如机械图解的 kit/gl.mjs）：WebGL 写在那里，场景里看不出来
    for skill, rel in sorted(set(re.findall(r"/skills/([A-Za-z0-9_-]+)/([A-Za-z0-9_./-]+\.m?js)", src))):
        f = os.path.join(pg.skill_dir(skill), os.path.normpath(rel))
        if os.path.isfile(f) and ".." not in rel:
            src += open(f, encoding="utf-8", errors="ignore").read()
    return bool(re.search(r"webgl|from\s*['\"]three['\"/]|THREE\.|/node_modules/three/", src, re.I))  # 最后一种：importmap 引入 three（比如用了 3D 镜头模板）


def prepare(sid, force=False):
    """这一镜的规格和内容指纹；内容没变、片段还在时直接复用（返回 reused 结果）"""
    s, sp = scene_of(sid), spec()
    if not os.path.isfile(path("scenes", sid, "index.html")):
        die(f"找不到 scenes/{sid}/index.html")
    cfg = pg.scene_config(s, sp, subtitles=_subtitles_on())
    digest = content_hash(sid, cfg)
    os.makedirs(path("clips"), exist_ok=True)
    meta = load_json(path("clips", f"{sid}.json"), {})
    mp4 = path("clips", f"{sid}.mp4")
    if not force and meta.get("hash") == digest and (os.path.isfile(mp4) or _fetch_clip(meta, mp4)):
        _publish(sid, meta, reused=True)
        return cfg, digest, {"scene": sid, "reused": True, "hash": digest, "duration": cfg["duration"]}
    return cfg, digest, None


def _fetch_clip(meta, local):
    """会话被回收后片段文件不在本地（工作区存档不带片段）。内容没变的镜头按记录的 key 从 S3 取回，不用重新渲染"""
    c, cli = ctx(), s3()
    if not meta.get("key") or not cli or not c.get("bucket"):
        return False
    try:
        os.makedirs(os.path.dirname(local), exist_ok=True)
        cli.download_file(c["bucket"], meta["key"], local)
        return True
    except Exception as e:
        print(f"取回第 {meta.get('scene')} 镜的片段失败，重新渲染：{str(e)[:120]}", file=sys.stderr)
        return False


async def render_scene(sid, force=False):
    cfg, digest, reused = prepare(sid, force)
    if reused:
        return reused
    out, meta_p = path("clips", f"{sid}.mp4"), path("clips", f"{sid}.json")

    total = max(1, int(round(cfg["duration"] * cfg["fps"])))
    n = max(1, min(MAX_SHARDS, math.ceil(total / FRAMES_PER_SHARD)))
    work = tempfile.mkdtemp(prefix=f"slate_{sid}_")
    heavy = uses_webgl(sid)
    if heavy:
        n = max(n, min(MAX_SHARDS_HEAVY, math.ceil(total / FRAMES_PER_SHARD_HEAVY)))
    bounds = [(total * k // n, total * (k + 1) // n) for k in range(n)]
    t0, stats = time.time(), []
    try:
        async with async_playwright() as pw:
            await asyncio.gather(*[shard(pw, i, sid, cfg, f0, f1, os.path.join(work, f"{i:02d}.mp4"), stats)
                                   for i, (f0, f1) in enumerate(bounds)])
        lst = os.path.join(work, "list.txt")
        open(lst, "w").write("".join(f"file '{os.path.join(work, f'{i:02d}.mp4')}'\n" for i in range(n)))
        subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out], check=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    meta = {"scene": sid, "hash": digest, "duration": round(total / cfg["fps"], 3), "frames": total, "fps": cfg["fps"],
            "size": f"{cfg['width']}x{cfg['height']}", "render_s": round(time.time() - t0, 1), "shards": n}
    # 每帧耗时（不含开会话和加载页面），给 Agent 判断要不要降低复杂度
    cost = sum(st["s"] - st["setup_s"] for st in stats) / max(1, sum(st["frames"] for st in stats))
    meta["frame_s"] = round(cost, 2)
    errors = sorted({e for st in stats for e in st["errors"]})
    blocked = sorted({b for st in stats for b in st["blocked"]})
    meta["key"] = upload(out, "clips", f"{digest}.mp4", content_type="video/mp4")
    json.dump(meta, open(meta_p, "w"), indent=1)
    _publish(sid, meta, reused=False)
    res = {**{k: meta[k] for k in ("scene", "hash", "duration", "frames", "render_s", "shards")}, "reused": False}
    res["frame_s"] = meta["frame_s"]
    if heavy:
        if cost > 3:
            res["note_webgl"] = f"这一镜每帧约 {cost:.1f} 秒。可以降低复杂度：减少透射/折射材质、后期 pass、阴影贴图尺寸和超采样"
    if errors:
        res["page_errors"] = errors[:5]
    if blocked:
        res["blocked_requests"] = blocked[:5]
        res["note"] = "场景请求了外部地址，已被拦截。素材请放进 scenes/NN/ 或引用 /input/、/skills/。"
    return res


def _subtitles_on():
    br = load_json(path("brief.json"), {}) or {}
    return br.get("subtitles", True)


def _publish(sid, meta, reused):
    if meta.get("key"):
        emit("clip", scene=sid, key=meta["key"], hash=meta["hash"], dur=meta["duration"], reused=reused)


CHUNK = 4  # 一次交给渲染机几镜。每批做完马上登记、打印结果：整条命令中途被打断时，做好的镜头再运行一次会直接复用


def render_remote(ids, force, show):
    """交给渲染机，每批做完就对每一镜调用 show(镜号, 结果)（结果里有 error 的表示这一镜失败）。
    返回渲染机没有接手的镜头：渲染机调不通时，从那一批起剩下的镜头由调用方改用本机方式渲染"""
    from . import remote
    todo, digests = [], {}
    for sid in ids:
        cfg, digest, reused = prepare(sid, force)
        if reused:
            show(sid, reused)
        else:
            todo.append(sid); digests[sid] = (cfg, digest)
    if len(todo) > CHUNK:
        print(f"要渲染 {len(todo)} 镜，分 {math.ceil(len(todo) / CHUNK)} 批交给渲染机，每批做完就登记", file=sys.stderr, flush=True)
    for i in range(0, len(todo), CHUNK):
        part = todo[i:i + CHUNK]
        res = remote.call("render", part, concurrency=2, max_shards=4)
        if res is None:
            return todo[i:]
        got = {r.get("scene"): r for r in res.get("scenes", [])}
        for sid in part:
            r = got.get(sid) or {}
            if r.get("error") or not r.get("key"):
                show(sid, {"scene": sid, "error": r.get("error") or "渲染机没有返回这一镜"})
                continue
            cfg, digest = digests[sid]
            remote.download(r["key"], path("clips", f"{sid}.mp4"))
            meta = {"scene": sid, "hash": digest, "duration": r.get("duration"), "frames": r.get("frames"), "fps": cfg["fps"],
                    "size": f"{cfg['width']}x{cfg['height']}", "render_s": r.get("render_s"), "shards": r.get("shards"),
                    "frame_s": r.get("frame_s"), "key": r["key"], "renderer": res.get("instance")}
            json.dump(meta, open(path("clips", f"{sid}.json"), "w"), indent=1)
            _publish(sid, meta, reused=False)
            out = {k: r[k] for k in ("scene", "duration", "frames", "render_s", "shards", "frame_s") if k in r}
            out.update(hash=digest, reused=False, renderer=res.get("instance"))
            for k in ("note_webgl", "page_errors", "blocked_requests", "note", "gpu_fallback"):
                if r.get(k):
                    out[k] = r[k]
            show(sid, out)
    return []


def main():
    ap = argparse.ArgumentParser(prog="slate-render", description="渲染一镜或几镜（自动分片并行，内容不变时复用）")
    ap.add_argument("scenes", nargs="+", help="镜头编号，如 01 02；all 表示全部")
    ap.add_argument("--force", action="store_true", help="忽略缓存，强制重新渲染")
    a = ap.parse_args()
    ids = [s["id"] for s in storyboard()["scenes"]] if a.scenes == ["all"] else a.scenes

    def show(sid, r):  # 一镜做完就打印一行；失败时停下，交给 Agent 修
        if r.get("error"):
            emit("error", message=f"第 {sid} 镜渲染失败：{str(r['error'])[:200]}")
            print(json.dumps({"scene": sid, "error": str(r["error"])[:800]}, ensure_ascii=False), flush=True)
            sys.exit(2)
        print(json.dumps(r, ensure_ascii=False), flush=True)

    from . import remote
    if remote.enabled():
        ids = render_remote(ids, a.force, show)  # 剩下的是渲染机没接手的（调不通），改用本机方式
    for sid in ids:
        try:
            r = asyncio.run(render_scene(sid, a.force))
        except Exception as e:
            emit("error", message=f"第 {sid} 镜渲染失败：{str(e)[:200]}")
            print(json.dumps({"scene": sid, "error": str(e)[:800]}, ensure_ascii=False))
            sys.exit(2)
        print(json.dumps(r, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
