"""参考视频的数值分析（slate-style 用，只依赖 ffmpeg、numpy、Pillow）：拆帧、切点、动作强度、配色、联系表、动作条，
以及重建场景和参考的逐帧对比指标。做法见 docs/style-creator-design.md 的实测一节。
"""
import json, os, re, subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
SW, SH = 192, 108          # 算数字用的小图


def font(size):
    for p in ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def info(path):
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True)
    s = r.stderr
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", s)
    v = re.search(r"Video: .*?(\d{2,5})x(\d{2,5})", s)
    f = re.search(r"([\d.]+) fps", s)
    if not d or not v:
        raise RuntimeError("读不出视频信息：" + s[-500:])
    return {"duration": int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)),
            "width": int(v.group(1)), "height": int(v.group(2)), "fps": float(f.group(1)) if f else None,
            "audio": "Audio:" in s}


# 一次解码进内存的上限。会话的内存不大，1080p 一帧就是 6 MB，几秒钟的原分辨率帧就能把会话撑掉（会话会被直接回收）
MAX_BYTES = 800 << 20


def _cmd(path, fps, w, h, start, dur, crop):
    cmd = [FFMPEG, "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{max(0, start):.3f}"]
    cmd += ["-i", path]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    vf = (f"crop={crop}," if crop else "") + f"fps={fps},scale={w}:{h}:flags=area"
    return cmd + ["-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]


def decode(path, fps, w, h, start=None, dur=None, crop=None):
    """按 fps 解码成 w×h 的 RGB 帧数组 (N, h, w, 3)。crop 是原分辨率上的 "宽:高:x:y"（先裁再缩放）。
    帧太多、放不进内存时报错：改用 stream() 一帧一帧处理，或者缩小尺寸、缩短时长、只裁需要的区域"""
    n = fps * (dur if dur is not None else max(0.0, info(path)["duration"] - (start or 0)))
    if n * w * h * 3 > MAX_BYTES:
        raise RuntimeError(f"一次要解码约 {int(n)} 帧 {w}×{h}（{n * w * h * 3 / 1048576:.0f} MB），会撑爆会话内存："
                           f"用 vframes.stream() 一帧一帧处理，或者缩小尺寸、缩短时长、用 crop 只取需要的区域")
    raw = subprocess.run(_cmd(path, fps, w, h, start, dur, crop), capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def stream(path, fps, w, h, start=None, dur=None, crop=None):
    """和 decode() 一样，但一帧一帧地给出 (帧号, 帧)，内存里只有一帧：原分辨率逐帧测量用这个"""
    p = subprocess.Popen(_cmd(path, fps, w, h, start, dur, crop), stdout=subprocess.PIPE)
    size, i = w * h * 3, 0
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        p.stdout.close(); p.kill(); p.wait()


def grab(path, t, out):
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", path, "-ss", f"{t:.3f}", "-frames:v", "1", out], check=True)


def tc(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def gray(fr):
    return fr[..., 0] * 0.299 + fr[..., 1] * 0.587 + fr[..., 2] * 0.114


def hist(fr):
    q = (fr // 32).astype(np.int32)
    idx = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    h = np.bincount(idx.ravel(), minlength=512).astype(np.float64)
    return h / h.sum()


def analyse(frames):
    g = gray(frames.astype(np.float32))
    energy = np.zeros(len(frames))
    energy[1:] = np.abs(np.diff(g, axis=0)).mean(axis=(1, 2)) / 255
    hd = np.zeros(len(frames))
    hs = [hist(f) for f in frames]
    for i in range(1, len(frames)):
        hd[i] = 0.5 * np.abs(hs[i] - hs[i - 1]).sum()
    return energy, hd


def find_cuts(energy, hd, fps):
    """切点：颜色分布突变，或者整幅画面在一两帧里突变（动效片常常背景不变、只换版面，所以按强度的相对值判断）"""
    top = float(energy.max()) if len(energy) else 0
    thr = max(0.035, 0.3 * top)
    w = int(0.3 * fps)
    cuts, last = [], -10 ** 9
    for i in range(1, len(energy)):
        lo, hi = max(1, i - w), min(len(energy), i + w + 1)
        big = energy[i] >= thr and energy[i] >= energy[lo:hi].max()
        if (hd[i] > 0.35 or big) and i - last >= 0.3 * fps:
            cuts.append(i); last = i
    return cuts


def peaks(e, fps, lo, hi, thr, gap):
    """一段里的动作峰值（平滑后），彼此至少隔 gap 秒"""
    s = np.convolve(e, np.ones(3) / 3, mode="same")
    cand = [i for i in range(max(lo, 1), min(hi, len(s) - 1)) if s[i] >= thr and s[i] >= s[i - 1] and s[i] >= s[i + 1]]
    cand.sort(key=lambda i: -s[i])
    out = []
    for i in cand:
        if all(abs(i - j) >= gap * fps for j in out):
            out.append(i)
    return sorted(out), s


def holds(e, fps, lo, hi, thr=0.0015, min_s=0.4):
    out, run = [], None
    for i in range(lo, hi):
        if e[i] < thr:
            run = i if run is None else run
        else:
            if run is not None and i - run >= min_s * fps:
                out.append([round(run / fps, 2), round(i / fps, 2)])
            run = None
    if run is not None and hi - run >= min_s * fps:
        out.append([round(run / fps, 2), round(hi / fps, 2)])
    return out


def kmeans(px, k, iters=15):
    px = px.astype(np.float64)
    rng = np.random.default_rng(0)
    c = [px[rng.integers(len(px))]]
    for _ in range(1, k):  # k-means++，种子固定，结果可复现
        d = np.min([((px - ci) ** 2).sum(1) for ci in c], axis=0)
        c.append(px[rng.choice(len(px), p=d / d.sum())] if d.sum() > 0 else px[0])
    c = np.array(c)
    for _ in range(iters):
        lab = np.argmin(((px[:, None, :] - c[None]) ** 2).sum(2), axis=1)
        nc = np.array([px[lab == j].mean(0) if (lab == j).any() else c[j] for j in range(k)])
        if np.allclose(nc, c):
            break
        c = nc
    lab = np.argmin(((px[:, None, :] - c[None]) ** 2).sum(2), axis=1)
    return c, np.bincount(lab, minlength=k) / len(px)


def palette(frames, k=8):
    """全片配色：按面积排序；border 是这种颜色在画面边缘一圈里的占比（高的一般是背景）"""
    sub = frames[:, ::2, ::2].reshape(-1, 3)
    if len(sub) > 60000:
        sub = sub[np.linspace(0, len(sub) - 1, 60000).astype(int)]
    c, share = kmeans(sub, k)
    m = np.zeros(frames.shape[1:3], bool)
    bh, bw = max(1, frames.shape[1] // 10), max(1, frames.shape[2] // 10)
    m[:bh] = m[-bh:] = True; m[:, :bw] = True; m[:, -bw:] = True
    border = frames[:, m].reshape(-1, 3).astype(np.float64)
    bl = np.argmin(((border[:, None, :] - c[None]) ** 2).sum(2), axis=1)
    bshare = np.bincount(bl, minlength=k) / len(border)
    order = np.argsort(-share)
    out = []
    for j in order:
        h = "#%02x%02x%02x" % tuple(int(round(x)) for x in c[j])
        if any(np.linalg.norm(c[j] - np.array([int(o["hex"][i:i + 2], 16) for i in (1, 3, 5)])) < 18 for o in out):
            continue  # 和已有的几乎一样
        out.append({"hex": h, "share": round(float(share[j]), 3), "border": round(float(bshare[j]), 3)})
    return out


def grid(images, labels, cols, cell_w, out):
    cell_h = int(round(cell_w * images[0].shape[0] / images[0].shape[1]))
    rows = (len(images) + cols - 1) // cols
    f = font(18)
    img = Image.new("RGB", (cols * cell_w, rows * (cell_h + 26)), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for i, (im, lab) in enumerate(zip(images, labels)):
        x, y = (i % cols) * cell_w, (i // cols) * (cell_h + 26)
        img.paste(Image.fromarray(im).resize((cell_w - 4, cell_h - 4)), (x + 2, y + 26))
        d.text((x + 6, y + 3), lab, fill=(200, 30, 30), font=f)
    img.save(out)


def plot_energy(e, cuts, evs, fps, out):
    W, H, pad = 1800, 320, 40
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    n = len(e)
    top = max(float(np.percentile(e, 99.5)), 1e-3)
    x = lambda i: pad + (W - 2 * pad) * i / max(1, n - 1)
    y = lambda v: H - pad - (H - 2 * pad) * min(1.0, v / top)
    f = font(14)
    for s in range(int(n / fps) + 1):
        d.line([(x(s * fps), H - pad), (x(s * fps), H - pad + 5)], fill=(120, 120, 120))
        d.text((x(s * fps) - 6, H - pad + 8), str(s), fill=(80, 80, 80), font=f)
    for c in cuts:
        d.line([(x(c), pad), (x(c), H - pad)], fill=(220, 40, 40), width=2)
    d.line([(x(i), y(e[i])) for i in range(n)], fill=(30, 30, 30), width=2)
    for i in evs:
        d.ellipse([x(i) - 4, y(e[i]) - 4, x(i) + 4, y(e[i]) + 4], fill=(40, 90, 220))
    d.text((pad, 8), "动作强度（每帧和前一帧的平均差）；横轴秒；红线 = 切点；蓝点 = 动作峰值", fill=(0, 0, 0), font=font(16))
    img.save(out)


def probe(video, out, max_strips=16):
    """拆帧：镜头表、切点、每镜的动作峰值和静止段、节奏统计、配色，以及关键帧、联系表、动作条。结果写进 <out>/probe.json 并返回"""
    os.makedirs(os.path.join(out, "keys"), exist_ok=True)
    os.makedirs(os.path.join(out, "strips"), exist_ok=True)
    meta = info(video)
    FPS = min(30, int(round(meta["fps"] or 30)))  # 按原片帧率解码：补出来的重复帧会被当成"静止"
    fr = decode(video, FPS, SW, SH)
    n = len(fr)
    energy, hd = analyse(fr)
    cuts = find_cuts(energy, hd, FPS)
    bounds = [0] + cuts + [n]
    thr = max(0.004, float(np.percentile(energy, 75)))
    shots, all_ev = [], []
    for k in range(len(bounds) - 1):
        lo, hi = bounds[k], bounds[k + 1]
        evs, _ = peaks(energy, FPS, lo + 2, hi - 1, thr, 0.4)
        all_ev += evs
        seg = energy[lo + 1:hi] if hi - lo > 1 else energy[lo:hi]
        still = lo + 1 + int(np.argmin(np.convolve(seg, np.ones(5) / 5, mode="same"))) if len(seg) > 5 else (lo + hi) // 2
        shots.append({"i": k + 1, "start": round(lo / FPS, 2), "end": round(hi / FPS, 2), "dur": round((hi - lo) / FPS, 2),
                      "motion": round(float(energy[lo + 1:hi].mean()) if hi - lo > 1 else 0.0, 4),
                      "events": [round(i / FPS, 2) for i in evs], "holds": holds(energy, FPS, lo + 1, hi),
                      "still": round(still / FPS, 2)})
    durs = np.array([s["dur"] for s in shots])
    stats = {"shots": len(shots), "asl": round(float(durs.mean()), 2), "median": round(float(np.median(durs)), 2),
             "min": round(float(durs.min()), 2), "max": round(float(durs.max()), 2),
             "cutsPerMin": round(len(cuts) / (n / FPS) * 60, 1),
             "stillShare": round(float((energy < 0.0015).mean()), 3), "motionThreshold": round(thr, 4)}
    # 关键帧：每镜开头、中间、结尾和最静止的一帧（镜头多时只留开头和最静止）
    keys = []
    for s in shots:
        ts = [s["start"] + 0.07, s["still"]] if len(shots) > 20 else [s["start"] + 0.07, (s["start"] + s["end"]) / 2, s["end"] - 0.1, s["still"]]
        for t in sorted(set(round(min(max(0.0, t), meta["duration"] - 0.05), 2) for t in ts)):
            p = os.path.join(out, "keys", f"s{s['i']:02d}-{t:06.2f}.png")
            grab(video, t, p)
            keys.append(p)
    # 联系表：每 0.5 秒一帧，24 格一张
    small = decode(video, 2, 384, 216)
    sheets = []
    for j in range(0, len(small), 24):
        p = os.path.join(out, f"sheet-{j // 24 + 1}.png")
        grid(list(small[j:j + 24]), [tc(i * 0.5) for i in range(j, min(j + 24, len(small)))], 6, 320, p)
        sheets.append(p)
    # 动作条：切点（转场）和动作峰值，按强度挑，彼此至少隔 1 秒
    cand = [(float(hd[c] + energy[c]), c, "cut") for c in cuts] + [(float(energy[i]), i, "move") for i in all_ev]
    cand.sort(key=lambda x: -x[0])
    chosen = []
    for _, i, kind in cand:
        if all(abs(i - j) >= FPS for _, j in chosen):
            chosen.append((kind, i))
        if len(chosen) >= max_strips:
            break
    strips = []
    for kind, i in sorted(chosen, key=lambda x: x[1]):
        t0 = max(0.0, i / FPS - (0.5 if kind == "cut" else 0.25))
        sfr = decode(video, 12, 384, 216, start=t0, dur=1.25)[:15]
        if len(sfr) == 0:
            continue
        p = os.path.join(out, "strips", f"{kind}-{i / FPS:06.2f}.png")
        grid(list(sfr), [tc(t0 + k / 12) for k in range(len(sfr))], 5, 360, p)
        strips.append({"file": p, "kind": kind, "at": round(i / FPS, 2), "from": round(t0, 2)})
    plot_energy(energy, cuts, all_ev, FPS, os.path.join(out, "energy.png"))
    res = {"video": os.path.abspath(video), **meta, "stats": stats, "palette": palette(fr[::3]), "shots": shots,
           "cuts": [round(c / FPS, 2) for c in cuts], "keys": keys, "sheets": sheets, "strips": strips,
           "energy": [round(float(x), 4) for x in energy]}
    json.dump(res, open(os.path.join(out, "probe.json"), "w"), ensure_ascii=False, indent=1)
    return res


# ---------------------------------------------------------------- 重建和参考的逐帧对比

def lab(rgb):
    c = np.asarray(rgb, np.float64) / 255
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def edges(a):
    g = gray(a.astype(np.float32))
    gx = np.abs(np.diff(g, axis=1))[:-1]
    gy = np.abs(np.diff(g, axis=0))[:, :-1]
    return gx + gy


def corr(x, y):
    x, y = x.ravel() - x.mean(), y.ravel() - y.mean()
    d = np.sqrt((x * x).sum() * (y * y).sum())
    return float((x * y).sum() / d) if d > 0 else (1.0 if not x.any() and not y.any() else 0.0)


def energy_curve(stack):
    g = gray(stack.astype(np.float32))
    e = np.zeros(len(stack))
    e[1:] = np.abs(np.diff(g, axis=0)).mean(axis=(1, 2)) / 255
    return e


def peak_times(e, fps):
    if len(e) < 3 or e.max() <= 0:
        return []
    thr = max(0.004, 0.25 * e.max())
    return [i / fps for i in range(1, len(e) - 1) if e[i] >= thr and e[i] >= e[i - 1] and e[i] >= e[i + 1]]


def palette_delta(ref, rec):
    pr, pc = palette(ref[::2]), palette(rec[::2])
    hexrgb = lambda h: [int(h[i:i + 2], 16) for i in (1, 3, 5)]
    lc = lab(np.array([hexrgb(p["hex"]) for p in pc]))
    tot, acc, detail = 0.0, 0.0, []
    for p in pr:
        if p["share"] < 0.02:
            continue
        d = np.linalg.norm(lc - lab(np.array(hexrgb(p["hex"]))), axis=1)
        j = int(np.argmin(d))
        acc += p["share"] * float(d[j]); tot += p["share"]
        detail.append({"ref": p["hex"], "share": p["share"], "nearest": pc[j]["hex"], "deltaE": round(float(d[j]), 1)})
    return (acc / tot if tot else 0.0), detail


def plot_pair(er, ec, fps, out):
    W, H, pad = 1400, 260, 30
    img = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(img)
    top = max(float(max(er.max(), ec.max())), 1e-3)
    n = len(er)
    x = lambda i: pad + (W - 2 * pad) * i / max(1, n - 1)
    y = lambda v: H - pad - (H - 2 * pad) * min(1.0, v / top)
    for s in range(int(n / fps) + 1):
        d.line([(x(s * fps), H - pad), (x(s * fps), H - pad + 5)], fill=(120, 120, 120))
        d.text((x(s * fps) - 4, H - pad + 8), str(s), fill=(80, 80, 80), font=font(13))
    d.line([(x(i), y(er[i])) for i in range(n)], fill=(20, 20, 20), width=2)
    d.line([(x(i), y(ec[i])) for i in range(len(ec))], fill=(40, 90, 220), width=2)
    d.text((pad, 6), "动作强度：黑 = 参考，蓝 = 重建；横轴是段内秒数", fill=(0, 0, 0), font=font(15))
    img.save(out)
