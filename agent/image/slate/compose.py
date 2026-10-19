"""slate-compose：按分镜顺序拼接各镜片段，混入配音和背景音乐，生成 out/final.mp4 并发布为新版本。

- 视频：各镜片段编码参数相同，直接无损拼接；
- 音频：每镜的配音放在这一镜的起点；背景音乐循环铺满全片，音量压低；都没有时补一条静音轨；
- 上传到 final/<turnId>.mp4，发出 version 事件（版本号由服务端分配）。

长片：
- 章节会话里运行时，合成的是这一章（不加背景音乐），上传到 chapters/<章号>/<turnId>.mp4，发出 chapter_final 事件；
- slate-compose --chapters：在主会话里按总纲顺序把各章最新的成片拼起来，统一加背景音乐，发布为新版本。
"""
import argparse, json, os, subprocess, sys, time

from .common import OPT, chapter, ctx, die, emit, ffmpeg, key, load_json, media_duration, path, s3, spec, storyboard, upload

BGM_DIR = os.path.join(OPT, "assets", "bgm")


def ensure_clip(sid):
    p, meta = path("clips", f"{sid}.mp4"), load_json(path("clips", f"{sid}.json"), {})
    if os.path.isfile(p):
        return p, meta
    c, cli = ctx(), s3()
    if meta.get("key") and cli:  # 会话被回收后：按记录的 key 从 S3 取回
        os.makedirs(path("clips"), exist_ok=True)
        cli.download_file(c["bucket"], meta["key"], p)
        return p, meta
    die(f"第 {sid} 镜还没有渲染，先运行 slate-render {sid}")


def bgm_path(name):
    bp = os.path.join(BGM_DIR, f"{name}.mp3")
    if not os.path.isfile(bp):
        have = sorted(f[:-4] for f in os.listdir(BGM_DIR) if f.endswith(".mp3")) if os.path.isdir(BGM_DIR) else []
        die(f"没有这首背景音乐：{name}（可选：{', '.join(have) or '无'}）")
    return bp


def stream_sig(p):
    """视频流的编码参数（编码器、像素格式、分辨率、帧率）：拼接前确认各章一致，才能无损拼接"""
    import re
    r = subprocess.run([ffmpeg(), "-hide_banner", "-i", p], capture_output=True, text=True)
    line = next((x for x in r.stderr.splitlines() if "Video:" in x), "")
    pick = lambda pat: (re.search(pat, line) or [None, "?"])[1]  # noqa: E731
    return (pick(r"Video: (\w+)"), pick(r"(yuv\w+)"), pick(r"(\d{2,5}x\d{2,5})"), pick(r"([\d.]+) fps"))


def stitch(a):
    """主会话：按总纲把各章最新的成片拼起来，加背景音乐，发布新版本"""
    outline = load_json(path("outline.json"))
    if not outline:
        die("找不到 outline.json")
    c, cli = ctx(), s3()
    if not cli:
        die("没有本任务的凭证，无法下载各章成片")
    os.makedirs(path("out", "chapters"), exist_ok=True)
    parts, missing = [], []
    for ch in outline["chapters"]:
        objs = cli.list_objects_v2(Bucket=c["bucket"], Prefix=key("chapters", ch["id"]) + "/").get("Contents", [])
        mp4 = sorted((o for o in objs if o["Key"].endswith(".mp4")), key=lambda o: o["LastModified"])
        if not mp4:
            missing.append(ch["id"]); continue
        local = path("out", "chapters", f"{ch['id']}.mp4")
        cli.download_file(c["bucket"], mp4[-1]["Key"], local)
        parts.append(local)
    if missing:
        die(f"这些章还没有成片：{', '.join(missing)}")
    sigs = {stream_sig(p) for p in parts}
    if len(sigs) > 1:
        die(f"各章的画面编码参数不一致，不能直接拼接：{sigs}")
    lst = path("out", "chapters.txt")
    open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
    total = sum(media_duration(p) for p in parts)
    out = path("out", "final.mp4")
    bgm = a.bgm or outline.get("bgm") or (load_json(path("brief.json"), {}) or {}).get("bgm")
    cmd = [ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst]
    if bgm:
        cmd += ["-stream_loop", "-1", "-i", bgm_path(bgm), "-filter_complex",
                f"[1:a]aresample=48000,volume={a.bgm_volume},afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5[bgm];"
                f"[0:a][bgm]amix=inputs=2:normalize=0:dropout_transition=0,atrim=0:{total:.3f},aformat=sample_rates=48000:channel_layouts=stereo[aout]",
                "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-c", "copy"]
    cmd += ["-t", f"{total:.3f}", "-movflags", "+faststart", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"拼接失败：{r.stderr[-500:]}")
    dur = round(media_duration(out), 2)
    res = {"file": "out/final.mp4", "duration": dur, "chapters": len(parts), "mb": round(os.path.getsize(out) / 1e6, 1)}
    if not a.dry_run:
        k = upload(out, "final", f"{c.get('turnId', 'local')}-{int(time.time())}.mp4", content_type="video/mp4")  # 每次合成一个新文件，CDN 不会给出旧的
        if k:
            emit("version", key=k, dur=dur, chapters=[ch["id"] for ch in outline["chapters"]])
            res["published"] = True
    print(json.dumps(res, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(prog="slate-compose", description="合成成片并发布新版本")
    ap.add_argument("--bgm", help="背景音乐编号（见 /opt/slate/assets/bgm/），不填则用分镜里的 bgm 字段")
    ap.add_argument("--bgm-volume", type=float, default=0.12)
    ap.add_argument("--chapters", action="store_true", help="长片：在主会话里把各章成片拼成整片")
    ap.add_argument("--dry-run", action="store_true", help="只在本地合成，不发布")
    a = ap.parse_args()
    if a.chapters:
        return stitch(a)
    ch = chapter()
    sb = storyboard()
    clips, offsets, t = [], [], 0.0
    for s in sb["scenes"]:
        p, meta = ensure_clip(s["id"])
        d = media_duration(p)
        clips.append(p); offsets.append((s["id"], t)); t += d
    total = t
    os.makedirs(path("out"), exist_ok=True)
    lst = path("out", "concat.txt")
    open(lst, "w").write("".join(f"file '{p}'\n" for p in clips))

    inputs = ["-f", "concat", "-safe", "0", "-i", lst]  # 输入 0：视频
    n_in = 1
    filters, mix = [], []
    for sid, off in offsets:
        v = path("voice", f"{sid}.mp3")
        if os.path.isfile(v):
            inputs += ["-i", v]
            ms = int(off * 1000)
            filters.append(f"[{n_in}:a]aresample=48000,adelay={ms}|{ms},apad[v{sid}]")
            mix.append(f"[v{sid}]"); n_in += 1
    bgm = None if ch else (a.bgm or sb.get("bgm"))  # 章节不加背景音乐：拼成整片后统一加，章与章之间不断
    if bgm:
        bp = bgm_path(bgm)
        inputs += ["-stream_loop", "-1", "-i", bp]
        filters.append(f"[{n_in}:a]aresample=48000,volume={a.bgm_volume},afade=t=out:st={max(0, total - 1.5):.2f}:d=1.5[bgm]")
        mix.append("[bgm]"); n_in += 1
    out = path("out", "final.mp4")
    cmd = [ffmpeg(), "-y", "-loglevel", "error", *inputs]
    if mix:
        filters.append(f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:dropout_transition=0,atrim=0:{total:.3f},"
                       f"aformat=sample_rates=48000:channel_layouts=stereo[aout]")
        cmd += ["-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]"]
    else:
        cmd += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a"]
    cmd += ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", f"{total:.3f}", "-movflags", "+faststart", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"合成失败：{r.stderr[-500:]}")
    dur = round(media_duration(out), 2)
    res = {"file": "out/final.mp4", "duration": dur, "scenes": len(clips), "mb": round(os.path.getsize(out) / 1e6, 2)}
    if not a.dry_run:
        turn = ctx().get("turnId", "local")
        k = upload(out, *(("chapters", ch) if ch else ("final",)), f"{turn}-{int(time.time())}.mp4", content_type="video/mp4")
        if k:
            scenes = [{"id": s["id"], "hash": load_json(path("clips", f"{s['id']}.json"), {}).get("hash")} for s in sb["scenes"]]
            emit("chapter_final" if ch else "version", key=k, dur=dur, scenes=scenes)
            res["published"] = True
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
