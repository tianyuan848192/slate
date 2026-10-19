"""slate-image：用户给的普通图片（docs/image-refs-design.md）。

slate-image index                                   开工前由系统运行：整理 input/images/ 下的图片，写目录 input/images/index.json
slate-image info <编号>                              一张图的宽高、透明通道、背景、主体外框和主要颜色
slate-image crop <编号或文件> --box x,y,w,h --out <文件>   裁切（坐标按整理后的图，像素）
slate-image fit <编号或文件> --max 1600 --out <文件>       等比缩小到长边不超过这么多像素（不放大）
slate-image key <编号或文件> --out <文件> [--color #ffffff] [--tol 18] [--trim] [--shadow]
                                                    去掉纯色背景（连同落地阴影），边缘羽化并去掉白边，输出透明 PNG；
                                                    --trim 再裁到主体外框；--shadow 把阴影留成半透明的黑色

处理后的文件放进 scenes/_shared/ 或 scenes/NN/，文件名以图片编号开头（比如 i01-cut.png）：slate-qa 靠它认出用户的图片。
原图（input/images/orig/）和整理后的图（input/images/iNN.*）都不要改。
"""
import argparse, io, json, os, re, sys

import numpy as np
from PIL import Image, ImageOps

from .common import die, load_json, path, upload

MAX_SIDE = 2560      # 整理后长边不超过这么多像素
ANALYZE_SIDE = 512   # 判断背景、找主体时先缩到这么大
SOLID_TOL = 18       # 和背景色的距离（RGB 欧氏距离）小于它，算背景
KEY_SIDE = 1024      # 去背景时找背景区域的精度（越大边缘越准、越慢）
ID_RE = re.compile(r"^i\d{2}$")


def _has_alpha(im):
    return im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)


def _srgb(im):
    """带 ICC 配置文件的图转成 sRGB；转不了就原样用"""
    icc = im.info.get("icc_profile")
    if not icc:
        return im
    try:
        from PIL import ImageCms
        mode = "RGBA" if im.mode == "RGBA" else "RGB"
        return ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile("sRGB"), outputMode=mode)
    except Exception:
        return im


def normalize(src, out_base):
    """按 EXIF 转正、转 sRGB、长边超过 MAX_SIDE 就缩小，去掉 EXIF。有透明通道或原图是 PNG 的存 PNG，其他存 JPEG。
    同一张原图每次的输出都一样（片段按内容指纹复用，图片字节变了就会整镜重渲）"""
    im = Image.open(src)
    im.seek(0)  # 动图只取第一帧
    im = ImageOps.exif_transpose(im)
    alpha = _has_alpha(im)
    im = im.convert("RGBA" if alpha else "RGB")
    im = _srgb(im)
    if alpha and im.getchannel("A").getextrema()[0] >= 250:  # 透明通道是满的，等于没有
        im, alpha = im.convert("RGB"), False
    if max(im.size) > MAX_SIDE:
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    png = alpha or src.lower().endswith(".png")
    out = out_base + (".png" if png else ".jpg")
    if png:
        im.save(out, "PNG")
    else:
        im.save(out, "JPEG", quality=92)
    return out


def analyze(p):
    """背景（透明、纯色、复杂）、主体外框（整理后图片的像素坐标）和主要颜色"""
    im = Image.open(p)
    w, h = im.size
    small = im.copy()
    small.thumbnail((ANALYZE_SIDE, ANALYZE_SIDE), Image.BILINEAR)
    sx, sy = w / small.size[0], h / small.size[1]
    rgba = np.asarray(small.convert("RGBA")).astype(np.float32)
    rgb, a = rgba[..., :3], rgba[..., 3]
    ring = _ring(a.shape)
    bg, subject = {"kind": "complex"}, None
    if im.mode == "RGBA" and a[ring].mean() < 25:
        bg = {"kind": "transparent"}
        subject = a > 128
    else:
        med = np.median(rgb[ring], axis=0)
        near = np.sqrt(((rgb[ring] - med) ** 2).sum(-1)) < SOLID_TOL
        if near.mean() >= 0.9:
            bg = {"kind": "solid", "color": _hex(med)}
            subject = np.sqrt(((rgb - med) ** 2).sum(-1)) > SOLID_TOL * 1.6
    box = None
    if subject is not None and subject.any():
        ys, xs = np.where(subject)
        x0, y0, x1, y1 = int(xs.min() * sx), int(ys.min() * sy), int(min(w, (xs.max() + 1) * sx)), int(min(h, (ys.max() + 1) * sy))
        box = {"box": [x0, y0, x1 - x0, y1 - y0], "share": round((x1 - x0) * (y1 - y0) / (w * h), 3)}
    pix = small.convert("RGB")
    if subject is not None and subject.any():  # 只数主体的颜色
        keep = np.asarray(pix)[subject]
        pix = Image.fromarray(keep.reshape(1, -1, 3).astype(np.uint8))
    q = pix.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[:24]
    colors, seen = [], []
    for _, i in sorted(q.getcolors() or [], reverse=True):  # 按面积从大到小，很接近的颜色（压缩噪点）只留一个
        c = np.array(pal[i * 3:i * 3 + 3], np.float32)
        if i < 8 and all(np.sqrt(((c - x) ** 2).sum()) > 40 for x in seen):
            seen.append(c); colors.append(_hex(c))
    colors = colors[:5]
    return {"width": w, "height": h, "alpha": im.mode == "RGBA", "background": bg, "subject": box, "colors": colors}


def _ring(shape):
    h, w = shape
    k = max(2, round(min(h, w) * 0.02))
    m = np.zeros(shape, bool)
    m[:k], m[-k:], m[:, :k], m[:, -k:] = True, True, True, True
    return m


def _hex(c):
    return "#" + "".join(f"{int(round(float(x))):02x}" for x in list(c)[:3])


def index():
    """开工前（每一轮）：按清单整理图片，写目录。整理后的图传回数据桶，会话被回收后不用重做，字节也不变"""
    man = load_json(path("input", "images", "manifest.json"))
    if not man:
        return {"count": 0, "items": []}
    items = []
    for it in man.get("items", []):
        iid = it["id"]
        rec = {"id": iid, "name": it.get("name"), "desc": it.get("desc")}
        try:
            got = [f for f in (f"{iid}.png", f"{iid}.jpg") if os.path.isfile(path("input", "images", f))]
            if got:
                p = path("input", "images", got[0])
            else:
                p = normalize(path(it["orig"]), path("input", "images", iid))
                upload(p, "input", "images", os.path.basename(p), content_type="image/png" if p.endswith(".png") else "image/jpeg")
            rel = os.path.relpath(p, path())
            rec.update(file=rel, url="/" + rel, **analyze(p))
            th = path("input", "images", "thumbs", f"{iid}.jpg")
            if not os.path.isfile(th):  # 给生成页看的缩略图
                os.makedirs(os.path.dirname(th), exist_ok=True)
                t = Image.open(p).convert("RGBA")
                t.thumbnail((480, 480), Image.LANCZOS)
                bg = Image.new("RGBA", t.size, (255, 255, 255, 255)); bg.alpha_composite(t)
                bg.convert("RGB").save(th, "JPEG", quality=85)
                upload(th, "input", "images", "thumbs", f"{iid}.jpg", content_type="image/jpeg")
            rec["thumb"] = os.path.relpath(th, path())
        except Exception as e:
            rec["error"] = f"图片打不开：{str(e)[:160]}"
        items.append(rec)
    out = {"count": len(items), "items": items,
           "note": "desc 是用户写的描述：这是什么、想在片子里怎么用。坐标和宽高都按整理后的图（file），原图在 orig/，两者都不要改"}
    json.dump(out, open(path("input", "images", "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return out


def _entry(iid):
    idx = load_json(path("input", "images", "index.json")) or {}
    for x in idx.get("items", []):
        if x["id"] == iid:
            if x.get("error"):
                die(f"{iid} {x['error']}")
            return x
    die(f"没有图片 {iid}，看 input/images/index.json 里的编号")


def _open(src):
    """编号（i01）→ 整理后的图；否则当作文件路径（处理过一次的图可以接着处理）"""
    if ID_RE.match(src):
        return Image.open(path(_entry(src)["file"])), src
    p = src if os.path.isabs(src) else path(src)
    if not os.path.isfile(p):
        die(f"找不到 {src}")
    m = re.match(r"i\d{2}", os.path.basename(p))
    return Image.open(p), (m.group(0) if m else None)


def _save(im, out, iid):
    base = os.path.basename(out)
    if iid and not base.startswith(iid):
        die(f"输出的文件名要以图片编号开头，比如 {iid}-cut.png：slate-qa 靠文件名认出用户的图片")
    if not re.search(r"\.(png|jpe?g|webp)$", base, re.I):
        die("输出文件要用 .png、.jpg 或 .webp 结尾")
    p = out if os.path.isabs(out) else path(out)
    if os.path.abspath(p).startswith(os.path.abspath(path("input")) + os.sep):
        die("不要写进 input/：处理后的图放进 scenes/_shared/ 或 scenes/NN/")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if base.lower().endswith((".jpg", ".jpeg")):
        im.convert("RGB").save(p, "JPEG", quality=92)
    else:
        im.save(p)
    return {"file": os.path.relpath(p, path()), "width": im.size[0], "height": im.size[1], "alpha": im.mode == "RGBA"}


def crop(src, box, out):
    im, iid = _open(src)
    try:
        x, y, w, h = [int(round(float(v))) for v in box.split(",")]
    except ValueError:
        die("--box 写成 x,y,w,h（像素）")
    W, H = im.size
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > W or y + h > H:
        die(f"裁切框超出了图片范围（图片是 {W}×{H}）")
    return _save(im.crop((x, y, x + w, y + h)), out, iid)


def fit(src, max_side, out):
    im, iid = _open(src)
    im = im.copy()
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.LANCZOS)
    return _save(im, out, iid)


def key(src, out, color=None, tol=SOLID_TOL, trim=False, shadow=False):
    """去掉纯色背景：只去掉和画面边缘连在一起的背景区域（主体里和背景同色的地方保留）。
    - 白底产品图常带一块落地阴影：和背景连着、比背景暗、颜色和背景一样偏中性、变化平缓的区域算阴影，默认一起去掉；
      shadow=True 时保留成半透明的黑色阴影（浅色画面上更自然）；
    - 主体边缘按颜色距离羽化，半透明的边缘去掉残留的背景色（不然放到深色画面上会有一圈白边）"""
    im, iid = _open(src)
    rgb = np.asarray(im.convert("RGB")).astype(np.float32)
    H, W = rgb.shape[:2]
    if color:
        if not re.fullmatch(r"#?[0-9a-fA-F]{6}", color):
            die("--color 写成 #rrggbb")
        bg = np.array([int(color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], np.float32)
    else:
        ring = _ring((H, W))
        bg = np.median(rgb[ring], axis=0)
        if (np.sqrt(((rgb[ring] - bg) ** 2).sum(-1)) < tol).mean() < 0.9:
            die("这张图的背景不是纯色，去不掉：整张用，做成卡片、相框或遮罩显现；确实是纯色时用 --color 指定背景色")
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    near = dist < tol * 1.6
    lum, lb = rgb.mean(-1), float(bg.mean())
    chroma, cb = rgb.max(-1) - rgb.min(-1), float(bg.max() - bg.min())
    shade = (lum < lb - 3) & (lum > lb * 0.6) & (np.abs(chroma - cb) < 16)  # 像阴影：比背景暗一些（落地阴影都比较浅），颜色一样偏中性
    # 和边缘连通的背景（加阴影）区域：在小图上从边缘往里长（快），遇到明显的边就停，再放大回原尺寸
    s_ = min(1.0, KEY_SIDE / max(W, H))
    sw, sh = max(1, round(W * s_)), max(1, round(H * s_))
    small = lambda m: np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((sw, sh), Image.NEAREST)) > 0  # noqa: E731
    sl = np.asarray(Image.fromarray(lum.astype(np.uint8)).resize((sw, sh), Image.BILINEAR)).astype(np.float32)
    grad = np.zeros_like(sl)
    grad[:, 1:] = np.maximum(grad[:, 1:], np.abs(np.diff(sl, axis=1)))
    grad[1:] = np.maximum(grad[1:], np.abs(np.diff(sl, axis=0)))
    passable = small(near) | (small(shade) & (grad < 12))
    region = passable & _ring((sh, sw))
    while True:
        grown = region.copy()
        grown[1:] |= region[:-1]; grown[:-1] |= region[1:]; grown[:, 1:] |= region[:, :-1]; grown[:, :-1] |= region[:, 1:]
        grown &= passable
        if (grown == region).all():
            break
        region = grown
    from PIL import ImageFilter
    reg = Image.fromarray(region.astype(np.uint8) * 255).resize((W, H), Image.BILINEAR).point(lambda v: 255 if v > 64 else 0)
    R = np.asarray(reg) > 0
    inner = np.asarray(reg.filter(ImageFilter.MinFilter(7))) > 0   # 背景区域里离主体三个像素以上的地方：全透明
    outer = np.asarray(reg.filter(ImageFilter.MaxFilter(5))) > 0   # 往主体里放宽两个像素：清掉边上的浅色噪点
    zone = (R & ~inner) | (outer & ~R)                              # 主体边缘的一圈：按颜色距离羽化
    soft = np.clip((dist - tol) / max(1.0, tol), 0, 1)  # 离背景色越远越不透明
    old = np.asarray(im.convert("RGBA"))[..., 3].astype(np.float32) / 255
    alpha = np.ones((H, W), np.float32)
    alpha[inner] = 0.0
    z = zone & near
    alpha[z] = soft[z]
    alpha[R & ~inner & ~near & shade] = 0.0  # 贴着主体的深一点的阴影
    shadow_px = R & shade
    if shadow:  # 阴影留成半透明的黑色：越暗越不透明，最多 60%
        alpha[shadow_px] = np.clip((lb - lum) / max(1.0, lb) * 1.6, 0, 0.6)[shadow_px]
    alpha *= old
    # 半透明的边缘：把混进来的背景色减掉（C = (P - (1 - a)·B) / a）；阴影像素用纯黑
    a3 = alpha[..., None]
    clean = np.where(a3 > 0.02, (rgb - (1 - a3) * bg) / np.maximum(a3, 0.02), rgb)
    edge = (alpha > 0) & (alpha < 0.98)
    rgb = np.where(edge[..., None], np.clip(clean, 0, 255), rgb)
    if shadow:
        rgb[shadow_px] = 0
    rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    res = Image.fromarray(rgba, "RGBA")
    box = res.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        die("去完背景什么都不剩了：调小 --tol，或者用 --color 指定背景色")
    if trim:
        pad = round(max(W, H) * 0.01)
        res = res.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(W, box[2] + pad), min(H, box[3] + pad)))
    info = _save(res, out if out.lower().endswith(".png") else re.sub(r"\.\w+$", ".png", out), iid)
    info["removed"] = round(float((alpha < 0.1).mean()), 3)
    has = (shadow_px & (lum < lb - 8)).sum() > 0.002 * W * H  # 比背景明显暗的才算真有阴影（压缩噪点不算）
    info["shadow"] = ("kept" if shadow else "removed") if has else "none"
    return info


def main():
    ap = argparse.ArgumentParser(prog="slate-image", description="用户给的普通图片：整理、查看、裁切、缩小、去纯色背景")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("index")
    p = sub.add_parser("info"); p.add_argument("id")
    p = sub.add_parser("crop"); p.add_argument("src"); p.add_argument("--box", required=True); p.add_argument("--out", required=True)
    p = sub.add_parser("fit"); p.add_argument("src"); p.add_argument("--max", type=int, required=True); p.add_argument("--out", required=True)
    p = sub.add_parser("key"); p.add_argument("src"); p.add_argument("--out", required=True); p.add_argument("--color")
    p.add_argument("--tol", type=float, default=SOLID_TOL); p.add_argument("--trim", action="store_true")
    p.add_argument("--shadow", action="store_true", help="保留落地阴影（变成半透明的黑色）；默认去掉")
    a = ap.parse_args()
    if a.cmd == "index":
        r = index()
        res = {"count": r["count"], "errors": [x["id"] for x in r["items"] if x.get("error")],
               "thumbs": {x["id"]: x["thumb"] for x in r["items"] if x.get("thumb")}}
    elif a.cmd == "info":
        res = _entry(a.id)
    elif a.cmd == "crop":
        res = crop(a.src, a.box, a.out)
    elif a.cmd == "fit":
        if a.max < 16:
            die("--max 太小了")
        res = fit(a.src, a.max, a.out)
    else:
        res = key(a.src, a.out, a.color, a.tol, a.trim, a.shadow)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
