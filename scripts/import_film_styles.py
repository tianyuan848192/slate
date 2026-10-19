"""把开源影片风格库（MIT 许可，来源和版本见 THIRD_PARTY_NOTICES.md）导入成 Slate 的 Skill。

产出：
- agent/skills/film-<slug>/：每个风格一个 Skill（SKILL.md + 风格原文 + 示范片说明和源码）；
- agent/skills/film-kit/：在 Slate 里用这类风格的总说明，以及导演、技法两份参考；
- agent/image/film-core/：页面里的 /core/（公共函数库、后期、字体、CC0 贴图）；
- agent/image/vendor/three/：页面里的 /node_modules/three/（three.js 0.170.0，MIT）；
- agent/licenses/film-styles/LICENSE、agent/licenses/three/LICENSE：许可证原文；
- web/thumbs/film-<slug>.jpg：前端风格库的缩略图。

来源仓库的名字只留在许可证原文和 THIRD_PARTY_NOTICES.md 里，Skill 和页面里一律替换掉，导入完会全量检查。

用法：python scripts/import_film_styles.py <风格库目录> <three 包目录> <hdri.tar> [目录条目.json]
"""
import glob, hashlib, json, os, re, shutil, subprocess, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, "agent", "skills")
CORE = os.path.join(ROOT, "agent", "image", "film-core")
THREE = os.path.join(ROOT, "agent", "image", "vendor", "three")
LIC = os.path.join(ROOT, "agent", "licenses")
THUMBS = os.path.join(ROOT, "web", "thumbs")

# 示范片源码里出现这些写法，就算用到 WebGL（three.js 或自己写的着色器）。按代码判断，不按风格说明里的自述
GL_CODE = re.compile(r"getContext\(\s*['\"]webgl2?['\"]|from\s+['\"]three['\"]|\bTHREE\.|WebGLRenderer")
GL = set()
# 分组改名：来源的"信息与发布"在 Slate 里叫"信息与图解"（和机械图解放在一组）
CAT_RENAME = {"信息与发布": "信息与图解"}
TEXT = (".js", ".mjs", ".html", ".css", ".json", ".md", ".txt", ".glsl", ".frag", ".vert", ".svg", ".gltf", ".csv")
KEEP = TEXT + (".png", ".jpg", ".jpeg", ".webp", ".bin", ".woff2", ".woff", ".ttf", ".otf")
# 示范片目录里只给 Agent 参考画面代码：声音、工具脚本、渲染产物和大图都不要
DROP_DIRS = {"music", "voices", "voices_raw", "voices_fx", "vo", "tts", "audio", "tools", "stills", "chk", "node_modules"}
DROP_FILES = {"build.sh", "mix.py", "CREDITS"}
BRAND = re.compile(r"(?<!guil)lemo(?!n)|opuscar|lemomo", re.I)  # guillemot 是字体里的引号字形名

# 名字替换：代码和文档分开处理。代码里的是画面上的字（片尾署名、片名卡），文档里的是说明文字
SRC_URL = r"https?://(?:github\.com/lemomo-ai|lemomo-ai\.github\.io)[^\s)\"'>`]*"
COMMON = [
    (r"(?i)lemolab\s*(?:×|\\u00d7|x)\s*claude\s+opus\s+5\.5", ""),        # 片尾署名整条去掉
    (r"\[([^\]]*)\]\(\s*" + SRC_URL + r"\s*\)", r"\1"),                       # 指向来源仓库的链接：只留链接文字
    (r"\(\s*" + SRC_URL + r"\s*\)", ""),                                        # 括号里的来源地址：连括号一起去掉
    (SRC_URL, ""),
    (r"(?i)lemomo[-_]ai|@?lemomo_ai|\blemomo\b", ""),
]
CODE = COMMON + [
    (r"\s*[·•]\s*LEMO-OPUSCAR", ""), (r"\s*[·•]\s*Lemo-Opuscar", ""),
    (r"(?i)\ba\s+lemo-opuscar\s+(film|demo|style)\b", r"a \1"),
    (r"(?i)opuscar\s*98", "an earlier"),
    (r"LEMO-OPUSCAR|LEMOLAB", "STUDIO"), (r"(?i)lemo-opuscar|lemolab", "Studio"),
    (r"\bLEMO\b", "STUDIO"), (r"\bLemo del\.", "Studio del."), (r"\bOpus sculp\.", "Atelier sculp."),
]
DOC = COMMON + [
    # 交付前的署名检查：改成"片子里不能有任何署名和水印"
    (r"- No LemoLab sign-off: `grep[^\n]*", "- No sign-off or watermark anywhere in the film: you have watched the last seconds of the film "
                                           "(text drawn into an image can't be grepped)."),
    (r"(?i)opuscar\s*98", "an earlier 98-film set"),
    (r"(?i)plugin/skills/lemo-opuscar/scripts/setup\.sh", "setup.sh"),
    (r"(?i)no lemolab credit", "no credit"),
    (r"(?i)the lemo-opuscar library", "the film style library"), (r"(?i)lemo-opuscar library", "film style library"),
    (r"(?i)lemo-opuscar", "the film style library"), (r"(?i)lemolab", "the library"),
    (r"\bLEMO\b", "the library"), (r"\bLemo del\.", "Studio del."),
]


def scrub(text, rules):
    for pat, rep in rules:
        text = re.sub(pat, rep, text)
    return text


def copy_text(src, dst, rules):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    s = open(src, encoding="utf-8", errors="ignore").read()
    open(dst, "w", encoding="utf-8").write(scrub(s, rules))


def copy_tree(src, dst, drop_dirs=(), drop_files=(), max_bytes=None):
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in drop_dirs and not d.startswith("out")]
        for f in files:
            p = os.path.join(root, f)
            if f in drop_files or not f.lower().endswith(KEEP) or f.endswith((".srt",)):
                continue
            if max_bytes and os.path.getsize(p) > max_bytes and not f.endswith(TEXT):
                continue
            q = os.path.join(dst, os.path.relpath(p, src))
            if f.lower().endswith(TEXT):
                copy_text(p, q, DOC if f.endswith(".md") else CODE)
            else:
                os.makedirs(os.path.dirname(q), exist_ok=True)
                shutil.copy2(p, q)


def sections(md, keep):
    """按二级标题切分，只保留编号在 keep 里的章节（标题前的导语保留）"""
    parts = re.split(r"(?m)^(?=## )", md)
    out = [parts[0]]
    for p in parts[1:]:
        m = re.match(r"## (\d+)\.", p)
        if m and int(m.group(1)) in keep:
            out.append(p)
    return "".join(out)


def canary(slug):
    return "slate-skill-" + hashlib.sha1(f"film:{slug}".encode()).hexdigest()[:10]


def uses_webgl(demo_dir):
    for root, _, files in os.walk(demo_dir):
        for f in files:
            if f.endswith((".js", ".mjs", ".html")) and GL_CODE.search(open(os.path.join(root, f), encoding="utf-8", errors="ignore").read()):
                return True
    return False


def skill_md(slug, meta, entry, style_md):
    cn, en = meta.get("cn", slug), meta.get("en", slug)
    summary = (entry or {}).get("summary") or meta.get("line_cn", "")
    gl = "是。三维或着色器画面，每帧渲染约 0.5～1 秒，注意控制复杂度" if slug in GL else "否，只用 Canvas 2D / SVG"
    return f"""---
name: film-{slug}
description: 影片风格「{cn}」（{en}）。{summary} 用法先读 film-kit。
---

# {cn}（{en}）

这是一个影片风格。动手前先读 `/.agents/skills/film-kit/SKILL.md`，它说明在 Slate 里怎么用这类风格；然后完整读下面的风格说明（英文原文）。

- **风格说明里的规则都要遵守**：画面、色彩、字体、动作、镜头语法、招牌手法、常见坑。讲声音的部分（配乐、音效、混音）跳过，声音由平台处理。
- **示范片**：本目录的 `DEMO.md` 和 `demo/` 是一支示范短片的说明和源码，只用来学技法（笔触引擎、角色绑定、着色器、转场写法）。不要照搬它的故事、角色、镜头、片名和片尾字卡。
- **WebGL**：{gl}。

---

{style_md.strip()}

<!-- 版本标识：{canary(slug)} -->
"""


def build_core(src, hdri):
    if os.path.isdir(CORE):
        shutil.rmtree(CORE)
    for rel in ("lib.js", "three/post.js", "post/crt.js"):
        copy_text(os.path.join(src, "core", rel), os.path.join(CORE, rel), CODE)
    copy_tree(os.path.join(src, "core", "fonts"), os.path.join(CORE, "fonts"))
    copy_tree(os.path.join(src, "core", "assets"), os.path.join(CORE, "assets"))
    with tarfile.open(hdri) as tf:  # Poly Haven 的 HDR 环境贴图（CC0），3D 风格的反射和布光用
        for m in tf.getmembers():
            if m.isfile() and m.name.endswith(".hdr"):
                data = tf.extractfile(m).read()
                open(os.path.join(CORE, "assets", "polyhaven", os.path.basename(m.name)), "wb").write(data)


def build_three(pkg):
    if os.path.isdir(THREE):
        shutil.rmtree(THREE)
    os.makedirs(os.path.join(THREE, "build"))
    for f in ("three.module.js", "three.module.min.js"):
        shutil.copy2(os.path.join(pkg, "build", f), os.path.join(THREE, "build", f))
    heavy = {"draco", "basis", "rhino3dm", "ammo.wasm.js", "ammo.wasm.wasm", "lottie_canvas.module.js", "mmdparser.module.js"}
    src = os.path.join(pkg, "examples", "jsm")
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        dirs[:] = [d for d in dirs if not (rel == "libs" and d in heavy)]
        for f in files:
            if rel == "libs" and f in heavy:
                continue
            q = os.path.join(THREE, "examples", "jsm", rel, f)
            os.makedirs(os.path.dirname(q), exist_ok=True)
            shutil.copy2(os.path.join(root, f), q)
    shutil.copy2(os.path.join(pkg, "LICENSE"), os.path.join(THREE, "LICENSE"))
    os.makedirs(os.path.join(LIC, "three"), exist_ok=True)
    shutil.copy2(os.path.join(pkg, "LICENSE"), os.path.join(LIC, "three", "LICENSE"))


def thumb(src_img, slug):
    os.makedirs(THUMBS, exist_ok=True)
    vf = "scale=320:180:force_original_aspect_ratio=increase,crop=320:180"
    if slug == "living-screencast":  # 这一帧右侧有第三方吉祥物：只取左侧的界面
        vf = "crop=iw*0.62:ih*0.62:0:ih*0.30," + vf
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src_img, "-vf", vf, "-q:v", "4",
                    os.path.join(THUMBS, f"film-{slug}.jpg")], check=True)


def main():
    src, pkg, hdri = sys.argv[1:4]
    catalog = {e["id"]: e for e in json.load(open(sys.argv[4], encoding="utf-8"))} if len(sys.argv) > 4 else {}
    slugs = sorted(d for d in os.listdir(os.path.join(src, "styles"))
                   if not d.startswith("_") and os.path.isfile(os.path.join(src, "styles", d, "STYLE.md")))
    for d in glob.glob(os.path.join(SKILLS, "film-*")):
        if not d.endswith("film-kit"):  # film-kit 的 SKILL.md 是手写的，只更新它下面的参考文件
            shutil.rmtree(d)
    rows = []
    for slug in slugs:
        sd, out = os.path.join(src, "styles", slug), os.path.join(SKILLS, f"film-{slug}")
        if uses_webgl(os.path.join(sd, "demo")):
            GL.add(slug)
        meta = json.loads(scrub(open(os.path.join(sd, "style.json"), encoding="utf-8").read(), DOC))
        style_md = scrub(open(os.path.join(sd, "STYLE.md"), encoding="utf-8").read(), DOC)
        os.makedirs(out)
        open(os.path.join(out, "SKILL.md"), "w", encoding="utf-8").write(skill_md(slug, meta, catalog.get(f"film-{slug}"), style_md))
        copy_text(os.path.join(sd, "DEMO.md"), os.path.join(out, "DEMO.md"), DOC)
        json.dump(meta, open(os.path.join(out, "style.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        copy_tree(os.path.join(sd, "demo"), os.path.join(out, "demo"), DROP_DIRS, DROP_FILES, max_bytes=600_000)
        thumb(os.path.join(sd, "demo", "stills", "styleframe.jpg"), slug)
        rows.append((CAT_RENAME.get(meta.get("category_cn", ""), meta.get("category_cn", "")), meta.get("cn", slug), meta.get("en", slug), slug))
    # film-kit：导演和技法两份参考（去掉安装、配音、配乐、音效、字幕这些平台另有安排的章节）
    kit = os.path.join(SKILLS, "film-kit")
    os.makedirs(kit, exist_ok=True)
    d = scrub(open(os.path.join(src, "DIRECTOR.md"), encoding="utf-8").read(), DOC)
    open(os.path.join(kit, "DIRECTOR.md"), "w", encoding="utf-8").write(sections(d, {1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12}))
    t = scrub(open(os.path.join(src, "TECHNIQUE.md"), encoding="utf-8").read(), DOC)
    open(os.path.join(kit, "TECHNIQUE.md"), "w", encoding="utf-8").write(sections(t, {2, 3, 8, 9, 10, 11, 12}))
    lines = ["# 全部影片风格", "", "| 分类 | 风格 | 英文名 | Skill | WebGL |", "|---|---|---|---|---|"]
    lines += [f"| {c} | {cn} | {en} | `film-{s}` | {'是' if s in GL else ''} |" for c, cn, en, s in sorted(rows)]
    open(os.path.join(kit, "STYLES.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    build_core(src, hdri)
    build_three(pkg)
    os.makedirs(os.path.join(LIC, "film-styles"), exist_ok=True)
    shutil.copy2(os.path.join(src, "LICENSE"), os.path.join(LIC, "film-styles", "LICENSE"))
    # 全量检查：来源名字只能出现在许可证目录里
    bad = []
    for base in [*glob.glob(os.path.join(SKILLS, "film-*")), CORE]:
        for root, _, files in os.walk(base):
            for f in files:
                p = os.path.join(root, f)
                if f.lower().endswith(TEXT):
                    for m in BRAND.finditer(open(p, encoding="utf-8", errors="ignore").read()):
                        bad.append(f"{os.path.relpath(p, ROOT)}: …{m.group(0)}…")
    if bad:
        print("还有没替换掉的名字：", *bad[:30], sep="\n  ")
        sys.exit(1)
    print(f"导入 {len(slugs)} 个风格；film-core、three.js、缩略图已更新")


if __name__ == "__main__":
    main()
