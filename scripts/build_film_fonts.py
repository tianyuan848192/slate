"""下载影片风格用到的开源字体（Google Fonts，均为 OFL / Apache 许可），放进镜像的 /assets/fonts/lib/。

每个字体家族生成一个 CSS：/assets/fonts/lib/<slug>.css，字体文件是按字符范围切好的 woff2，浏览器只加载用到的那几片。
- 拉丁字体只保留 latin、latin-ext 两个子集；
- 中文、日文字体保留全部切片。
用法：python scripts/build_film_fonts.py   （需要联网；结果直接写进仓库，部署时打进镜像）
"""
import json, os, re, shutil, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "agent", "image", "assets", "fonts", "lib")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

LATIN = [
    "Alfa Slab One", "Allura", "Architects Daughter", "Archivo", "B612", "B612 Mono", "Bagel Fat One", "Baloo 2",
    "Barlow Semi Condensed", "Big Shoulders", "Bodoni Moda", "Bricolage Grotesque", "Bungee", "Caveat",
    "Caveat Brush", "Cinzel", "Cormorant", "Cormorant Garamond", "Cormorant SC", "DM Mono", "DM Serif Display",
    "Fraunces", "Fredoka", "Gaegu", "Gochi Hand", "IBM Plex Mono", "IBM Plex Sans", "IBM Plex Sans Condensed",
    "IM Fell English", "IM Fell English SC", "Instrument Sans", "Inter", "Inter Tight", "Italiana", "JetBrains Mono",
    "Josefin Sans", "Jost", "Kanit", "League Gothic", "League Spartan", "Lilita One", "Limelight", "Newsreader",
    "Old Standard TT", "Oleo Script", "Outfit", "Overpass", "Overpass Mono", "Patrick Hand", "Pinyon Script",
    "Playfair Display", "Playfair Display SC", "Poiret One", "Quicksand", "Rajdhani", "Reenie Beanie", "Sacramento",
    "Schibsted Grotesk", "Share Tech Mono", "Short Stack", "Shrikhand", "Silkscreen", "Sniglet", "Titan One",
    "Uncial Antiqua", "UnifrakturMaguntia", "VT323",
]
CJK = ["Dela Gothic One", "Long Cang", "Ma Shan Zheng", "Noto Sans JP", "Noto Serif SC", "Shippori Mincho",
       "Yuji Syuku", "ZCOOL KuaiLe", "Zhi Mang Xing"]
KEEP_LATIN = {"latin", "latin-ext"}
# 只取用得到的字重：日文明朝体每个字重都有六百多片，全取太大
WEIGHTS = {"Shippori Mincho": [500, 700]}


def get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def query(meta):
    """按家族的字重轴和斜体情况拼 css2 查询串"""
    variants = list(meta.get("fonts", {}).keys())
    if meta["family"] in WEIGHTS:
        name = urllib.parse.quote_plus(meta["family"])
        return f"{name}:wght@" + ";".join(str(w) for w in WEIGHTS[meta["family"]])
    italic = any(v.endswith("i") for v in variants)
    wght = next((a for a in meta.get("axes", []) if a["tag"] == "wght"), None)
    name = urllib.parse.quote_plus(meta["family"])
    if wght:
        rng = f"{int(wght['min'])}..{int(wght['max'])}"
        return f"{name}:ital,wght@0,{rng};1,{rng}" if italic else f"{name}:wght@{rng}"
    ws = sorted({(1 if v.endswith("i") else 0, int(v.rstrip("i"))) for v in variants})
    if ws == [(0, 400)]:
        return name
    return f"{name}:ital,wght@" + ";".join(f"{i},{w}" for i, w in ws)


def main():
    raw = get("https://fonts.google.com/metadata/fonts")
    meta = {f["family"]: f for f in json.loads(raw[raw.index("{"):])["familyMetadataList"]}
    missing = [f for f in LATIN + CJK if f not in meta]
    if missing:
        sys.exit(f"Google Fonts 里找不到：{missing}")
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    index, total = [], 0
    for fam in LATIN + CJK:
        css = get(f"https://fonts.googleapis.com/css2?family={query(meta[fam])}&display=block")
        s, d = slug(fam), os.path.join(OUT, slug(fam))
        os.makedirs(d)
        # 拉丁字体每段前有 /* latin */ 这样的子集注释；中文、日文的切片没有注释
        blocks = re.findall(r"(?:/\*\s*([^*]+?)\s*\*/\s*)?(@font-face\s*\{[^}]*\})", css)
        out, n = [], 0
        for subset, block in blocks:
            if fam in LATIN and subset not in KEEP_LATIN:
                continue
            url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
            data = get(url, binary=True)
            n += 1
            fn = f"{n}.woff2"
            open(os.path.join(d, fn), "wb").write(data)
            total += len(data)
            out.append(block.replace(url, f"/assets/fonts/lib/{s}/{fn}"))
        open(os.path.join(OUT, f"{s}.css"), "w", encoding="utf-8").write("\n".join(out) + "\n")
        size = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
        index.append((fam, s, meta[fam].get("category", ""), n, size))
        print(f"{fam:28s} {n:4d} 个文件 {size / 1024:8.0f} KB", flush=True)
    lines = ["# 可用字体（Google Fonts，开源许可）", "",
             "在场景页里引用对应的 CSS，例如 `<link rel=\"stylesheet\" href=\"/assets/fonts/lib/archivo.css\">`，",
             "然后在 CSS 或画布里用字体家族名。字体按字符范围切片，只会加载用到的那几片。", "",
             "| 字体家族 | CSS | 类型 |", "|---|---|---|"]
    lines += [f"| {fam} | `/assets/fonts/lib/{s}.css` | {cat} |" for fam, s, cat, _, _ in index]
    open(os.path.join(OUT, "FONTS.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    # 许可证：这些家族都在 google/fonts 的 ofl/ 目录下，各自的版权声明写在字体文件的 name 表里
    ofl = open(os.path.join(ROOT, "agent", "image", "assets", "fonts", "NotoSerifSC-OFL.txt"), encoding="utf-8").read()
    ofl = ofl[ofl.index("This Font Software"):]
    open(os.path.join(OUT, "LICENSE.md"), "w", encoding="utf-8").write(
        "# 字体许可\n\n本目录的字体来自 Google Fonts（https://fonts.google.com），均以 SIL Open Font License 1.1 发布，"
        "未修改字形，只按 Google Fonts 提供的字符范围切片。每个字体的版权声明保存在字体文件的 name 表中。\n\n"
        "家族：" + "、".join(f for f, *_ in index) + "\n\n---\n\n" + ofl)
    print(f"合计 {len(index)} 个家族，{total / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
