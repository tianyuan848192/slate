"""把开源动效素材库（Apache-2.0，来源和版本见 THIRD_PARTY_NOTICES.md）导入成 Slate 的素材库 Skill。

产出：
- agent/skills/kit-shots/<id>/：镜头模板。shot.js 注册 KIT.shots[id]，index.html 是示范页（也是自动检查用的场景）；
- agent/skills/kit-motion/<id>.js、demos/<id>.html：动作，注册 KIT.motions[函数名]；
- 两个 Skill 的 SKILL.md 和 catalog.json（素材目录）；
- .slate/hf-import/：每个素材的改写记录、检查结果、缩略图和小样（不进镜像）。

原素材的动画依赖 GSAP（不是开源许可，不能用），所以由模型逐个改写成运行时的 SLATE.timeline，
改写后在渲染浏览器里自动检查：能加载、不报错、同一时刻两次渲染一致、画面不空而且在动、中文不出界、不压字幕区。
没通过就把问题交回模型重改，最多 3 轮。来源的名字只留在许可证原文和 THIRD_PARTY_NOTICES.md 里。

用法：
  python scripts/import_hyperframes.py <来源仓库目录> convert [--kind shots|motions] [--only a,b] [--force] [--jobs 4]
  python scripts/import_hyperframes.py <来源仓库目录> index
需要本机能调 Bedrock（Opus 5.5）和 AgentCore Browser（渲染浏览器 ID 取自 .slate/outputs-<栈名>.json）。
"""
import argparse, asyncio, base64, concurrent.futures, contextlib, io, json, os, re, shutil, subprocess, sys, tempfile, time, traceback

import boto3
from botocore.config import Config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = os.path.join(ROOT, "agent", "skills")
SHOTS, MOTIONS = os.path.join(SKILLS, "kit-shots"), os.path.join(SKILLS, "kit-motion")
WORK = os.path.join(ROOT, ".slate", "hf-import")
SELECTION = os.path.join(ROOT, "scripts", "data", "kit-selection.json")
MODEL = os.environ.get("KIT_MODEL", "global.anthropic.claude-opus-5-5")
STACK = os.environ.get("STACK", "Slate")
MAX_ROUNDS = 3
# 来源自己在 CREDITS 里写明"出处待作者确认"的贴图，不导入
UNCONFIRMED = {"leaf-surface-color.webp", "leaf-surface-normal.webp", "matcap-1.png", "shards-atlas.png", "ice-inclusions-generated.png", "bluenoise64.png"}
BANNED = re.compile(r"hyper-?frames|heygen|gsap|greensock|__timelines|data-composition|jsdelivr|googleapis", re.I)
CODE_EXT = (".html", ".js", ".mjs", ".css", ".json", ".svg", ".md")
ASSET_EXT = (".png", ".jpg", ".jpeg", ".webp", ".svg", ".glb", ".gltf", ".bin", ".hdr", ".json", ".woff2", ".ttf", ".otf", ".wav", ".mp3")

br = boto3.client("bedrock-runtime", region_name="us-east-1", config=Config(read_timeout=900, retries={"max_attempts": 4, "mode": "adaptive"}))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- 来源
def item_dir(src, kind, name):
    return os.path.join(src, "registry", "blocks" if kind == "shots" else "components", name)


def is_vendored(rel, size):
    b = os.path.basename(rel).lower()
    return (b.startswith(("gsap", "three", "scrolltrigger", "customease", "motionpath")) or "-notice" in b or "license" in b
            or b.endswith(".min.js") or size > 150_000)


def sources(src, kind, name):
    """改写要看的源文件（去掉打包好的第三方库）和素材文件清单"""
    d = item_dir(src, kind, name)
    code, assets = [], []
    for root, _, files in os.walk(d):
        for f in sorted(files):
            p = os.path.join(root, f)
            rel, size = os.path.relpath(p, d), os.path.getsize(p)
            if f in UNCONFIRMED:
                continue
            if f.endswith(CODE_EXT) and not is_vendored(rel, size) and f != "registry-item.json":
                code.append((rel, open(p, encoding="utf-8", errors="ignore").read()))
            elif f.lower().endswith(ASSET_EXT):
                assets.append((rel, size))
    meta = json.load(open(os.path.join(d, "registry-item.json"), encoding="utf-8"))
    return meta, code, assets


def font_families():
    rows = re.findall(r"^\| ([^|]+?) \| `(/assets/fonts/lib/[^`]+)` \| ([^|]+?) \|", open(os.path.join(ROOT, "agent/image/assets/fonts/lib/FONTS.md"), encoding="utf-8").read(), re.M)
    return "\n".join(f"- {n}（{t}）：`{c}`" for n, c, t in rows)


# ---------------------------------------------------------------- 改写
CONTRACT = """
# Slate 场景页的约定（改写的目标）

- 页面运行在渲染浏览器里，逐帧调用全局函数 `window.render(t)`（t 是这一镜内的秒数）后截图。画面必须**只由 t 决定**：
  不用 CSS 动画、transition、setTimeout、setInterval、requestAnimationFrame、Date.now、performance.now；
  不在 render 里用 Math.random（用 `SLATE.rng(种子)` 在初始化时生成）。运行时会强制关掉 CSS 动画和 transition。
- 运行时在页面脚本之前注入 `SLATE`：`SLATE.width/height/u/duration/fps/safe/captionZone/captionsOn/rng/lerp/clamp/seg/interpolate/spring/noise/draw/svg/typewriter/countUp`，
  以及时间线工具 `SLATE.timeline()`（下面详述）和缓动 `SLATE.easing(名字)`。
- 页面不能访问外网。只能加载 `/skills/...`、`/assets/fonts/...`、`/node_modules/three/...`（three.js 0.170，用 importmap 映射 "three" 到 `/node_modules/three/build/three.module.js`，扩展在 `/node_modules/three/examples/jsm/...`）、同目录相对路径、`data:`。
- 字幕：运行时在画面底部自动画字幕（16:9 时是 y 从 81% 到 97% 的区域，左右各留 5%）。**模板里的文字一律不能放进这个区域**；四周 5% 是安全边距，文字也不要越出。下三分之一这类原本贴底的元素，改到字幕区上方（底边不低于画面 78%）。
- 需要等待加载的资源（字体、图片、模型）：把 Promise 放进 `SLATE.waits`，渲染前会等完。字体用 `document.fonts.load('700 60px "字体名"')` 这类调用放进 SLATE.waits。
- 只起装饰作用的重复文字（光晕、残影），容器加 `data-qa="ignore"`。

## 时间线工具 SLATE.timeline()

```js
const tl = SLATE.timeline();
tl.tween(目标, 属性, {at, dur, ease, each, from, amount, repeat, yoyo, repeatDelay});
tl.set(目标, 属性, at);            // 在 at 秒直接设成某状态
tl.call((p, t) => {...}, {at, dur, ease});   // 每帧都调用：p 在 at 之前是 0，at+dur 之后是 1；用于数字滚动、画布重绘、按进度改文字
tl.add(子时间线, at);
tl.at(t);                          // render(t) 里调用
tl.duration                        // 最后一段补间结束的时刻
```
- 目标：元素、元素数组、选择器字符串（注意选择器在整个文档里找，模板里要用 root 限定：`root.querySelectorAll(...)`）。
- 属性：x、y、z（px）、xPercent、yPercent（%）、rotate、rotateX、rotateY、skewX、skewY（度）、scale、scaleX、scaleY 组合成 transform；
  opacity、颜色、宽高、clipPath、filter、boxShadow 等 CSS 属性（驼峰；数字默认 px；含多个数字的字符串如 `inset(0 100% 0 0)` 会逐个数字补间，两端格式要一致）；
  `"--变量"`；`attr: {SVG 或 HTML 属性}`；`text: "逐字打出的文字"`。
- 值的写法：`终值`、`[起值, 终值]`、`{from: 起值}`（从起值回到原状态），或函数 `(i, el, n) => 值`。
- 起值：写了就用；没写就接着这个元素这个属性上一段补间的终值；再没有就是原状态（transform 各项是 0 和缩放 1，不读 CSS 的 transform；其他属性读初始计算样式）。
  `[起值, 终值]` 和 `{from}` 在开始前就显示起值。
- 不要在 CSS 里给要补间 transform 的元素写 transform（会被覆盖）；居中用 left/top + 负 margin、flex 或 xPercent/yPercent: -50。
- 缓动名字：linear、inQuad/outQuad/inOutQuad、Cubic、Quart、Quint、Sine、Expo、Circ、Back（可带参数 outBack(1.7)）、Elastic（outElastic(1, 0.3)）、Bounce、steps(5)。

## 从 GSAP 改写时的对应关系
- `gsap.timeline({paused:true})` → `SLATE.timeline()`；`gsap.set(el, v)`（初始化时）→ 直接写进初始样式，或 `tl.set(el, v, 0)`。
- `tl.to(el, {..., duration, ease, delay, stagger}, 位置)` → `tl.tween(el, {...}, {at: 绝对秒数, dur, ease, each})`；`from` → `{属性: {from: 值}}`；`fromTo` → `[起, 终]`。
- 位置参数一律换算成绝对秒数：不写位置时接在时间线当前末尾；`"<"` 是上一段的开始，`">"` 是上一段的结束，`"+=x"`/`"-=x"` 相对时间线末尾，`"<0.2"` 等相对上一段开始；标签换成具体秒数。默认 duration 0.5，默认 ease power1.out。
- 缓动：power1→Quad、power2→Cubic、power3→Quart、power4→Quint，`.in/.out/.inOut` → `in/out/inOut` 前缀（power3.out → outQuart）；none → linear；back.out(1.7) → outBack(1.7)；elastic.out(1, 0.3) → outElastic(1, 0.3)；expo/sine/circ/bounce 同名；steps(n) → steps(n)。
- stagger：数字 → each；`{each, from, amount}` 同名；网格错开用函数值或循环逐个 tween。
- repeat、yoyo、repeatDelay 同名，repeat: -1 表示一直重复。
- onUpdate、call、数值对象补间（比如 `{v: 0}` 补到 100 再写进文字或画布）→ `tl.call((p, t) => ..., {at, dur, ease})`，在回调里由 p 算出状态。
- autoAlpha → opacity，再加 visibility（opacity 为 0 时 hidden）。CSS @keyframes 动画 → 改成时间线。
- 原框架里带 `class="clip"` 和 `data-start/data-duration` 的元素只在那段时间内可见：用 tl.set 控制 visibility。
- 原框架的变量（data-var、模板占位符）→ 改成 content 参数里的字段。
- gsap.utils.toArray → KIT.els；gsap.utils.interpolate/clamp → SLATE.lerp/clamp；gsap.utils.random → SLATE.rng。

## 素材库公共函数 /skills/kit-motion/kit.js（已存在，直接用）
- `KIT.css(id, 样式文本)`：注入一次样式。`KIT.els(目标, scope)`、`KIT.el(...)`。
- `KIT.stage(root, 1920, 1080)`：在 root 里建一个按设计尺寸排版、自动缩放居中的舞台，返回舞台元素。
- `KIT.theme(el, {"--kit-accent": "#..."} )`：写 CSS 变量。
- `KIT.splitChars(el)`、`KIT.splitWords(el)`：把文字拆成 span（中文"词"按浏览器分词），返回 span 数组，只在初始化时调用。
- `KIT.fit(原设计时长, 实际时长)` → `{k, d, exitAt(len)}`：入场时间乘以 k（实际时长更短时等比压缩），退场从 exitAt(退场时长) 开始。
"""

SHOT_TASK = """
# 任务：把下面这个镜头模板改写成 Slate 的镜头模板

产出两个文件（以及模板自己需要的少量本地文件，比如 SVG、数据 JSON）：

1. `shot.js`：普通脚本（不是 ES module，除非模板必须用 three.js；用 three.js 时见下面第 4 条），内容是
```js
KIT.shots["{id}"] = function (root, o = {{}}) {{
  const content = Object.assign({{ /* 中文示例内容，每个字段写注释 */ }}, o.content);
  const theme = Object.assign({{ /* CSS 变量默认值：配色、字体，如 "--kit-accent": "#ff5a36", "--kit-font": "\\"Inter\\", \\"Noto Sans CJK SC\\", sans-serif" */ }}, o.theme);
  const {{ k, d, exitAt }} = KIT.fit({native}, o.dur);
  KIT.css("{id}", `...样式，选择器都以 .kit-{id} 开头...`);
  const stage = KIT.stage(root, {w}, {h});
  stage.classList.add("kit-{id}");
  KIT.theme(stage, theme);
  stage.innerHTML = `...`;   // 或者用 DOM 接口创建
  const tl = SLATE.timeline();
  // ...按原模板的节奏排补间；入场的时间乘以 k，退场用 exitAt(...)，让模板能撑满任意时长 d
  return tl;
}};
```
   - 原模板的配色、字号、间距、节奏、缓动、层次**尽量保持一致**，这是改写的首要目标；
   - 文字内容换成合适的中文示例（和模板用途相符，长度和原文差不多：英文 1 个单词约等于中文 1.5～2 个字）。中文字体放在字体栈里：无衬线 `"Noto Sans CJK SC"`，衬线 `"Noto Serif SC"`，手写可用 `"Ma Shan Zheng"`、`"Long Cang"`、`"ZCOOL KuaiLe"`（这三个要加载 /assets/fonts/lib/ 下对应的 CSS）；
   - 原来从网上加载的西文字体，换成下面字体库里最接近的一款（在 shot.js 里动态插入对应的 `<link rel="stylesheet">`，并把 `document.fonts.load(...)` 放进 SLATE.waits）。字体库里没有的，选气质最接近的；
   - 原来的图片素材：如果在素材清单里，复制过来用相对 shot.js 的路径引用（写成 `new URL("文件名", document.currentScript.src)`，或在 content 里留一个图片地址字段，默认值指向这个文件）；不在清单里的就用 CSS/SVG 画一个占位；
   - 可以在多个地方复用：不要用 id 选择器和全局变量，所有查询都限定在 stage 里；
2. `index.html`：示范页，也是自动检查用的场景：
```html
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{{margin:0;background:#...}} #main{{position:absolute;inset:0}}</style></head>
<body><div id="main"></div>
<script src="/skills/kit-motion/kit.js"></script>
<script src="/skills/kit-shots/{id}/shot.js"></script>
<script>
  const tl = SLATE.timeline().add(KIT.shots["{id}"](document.getElementById("main"), {{ dur: SLATE.duration }}), 0);
  window.render = t => tl.at(t);
</script></body></html>
```
   原模板是透明背景的叠加层（下三分之一、角标、转场遮罩）时，示范页给一个合适的背景（渐变或简单画面），检查才看得出效果。
3. 不要出现原框架、原作者或第三方库的名字（不要写 GSAP、HyperFrames 等字样，注释里也不要）。
4. 必须用 three.js 时：shot.js 写成 ES module，用 `import * as THREE from "three";`，扩展用 `import {{ ... }} from "three/addons/路径.js";`（three 的扩展文件内部也是 `from "three"`，所以**示范页 <head> 里必须先写 importmap**：`<script type="importmap">{{"imports":{{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}}}</script>`），文件末尾同样注册 `KIT.shots[...]`；示范页用 `<script type="module">` 加载，并在注册完成后设置 `window.READY = true`（示范页里 `window.READY = false` 写在最前面）。不能在模块里用 document.currentScript（模块里它是 null），要定位同目录文件用 `new URL("文件名", import.meta.url)`。three.js 版本是 0.170，原模板若用了更新版本的接口要改成 0.170 有的。渲染器要 `preserveDrawingBuffer: true`，不要 setAnimationLoop，在 tl.call 里按 t 渲染。

用 submit_shot 工具提交结果。
"""

MOTION_TASK = """
# 任务：把下面这个动效组件改写成 Slate 的动作

产出两个文件：

1. `{id}.js`：普通脚本，注册一个动作函数：
```js
/** 一句话说明（中文）。参数：... */
KIT.motions.{fn} = function (tl, target, o = {{}}) {{
  const els = KIT.els(target);
  const at = o.at ?? 0, dur = o.dur ?? /* 原设计的时长 */;
  // ...把原组件的动作排进 tl；时间都以 at 为起点，整体时长按 dur 等比缩放
  return tl;
}};
```
   - 动作作用在调用方给的元素上（标题、卡片、图片、整块画面等），不要自己造内容；确实需要辅助元素（光标、描边、遮罩）时在函数里创建，加到目标元素的父元素里，并加 `data-qa="ignore"`（如果是装饰性文字）；
   - 需要拆字时用 `KIT.splitChars` / `KIT.splitWords`（同一个元素只拆一次：拆过的元素有 `dataset.kitSplit` 标记，自己检查并设置）；
   - 原组件的节奏、缓动、幅度尽量保持；大小相关的量（位移、模糊半径）按 `SLATE.u`（短边的 1%）换算，适配不同画幅；
   - 不要出现原框架、原作者或第三方库的名字。
2. `demos/{id}.html`：示范页，也是自动检查用的场景。放一个合适的中文示例（标题、卡片等），调用动作，`window.render = t => tl.at(t)`。脚本这样引用：
```html
<script src="/skills/kit-motion/kit.js"></script>
<script src="/skills/kit-motion/{id}.js"></script>
```
   示范页的内容要在画面中部、字号够大（不小于 4 * SLATE.u），不要进字幕区。

用 submit_motion 工具提交结果。
"""

FILE_ITEMS = {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}
TOOLS = {
    "shots": {"name": "submit_shot", "description": "提交改写好的镜头模板", "inputSchema": {"json": {"type": "object", "properties": {
        "files": FILE_ITEMS,
        "assets": {"type": "array", "items": {"type": "string"}, "description": "要从原模板目录复制过来的素材文件（相对原目录的路径），复制后放在模板目录下的同名相对路径"},
        "title": {"type": "string", "description": "中文名，不超过 10 个字"},
        "summary": {"type": "string", "description": "一句话说明画面和动作，不超过 60 个字"},
        "use_when": {"type": "string", "description": "适合什么镜头，比如：讲数据排名变化、介绍嘉宾身份"},
        "content_fields": {"type": "array", "items": {"type": "object", "properties": {"key": {"type": "string"}, "desc": {"type": "string"}}, "required": ["key", "desc"]}},
        "theme_vars": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "desc": {"type": "string"}}, "required": ["name", "desc"]}},
        "native": {"type": "number", "description": "原设计时长（秒）"},
        "ratios": {"type": "array", "items": {"type": "string", "enum": ["16:9", "9:16", "1:1", "4:5"]}},
        "webgl": {"type": "boolean"},
        "notes": {"type": "string", "description": "用法提示和改写时的取舍（中文，可空）"}},
        "required": ["files", "title", "summary", "use_when", "content_fields", "native", "ratios", "webgl"]}}},
    "motions": {"name": "submit_motion", "description": "提交改写好的动作", "inputSchema": {"json": {"type": "object", "properties": {
        "files": FILE_ITEMS,
        "fn": {"type": "string", "description": "函数名（驼峰）"},
        "title": {"type": "string", "description": "中文名，不超过 10 个字"},
        "summary": {"type": "string", "description": "一句话说明效果，不超过 60 个字"},
        "use_when": {"type": "string"},
        "params": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "desc": {"type": "string"}}, "required": ["name", "desc"]}},
        "native": {"type": "number", "description": "默认时长（秒）"},
        "notes": {"type": "string"}},
        "required": ["files", "fn", "title", "summary", "use_when", "params", "native"]}}},
}


def camel(name):
    p = re.split(r"[-_]", name)
    return p[0] + "".join(x[:1].upper() + x[1:] for x in p[1:])


def prompt_for(kind, name, meta, code, assets):
    dims = meta.get("dimensions") or {}
    w, h = dims.get("width") or 1920, dims.get("height") or 1080
    native = meta.get("duration") or 4
    task = (SHOT_TASK if kind == "shots" else MOTION_TASK).format(id=name, fn=camel(name), native=native, w=w, h=h)
    m = {k: meta[k] for k in ("name", "title", "description", "tags", "dimensions", "duration", "variables") if k in meta}
    parts = [task, "\n# 原素材的说明\n```json\n" + json.dumps(m, ensure_ascii=False, indent=1)[:6000] + "\n```\n"]
    if assets:
        parts.append("# 原目录里的素材文件\n" + "\n".join(f"- {r}（{s // 1024} KB）" for r, s in assets[:60]) + "\n")
    for rel, text in code:
        parts.append(f"# 源文件 {rel}\n```\n{text[:60000]}\n```\n")
    parts.append("# 可用的字体库（/assets/fonts/lib/）\n" + font_families())
    return "\n".join(parts)


def converse(messages, kind):
    """Opus 5.5 不支持强制调用某个工具：没调用就提醒一次"""
    tool = TOOLS[kind]
    usage = {"inputTokens": 0, "outputTokens": 0}
    for _ in range(2):
        r = br.converse(modelId=MODEL, system=[{"text": "你是资深动效工程师，负责把一个素材库的动效模板改写成另一个渲染运行时的写法，要求视觉和节奏与原作尽量一致。"
                                                         f"完成后必须调用 {tool['name']} 工具提交，不要只用文字回复。" + CONTRACT}],
                        messages=messages, inferenceConfig={"maxTokens": 32000}, toolConfig={"tools": [{"toolSpec": tool}]})
        for k in usage:
            usage[k] += r.get("usage", {}).get(k, 0)
        msg = r["output"]["message"]
        use = next((b["toolUse"] for b in msg["content"] if "toolUse" in b), None)
        if use:
            return msg, use, usage
        messages = messages + [msg, {"role": "user", "content": [{"text": f"请调用 {tool['name']} 工具提交完整结果。"}]}]
    raise RuntimeError(f"模型没有调用 {tool['name']}（stopReason={r.get('stopReason')}）")


# ---------------------------------------------------------------- 写入
def out_paths(kind, name):
    if kind == "shots":
        return os.path.join(SHOTS, name), "index.html"
    return MOTIONS, f"demos/{name}.html"


def write_item(src, kind, name, res):
    base, demo = out_paths(kind, name)
    if kind == "shots":
        shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base, exist_ok=True)
    allowed = {"shot.js", "index.html"} if kind == "shots" else {f"{name}.js", demo}
    for f in res["files"]:
        rel = os.path.normpath(f["path"]).lstrip("./")
        if rel.startswith(".."):
            raise ValueError(f"文件路径越界：{f['path']}")
        if kind == "motions" and rel not in allowed:
            continue  # 动作只收两个文件
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w", encoding="utf-8").write(f["content"])
    for a in res.get("assets") or []:
        s = os.path.join(item_dir(src, kind, name), os.path.normpath(a))
        if os.path.basename(a) in UNCONFIRMED or not os.path.isfile(s) or os.path.normpath(a).startswith(".."):
            continue
        d = os.path.join(base, os.path.normpath(a))
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy(s, d)
    return os.path.join(base, demo)


def static_issues(kind, name):
    """不用浏览器就能查出的问题：禁用的名字和写法、外部地址"""
    base, demo = out_paths(kind, name)
    files = [os.path.join(base, "shot.js"), os.path.join(base, demo)] if kind == "shots" else [os.path.join(base, f"{name}.js"), os.path.join(base, demo)]
    if kind == "shots":
        files += [os.path.join(r, f) for r, _, fs in os.walk(base) for f in fs if f.endswith((".js", ".html", ".css", ".json", ".svg"))]
    out = []
    for p in sorted(set(files)):
        if not os.path.isfile(p):
            out.append(f"缺少文件 {os.path.relpath(p, ROOT)}"); continue
        s = open(p, encoding="utf-8", errors="ignore").read()
        rel = os.path.relpath(p, base)
        for m in sorted(set(x.group(0) for x in BANNED.finditer(s)))[:3]:
            out.append(f"{rel} 里出现了不允许的名字或写法：{m}")
        for m in sorted(set(re.findall(r"https?://(?!www\.w3\.org)[^\s\"')`]+", s)))[:3]:
            out.append(f"{rel} 引用了外部地址（会被拦截）：{m}")
        for bad in ("requestAnimationFrame", "setTimeout(", "setInterval(", "Date.now", "performance.now", "@keyframes"):
            if bad in s:
                out.append(f"{rel} 里用了 {bad}，画面必须只由 t 决定")
    return out


# ---------------------------------------------------------------- 渲染检查
_opt = None


def local_opt():
    """本机模拟镜像里的 /opt/slate：用符号链接指向仓库里的目录，page.py 就能原样使用"""
    global _opt
    if _opt:
        return _opt
    d = tempfile.mkdtemp(prefix="slate-opt-")
    img = os.path.join(ROOT, "agent", "image")
    for n in ("slate", "runtime", "assets", "film-core"):
        os.symlink(os.path.join(img, n), os.path.join(d, n))
    # page.py 会检查文件的真实路径在根目录之内：node_modules 本身指向一个只含 three 的目录，不能只链接里面的 three
    nm = os.path.join(WORK, "node_modules")
    if not os.path.isdir(os.path.join(nm, "three")):
        os.makedirs(nm, exist_ok=True)
        shutil.copytree(os.path.join(img, "vendor", "three"), os.path.join(nm, "three"))
    os.symlink(nm, os.path.join(d, "node_modules"))
    os.symlink(os.path.join(ROOT, "agent", "legacy-skills"), os.path.join(d, "legacy-skills"))
    sys.path.insert(0, d)
    _opt = d
    return d


def browser_id():
    out = json.load(open(os.path.join(ROOT, ".slate", f"outputs-{STACK}.json")))[STACK]
    return out.get("RenderBrowserId") or os.environ.get("SLATE_BROWSER_ID") or subprocess.run(
        ["aws", "bedrock-agentcore-control", "list-browsers", "--query", f"browserSummaries[?name=='{STACK}_render'].browserId | [0]", "--output", "text"],
        capture_output=True, text=True).stdout.strip()


def check_page(demo_path, dur, work, preview=True):
    """渲染检查放在子进程里跑：page.py 在导入时按环境变量定路径，多个素材并行检查时不能共用一个进程"""
    task = tempfile.mkdtemp(prefix="kit-task-")
    os.makedirs(os.path.join(task, "scenes", "01"))
    shutil.copy(demo_path, os.path.join(task, "scenes", "01", "index.html"))
    env = {**os.environ, "SLATE_TASK_DIR": task, "SLATE_SKILLS_DIR": SKILLS, "SLATE_BROWSER_ID": browser_id(), "PYTHONPATH": local_opt()}
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "-", "_check", work, str(dur), "1" if preview else "0"],
                           env=env, capture_output=True, text=True, timeout=1500)
    finally:
        shutil.rmtree(task, ignore_errors=True)
    last = (r.stdout.strip().splitlines() or [""])[-1]
    if r.returncode != 0 or not last.startswith("{"):
        raise RuntimeError(f"渲染检查没跑完：{(r.stderr or r.stdout)[-600:]}")
    return json.loads(last)


@contextlib.asynccontextmanager
async def _entered(sp):
    """已经手动进入的 ScenePage：用完照常关闭"""
    try:
        yield sp
    finally:
        await sp.__aexit__(None, None, None)


async def _check(dur, work, preview):
    """在渲染浏览器里打开示范页：抽 6 帧做自检，验证确定性，量每帧耗时，出缩略图和小样"""
    from PIL import Image, ImageChops, ImageStat
    from playwright.async_api import async_playwright
    import slate.page as pg
    cfg = {"width": 1920, "height": 1080, "fps": 30, "duration": dur, "scene": "01", "ratio": "16:9", "subtitles": True,
           "captions": [{"start": 0, "end": dur, "text": "这是一句示例字幕，用来检查画面里的文字有没有压到字幕区"}]}
    times = [round(dur * (i + 0.5) / 6, 2) for i in range(6)]
    issues, shots = [], []
    async with async_playwright() as pw:
        sp = pg.ScenePage(pw, "01", cfg, name=f"kit_{os.getpid()}")
        try:
            await sp.__aenter__()
        except Exception as e:  # 页面没能就绪：把真正的报错、页面里的错误和被拦截的请求交回去，模型才知道怎么改
            msg = re.findall(r"Error: (.+)", str(e)) or [str(e)]
            out = [{"t": None, "kind": "load", "text": msg[-1][:400]}]
            out += [{"t": None, "kind": "page_error", "text": x[:300]} for x in sorted(set(sp.errors))[:6]]
            out += [{"t": None, "kind": "external_request", "text": f"请求失败或被拦截：{x[:150]}"} for x in sorted(set(sp.blocked))[:6]]
            try:
                await sp.__aexit__(None, None, None)
            except Exception:
                pass
            return {"ok": False, "issues": out, "frame_s": None}
        async with _entered(sp):
            t0 = time.time()
            for t in times:
                await sp.frame(t)
                q = await sp.page.evaluate("window.__slateQA()")
                issues += [{"t": t, **it} for it in q["issues"]]
                shots.append(Image.open(io.BytesIO(await sp.png())).convert("RGB"))
            frame_s = round((time.time() - t0) / len(times), 2)
            # 确定性：跳到别处再回来，同一时刻的画面要一样
            await sp.frame(times[1]); await sp.frame(times[4]); await sp.frame(times[1])
            again = Image.open(io.BytesIO(await sp.png())).convert("RGB")
            diff = sum(ImageStat.Stat(ImageChops.difference(shots[1].resize((320, 180)), again.resize((320, 180)))).mean)
            if diff > 1.0:
                issues.append({"t": times[1], "kind": "nondeterministic", "text": f"同一时刻两次渲染不一样（差异 {diff:.1f}），画面依赖了上一次调用或随机数"})
            if preview:
                ff = subprocess.Popen([shutil.which("ffmpeg") or "ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "24", "-c:v", "mjpeg", "-i", "-",
                                       "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                                       os.path.join(work, "preview.mp4")], stdin=subprocess.PIPE)
                for f in range(int(dur * 24)):
                    await sp.frame(f / 24)
                    ff.stdin.write(await sp.jpeg())
                ff.stdin.close(); ff.wait()
            errors, blocked = list(sp.errors), list(sp.blocked)
    stds = [sum(ImageStat.Stat(im.convert("L").resize((160, 90))).stddev) for im in shots]
    if max(stds) < 4:
        issues.append({"t": None, "kind": "blank", "text": "画面几乎是纯色"})
    diffs = [sum(ImageStat.Stat(ImageChops.difference(a.resize((160, 90)), b.resize((160, 90)))).mean) for a, b in zip(shots, shots[1:])]
    from slate.qa import changed_share
    if max(diffs) < 0.5 and max(changed_share(a, b) for a, b in zip(shots, shots[1:])) < 0.002:
        issues.append({"t": None, "kind": "static", "text": "6 个采样点画面几乎一样，没有动起来"})
    for e in sorted(set(errors))[:5]:
        issues.append({"t": None, "kind": "page_error", "text": e[:300]})
    for b in sorted(set(blocked))[:5]:
        issues.append({"t": None, "kind": "external_request", "text": f"请求了不允许的地址：{b[:150]}"})
    sheet = Image.new("RGB", (3 * 640 + 32, 2 * 360 + 24), (40, 40, 40))
    for i, im in enumerate(shots):
        sheet.paste(im.resize((640, 360)), (8 + (i % 3) * 648, 8 + (i // 3) * 368))
    sheet.save(os.path.join(work, "sheet.jpg"), quality=85)
    seen, out = set(), []
    for it in issues:
        k = (it["kind"], it.get("text"))
        if k not in seen:
            seen.add(k); out.append(it)
    return {"ok": not out, "issues": out[:15], "frame_s": frame_s}


# ---------------------------------------------------------------- 主流程
def convert(src, kind, name, force=False):
    work = os.path.join(WORK, kind, name)
    done = os.path.join(work, "result.json")
    if os.path.isfile(done) and not force:
        r = json.load(open(done, encoding="utf-8"))
        if r.get("ok"):
            return r
    os.makedirs(work, exist_ok=True)
    meta, code, assets = sources(src, kind, name)
    messages = [{"role": "user", "content": [{"text": prompt_for(kind, name, meta, code, assets)}]}]
    usage, last = {"inputTokens": 0, "outputTokens": 0}, None
    for rnd in range(1, MAX_ROUNDS + 1):
        msg, use, u = converse(messages, kind)
        for k in usage:
            usage[k] += u.get(k, 0)
        messages.append(msg)
        res = use["input"]
        json.dump(res, open(os.path.join(work, f"round{rnd}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        try:
            demo = write_item(src, kind, name, res)
            problems = [{"kind": "static", "text": x} for x in static_issues(kind, name)]
            native = float(res.get("native") or meta.get("duration") or 4)
            chk = check_page(demo, max(2.0, min(native, 20.0)), work, preview=not problems)
            problems += chk["issues"]
        except Exception as e:
            traceback.print_exc()
            problems, chk = [{"kind": "error", "text": f"{type(e).__name__}: {str(e)[:400]}"}], {"frame_s": None}
        last = {"name": name, "kind": kind, "round": rnd, "ok": not problems, "issues": problems, "frame_s": chk.get("frame_s"),
                "meta": {k: v for k, v in res.items() if k not in ("files", "assets")}, "usage": usage}
        log(kind, name, f"第 {rnd} 轮", "通过" if not problems else f"{len(problems)} 个问题：" + "；".join(p["text"][:60] for p in problems[:3]))
        if not problems:
            break
        messages.append({"role": "user", "content": [{"toolResult": {"toolUseId": use["toolUseId"], "status": "error", "content": [{"text":
            "自动检查发现以下问题，请修正后重新提交完整的文件（所有文件都要重新给出）：\n" + json.dumps(problems, ensure_ascii=False, indent=1)}]}}]})
    json.dump(last, open(done, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if not last["ok"]:  # 三轮都没通过：不收录
        base, _ = out_paths(kind, name)
        if kind == "shots":
            shutil.rmtree(base, ignore_errors=True)
        else:
            for p in (os.path.join(MOTIONS, f"{name}.js"), os.path.join(MOTIONS, "demos", f"{name}.html")):
                if os.path.exists(p):
                    os.remove(p)
    return last


def cmd_convert(a):
    sel = json.load(open(SELECTION, encoding="utf-8"))
    jobs = [(k, n) for k in (["shots", "motions"] if not a.kind else [a.kind]) for n in sel[k] if not a.only or n in a.only.split(",")]
    log(f"共 {len(jobs)} 个素材，并发 {a.jobs}")
    results = []
    with concurrent.futures.ThreadPoolExecutor(a.jobs) as ex:
        futs = {ex.submit(convert, a.src, k, n, a.force): (k, n) for k, n in jobs}
        for f in concurrent.futures.as_completed(futs):
            k, n = futs[f]
            try:
                results.append(f.result())
            except Exception as e:
                traceback.print_exc()
                results.append({"name": n, "kind": k, "ok": False, "issues": [{"kind": "error", "text": str(e)[:300]}]})
    ok = [r for r in results if r.get("ok")]
    tok = [r.get("usage", {}) for r in results]
    cost = sum(u.get("inputTokens", 0) for u in tok) * 4e-6 + sum(u.get("outputTokens", 0) for u in tok) * 20e-6
    log(f"通过 {len(ok)}/{len(results)}，本次模型费用约 ${cost:.2f}")
    for r in results:
        if not r.get("ok"):
            log("未收录：", r["kind"], r["name"], "；".join(i["text"][:80] for i in r.get("issues", [])[:3]))


NOTICE = "/* 改编自 Apache-2.0 许可的开源素材，动画和写法有改动。许可证原文见 /opt/slate/licenses/kit/LICENSE */\n"


def mark_changed(p):
    """Apache-2.0 要求改过的文件注明有改动：在文件开头加一行说明（ES module 的 import 也可以在注释之后）"""
    s = open(p, encoding="utf-8").read()
    if not s.startswith(NOTICE):
        open(p, "w", encoding="utf-8").write(NOTICE + s)


def cmd_index(a):
    """按检查结果生成两个 Skill 的目录（catalog.json）和 SKILL.md 里的清单，给改过的文件加上改动说明"""
    for kind, base in (("shots", SHOTS), ("motions", MOTIONS)):
        rows = []
        d = os.path.join(WORK, kind)
        for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            p = os.path.join(d, n, "result.json")
            if not os.path.isfile(p):
                continue
            r = json.load(open(p, encoding="utf-8"))
            if r.get("ok"):
                rows.append({"id": n, **r["meta"], "frame_s": r.get("frame_s")})
                files = [os.path.join(base, n, "shot.js")] if kind == "shots" else [os.path.join(base, f"{n}.js")]
                for f in files:
                    if os.path.isfile(f):
                        mark_changed(f)
        json.dump(rows, open(os.path.join(base, "catalog.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        md = os.path.join(base, "SKILL.md")
        s = open(md, encoding="utf-8").read()
        if kind == "shots":
            lines = [f"| `{r['id']}` | {r['title']} | {r['use_when']} | {r.get('native', '')} 秒 | {'、'.join(r.get('ratios') or [])} | {'是' if r.get('webgl') else ''} |" for r in rows]
            table = "| id | 名称 | 适合 | 原设计时长 | 画幅 | WebGL |\n|---|---|---|---|---|---|\n" + "\n".join(lines)
        else:
            lines = [f"| `KIT.motions.{r['fn']}` | `{r['id']}.js` | {r['title']} | {r['use_when']} | {r.get('native', '')} 秒 |" for r in rows]
            table = "| 函数 | 文件 | 名称 | 适合 | 默认时长 |\n|---|---|---|---|---|\n" + "\n".join(lines)
        s = re.sub(r"<!-- 清单开始 -->.*<!-- 清单结束 -->", lambda m: f"<!-- 清单开始 -->\n{table}\n<!-- 清单结束 -->", s, flags=re.S)
        open(md, "w", encoding="utf-8").write(s)
        log(kind, f"{len(rows)} 个已收录")


def main():
    if sys.argv[2:3] == ["_check"]:  # 子进程：python import_hyperframes.py - _check <work> <dur> <preview>
        print(json.dumps(asyncio.run(_check(float(sys.argv[4]), sys.argv[3], sys.argv[5] == "1")), ensure_ascii=False))
        return
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src")
    ap.add_argument("cmd", choices=["convert", "index"])
    ap.add_argument("--kind", choices=["shots", "motions"])
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    {"convert": cmd_convert, "index": cmd_index}[a.cmd](a)


if __name__ == "__main__":
    main()
