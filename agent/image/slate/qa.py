"""slate-qa NN [NN ...]：确定性自检（不调用模型）。

在一镜里均匀抽 6 个时间点：
- 文字：是否越出安全框、压到字幕区、互相重叠、被截断（读 DOM 包围盒）；
- 画面：是否空白（亮度方差太小）、前后几乎不变（可能没动起来）；
- 时长：已渲染片段的时长和分镜是否一致；
- 页面报错、被拦截的外部请求；
- 用户给的图片（docs/image-refs-design.md）：分镜说这一镜用的图，代码里要引用、至少一个抽样点看得见；不变形；
  没有超出安全区、压到字幕区、被别的元素盖住三成以上（这三项只是警告）。认图片靠文件名：/input/images/iNN.*，或者以 iNN 开头的处理后文件。
  标了 data-qa="ignore" 的装饰副本（光晕、扫光）不查，也不算挡住；同一张图叠在上面的另一份也不算挡住。
同时把 6 帧拼成一张缩略图 qa/NN.png，可以交给 slate-look 看。结果写到 qa/NN.json。
"""
import argparse, asyncio, glob, io, json, os, re, sys

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat
from playwright.async_api import async_playwright

from . import page as pg
from .common import load_json, media_duration, path, spec
from .render import _subtitles_on, scene_of

SAMPLES = 6
FONT = "/usr/share/fonts/google-noto-cjk/NotoSansCJKsc-Regular.otf"

# 页面里显示用户图片的元素（<img>、SVG <image>、背景图）：位置、透明度、拉伸比例、被盖住的比例。
# 不放进运行时：运行时的内容算在每一镜的片段指纹里，改它会让所有片段重渲
IMG_QA = r"""(cap) => {
  const S = window.SLATE, W = S.width, H = S.height, safe = S.safe, cz = S.captionZone;
  const re = /(?:^|\/)(i\d{2})(?:[-_][^\/?#]*)?\.(?:png|jpe?g|webp)(?:[?#]|$)/i;
  const idOf = u => { try { const m = re.exec(decodeURIComponent(u || "")); return m ? m[1].toLowerCase() : null; } catch (e) { return null; } };
  const opac = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden") return 0; o *= +cs.opacity; } return o; };
  const SHAPES = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line", "text", "tspan", "use", "image"]);
  const paints = e => {  // 这个点上它是不是真的画了东西（透明的容器、整屏的空 div 不算）
    if (opac(e) < 0.05) return false;
    const tag = e.tagName.toLowerCase(), cs = getComputedStyle(e);
    if (tag === "canvas" || tag === "svg") return false;  // 画布里画了什么测不到，不算遮挡
    if (e instanceof SVGElement) return SHAPES.has(tag) && (cs.fill !== "none" || cs.stroke !== "none");
    if (tag === "img" || tag === "video") return true;
    if (cs.backgroundImage !== "none") return true;
    const bg = cs.backgroundColor.match(/[\d.]+/g);
    if (bg && (bg.length < 4 ? true : +bg[3] > 0.05) && cs.backgroundColor !== "transparent") return true;
    return [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
  };
  const cands = [];
  for (const el of document.querySelectorAll("img")) cands.push([el, el.currentSrc || el.src, "img"]);
  for (const el of document.querySelectorAll("image")) cands.push([el, el.href && el.href.baseVal || el.getAttribute("href") || "", "svg"]);
  for (const el of document.querySelectorAll("body *")) {
    const m = /url\(["']?([^"')]+)/.exec(getComputedStyle(el).backgroundImage || "");
    if (m) cands.push([el, m[1], "bg"]);
  }
  const out = [];
  for (const [el, src, type] of cands) {
    const id = idOf(src);
    if (!id || el.closest("[data-slate=caption]") || el.closest("[data-qa=ignore]")) continue;  // 装饰用的副本（光晕、高光）不查
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
    const op = opac(el), it = { id, type, box: [r.left, r.top, r.width, r.height].map(Math.round), visible: x1 - x0 > 2 && y1 - y0 > 2 && op > 0.05 };
    if (!it.visible) { out.push(it); continue; }
    if (type === "img" && el.naturalWidth && ["fill", ""].includes(getComputedStyle(el).objectFit))
      it.stretch = +((r.width / r.height) / (el.naturalWidth / el.naturalHeight)).toFixed(3);
    it.full = r.width >= W * 0.9 && r.height >= H * 0.9;  // 铺满整屏的背景图不查安全区和字幕区
    if (!it.full) {
      it.outside = r.left < safe.x - 2 || r.top < safe.y - 2 || r.right > safe.x + safe.w + 2 || r.bottom > safe.y + safe.h + 2;
      if (cap && cz) it.caption = +(Math.max(0, Math.min(r.right, cz.x + cz.w) - Math.max(r.left, cz.x)) *
                                    Math.max(0, Math.min(r.bottom, cz.y + cz.h) - Math.max(r.top, cz.y)) / (r.width * r.height)).toFixed(2);
    }
    let hit = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const px = x0 + (x1 - x0) * (i + 0.5) / 5, py = y0 + (y1 - y0) * (j + 0.5) / 5;
      for (const e of document.elementsFromPoint(px, py)) {
        if (e === el || el.contains(e)) break;  // 先碰到图片自己（或者它里面的东西）：没被盖住
        if (e.closest("[data-slate=caption]") || e.closest("[data-qa=ignore]")) continue;  // 字幕另外查；装饰副本是故意叠上去的
        if (e.tagName === "IMG" && idOf(e.currentSrc || e.src) === id) continue;  // 同一张图的另一份（扫光、描边）不算挡住
        if (paints(e)) { hit++; break; }
      }
    }
    it.covered = hit / 25;
    out.push(it);
  }
  return out;
}"""


async def check(sid):
    s, sp = scene_of(sid), spec()
    cfg = pg.scene_config(s, sp, subtitles=_subtitles_on())
    dur = cfg["duration"]
    times = [round(dur * (i + 0.5) / SAMPLES, 2) for i in range(SAMPLES)]
    issues, shots, texts, imgs = [], [], {}, []
    async with async_playwright() as pw:
        async with pg.ScenePage(pw, sid, cfg, name=f"slate_qa{sid}_{os.getpid()}") as page:
            for t in times:
                await page.frame(t)
                q = await page.page.evaluate("window.__slateQA()")
                for it in q["issues"]:
                    issues.append({"t": t, **it})
                texts[str(t)] = [x["text"] for x in q["texts"]][:12]
                imgs.append((t, await page.page.evaluate(IMG_QA, bool(_subtitles_on()))))
                shots.append(Image.open(io.BytesIO(await page.png())).convert("RGB"))
            errors, blocked = page.errors, page.blocked
    issues += image_issues(sid, s, imgs)
    # 画面检查
    stds = [round(sum(ImageStat.Stat(im.convert("L").resize((160, 90))).stddev), 1) for im in shots]
    for t, sd in zip(times, stds):
        if sd < 4:
            issues.append({"t": t, "kind": "blank", "text": f"画面几乎是纯色（亮度标准差 {sd}）"})
    diffs = [round(sum(ImageStat.Stat(ImageChops.difference(a.resize((160, 90)), b.resize((160, 90)))).mean), 2)
             for a, b in zip(shots, shots[1:])]
    if dur >= 4 and diffs and max(diffs) < 0.5 and max(changed_share(a, b) for a, b in zip(shots, shots[1:])) < 0.002:
        issues.append({"t": None, "kind": "static", "text": "6 个采样点画面几乎一样，这一镜可能没有动起来"})
    # 时长检查
    clip = path("clips", f"{sid}.mp4")
    clip_dur = round(media_duration(clip), 2) if os.path.isfile(clip) else None
    if clip_dur and abs(clip_dur - dur) > max(0.2, dur * 0.05):
        issues.append({"t": None, "kind": "duration", "text": f"片段 {clip_dur}s 和分镜 {dur}s 不一致，需要重新渲染"})
    for e in sorted(set(errors))[:5]:
        issues.append({"t": None, "kind": "page_error", "text": e[:200]})
    for b in sorted(set(blocked))[:5]:
        issues.append({"t": None, "kind": "external_request", "text": f"请求了外部地址（已拦截）：{b[:120]}"})
    # 缩略图
    os.makedirs(path("qa"), exist_ok=True)
    sheet_p = path("qa", f"{sid}.png")
    _sheet(shots, times, sheet_p)
    res = {"scene": sid, "ok": not [x for x in issues if x.get("level") != "warn"], "issues": _dedupe(issues), "texts": texts, "frame_std": stds,
           "clip_duration": clip_dur, "storyboard_duration": dur, "contact_sheet": f"qa/{sid}.png"}
    json.dump(res, open(path("qa", f"{sid}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return res


def scene_code(sid):
    """这一镜的代码，加上它引用的共用目录（scenes/_xxx/）里的代码"""
    def text(d):
        return "".join(open(p, encoding="utf-8", errors="ignore").read() for p in glob.glob(os.path.join(path("scenes", d), "**", "*.*"), recursive=True)
                       if p.endswith((".html", ".js", ".mjs", ".css")))
    own = text(sid)
    return own + "".join(text(d) for d in sorted(set(re.findall(r"\.\./(_[A-Za-z0-9_-]+)/", own))))


def image_issues(sid, scene, frames):
    """frames：[(t, IMG_QA 的结果)]。分镜写了要用的图：代码里要引用、至少一个抽样点看得见；看得见的不能变形。
    超出安全区、压字幕、被盖住只报警告：故意出血的版式、叠在图上的标注由 Agent 自己判断"""
    want, out = list(scene.get("images") or []), []
    code = scene_code(sid)
    seen = {}
    for t, items in frames:
        for it in items:
            seen.setdefault(it["id"], []).append((t, it))
    for iid in want:
        if not re.search(rf"(?<![\w-]){iid}(?:[-_][\w.-]*)?\.(?:png|jpe?g|webp)", code, re.I):
            out.append({"t": None, "kind": "image_missing", "text": f"分镜说这一镜用 {iid}，代码里没有引用它（写完整的路径，比如 /input/images/{iid}.png 或 ../_shared/{iid}-cut.png）"})
        elif not any(it["visible"] for _, it in seen.get(iid, [])):
            out.append({"t": None, "kind": "image_hidden", "text": f"{iid} 在 {len(frames)} 个抽样时间点都看不见（透明、在画面外，或者没加载出来）"})
    for iid in sorted(set(seen) - set(want)):
        out.append({"t": None, "kind": "image_unlisted", "level": "warn", "text": f"代码里用了 {iid}，但分镜里这一镜的 images 没写它：补进分镜并重新发布"})
    for iid, hits in seen.items():
        for t, it in hits:
            if not it["visible"]:
                continue
            if it.get("stretch") and abs(it["stretch"] - 1) > 0.02:
                out.append({"t": t, "kind": "image_stretched", "text": f"{iid} 被拉伸了（宽高比是原图的 {it['stretch']} 倍）：保持原图比例，或者用 object-fit: contain/cover", "box": it["box"]})
            if it.get("outside"):
                out.append({"t": t, "kind": "image_outside_safe", "level": "warn", "text": f"{iid} 超出了安全区", "box": it["box"]})
            if (it.get("caption") or 0) > 0.15:
                out.append({"t": t, "kind": "image_under_caption", "level": "warn", "text": f"{iid} 有 {round(it['caption'] * 100)}% 压在字幕区里", "box": it["box"]})
            if it.get("covered", 0) > 0.3:
                out.append({"t": t, "kind": "image_covered", "level": "warn", "text": f"{iid} 大约 {round(it['covered'] * 100)}% 被别的元素盖住了，确认主体露出来", "box": it["box"]})
    return out


def changed_share(a, b, size=(480, 270), level=24):
    """两帧之间明显变了的像素占比。深色底、细线条的画面里，动的零件很小，平均差异看不出来，要数像素"""
    d = ImageChops.difference(a.resize(size), b.resize(size)).convert("L")
    hist = d.histogram()
    return sum(hist[level:]) / (size[0] * size[1])


def _dedupe(issues):
    seen, out = set(), []
    for it in issues:
        k = (it["kind"], it.get("text"))
        if k in seen:
            continue
        seen.add(k); out.append(it)
    return out[:20]


def _sheet(shots, times, out):
    w0, h0 = shots[0].size
    tw = 640 if w0 >= h0 else 360
    th = round(tw * h0 / w0)
    cols = 3
    rows = (len(shots) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * 8, rows * (th + 36) + 8), (40, 40, 40))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(FONT, 22)
    except OSError:
        font = ImageFont.load_default()
    for i, (im, t) in enumerate(zip(shots, times)):
        x, y = 8 + (i % cols) * (tw + 8), 8 + (i // cols) * (th + 36)
        sheet.paste(im.resize((tw, th)), (x, y + 28))
        d.text((x, y + 2), f"t = {t}s", fill=(255, 255, 255), font=font)
    sheet.save(out)


def main():
    ap = argparse.ArgumentParser(prog="slate-qa", description="一镜的确定性自检（文字溢出、重叠、空白、时长）")
    ap.add_argument("scenes", nargs="+")
    a = ap.parse_args()
    ok = True
    from . import remote
    res = remote.call("qa", a.scenes) if remote.enabled() else None  # 交给渲染机；调不通时在本机检查
    if res is not None:
        got = {x["scene"]: x for x in res.get("scenes", [])}
        missing = [sid for sid in a.scenes if sid not in got or got[sid].get("error")]
        for sid in a.scenes:
            if sid in missing:
                continue
            r = got[sid]["result"]
            os.makedirs(path("qa"), exist_ok=True)
            remote.download(got[sid]["sheet"], path("qa", f"{sid}.png"))
            json.dump(r, open(path("qa", f"{sid}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            ok &= r["ok"]
            print(json.dumps({k: r[k] for k in ("scene", "ok", "issues", "contact_sheet")}, ensure_ascii=False), flush=True)
        a.scenes = missing
    for sid in a.scenes:
        r = asyncio.run(check(sid))
        ok &= r["ok"]
        print(json.dumps({k: r[k] for k in ("scene", "ok", "issues", "contact_sheet")}, ensure_ascii=False), flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
