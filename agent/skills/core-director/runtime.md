# SLATE 运行时

`slate-render` 和 `slate-qa` 会在场景脚本运行**之前**注入运行时，所以页面脚本里可以直接使用 `SLATE`。

## 属性

| 属性 | 说明 |
|---|---|
| `SLATE.width`、`SLATE.height` | 画布像素尺寸，例如 1920×1080 或 1080×1920 |
| `SLATE.short` | 短边像素 |
| `SLATE.u` | **短边的 1%**（1080p 横屏时是 10.8 像素）。字号、间距、线宽都写成它的倍数，例如标题 `6 * SLATE.u` |
| `SLATE.duration`、`SLATE.fps` | 这一镜的时长（秒）和帧率 |
| `SLATE.ratio` | `16:9`、`9:16`、`1:1`、`4:5` |
| `SLATE.safe` | 安全区 `{x, y, w, h}`，四周各留 5% |
| `SLATE.captionZone` | 字幕区 `{x, y, w, h}`。`SLATE.captionsOn` 为 true 时不要把文字放进去 |
| `SLATE.captions` | 字幕时间轴 `[{start, end, text}]`，可以用来让画面和旁白对齐 |

## 工具函数

| 函数 | 说明 |
|---|---|
| `SLATE.seg(t, a, b, fn?)` | t 在 [a, b] 之间的进度，返回 0～1，默认带 `ease.out` 缓动 |
| `SLATE.stagger(t, i, start, gap, dur?)` | 第 i 个元素的入场进度：从 start 开始，每隔 gap 秒出现一个 |
| `SLATE.ease.{linear,in,out,inOut,back,elastic}` | 缓动函数 |
| `SLATE.clamp(x, a, b)`、`SLATE.lerp(a, b, p)` | 限制范围、线性插值 |
| `SLATE.typewriter(text, p)` | 打字机效果，按进度返回前若干个字 |
| `SLATE.countUp(to, p, digits?, from?)` | 数字滚动，返回字符串 |
| `SLATE.draw(pathEl, p, recompute?)` | 把 SVG 的 path、line、polyline 按进度画出来。路径长度会缓存，路径形状会变时传 `recompute = true` |
| `SLATE.svg(tag, attrs, parent)` | 创建 SVG 元素 |
| `SLATE.rng(seed)` | 确定性随机数生成器，返回一个函数。**`render(t)` 里不要用 `Math.random`**：它被换成了固定种子的版本（给 three.js 这类库内部用），在 render 里调用会被 slate-qa 报出来 |
| `SLATE.waits.push(promise)` | 需要先加载完才能渲染的资源（比如自己 new 的 Image），渲染前会等它完成 |

## 动画工具（弹簧、多段插值、分段时间轴、转场）

| 函数 | 说明 |
|---|---|
| `SLATE.interpolate(t, [t0, t1, …], [v0, v1, …], {easing, extrapolate})` | 多段插值；默认在区间外夹住端点值（`extrapolate: 'clamp'`） |
| `SLATE.spring(t, {start, from, to, stiffness, damping, mass, overshoot})` | 弹簧动画：从 start 秒开始由 from 弹到 to。默认 100/10/1 有轻微回弹；damping 调到 20 左右不回弹；`overshoot: false` 时不超过终点 |
| `SLATE.sequence(t, [段长…])` | 把一镜拆成几段，返回 `{index, t, p, d, start}`（当前第几段、段内秒数、段内进度、段长、段起点） |
| `SLATE.local(t, start)` | 段内时间（`t - start`），用于"从第 2 秒开始的子动画" |
| `SLATE.transition(t, elA, elB, {at, dur, kind, dir})` | 一镜内两个画面之间的转场，kind 可选 `fade`、`slide`、`wipe`、`zoom`、`blur`、`flip`；dir 可选 `left`、`right`、`up`、`down` |
| `SLATE.noise(seed, x)` | 平滑噪声（-1～1），做漂浮、轻微抖动、闪烁 |

## 时间线工具（编排多段动作）

动作多、先后关系复杂时，用时间线把补间按时间点排好，比在 render 里手算每个元素的进度更清楚：

```js
const tl = SLATE.timeline();
tl.tween(".title", { opacity: [0, 1], y: [40, 0] }, { at: 0.3, dur: 0.6, ease: "outCubic" });
tl.tween(".item", { opacity: [0, 1], x: [-30, 0] }, { at: 1.0, dur: 0.5, each: 0.12 });   // 多个元素依次错开
tl.tween(".bar", { scaleX: [0, 1] }, { at: 1.6, dur: 0.8, ease: "outQuart" });
tl.call(p => { num.textContent = SLATE.countUp(128, p); }, { at: 1.6, dur: 0.8 });          // 每帧按进度改文字或重画画布
tl.set(".hint", { visibility: "hidden" }, 4.2);
window.render = t => tl.at(t);
```

| 写法 | 说明 |
|---|---|
| `tl.tween(目标, 属性, {at, dur, ease, each, from, amount, repeat, yoyo})` | 目标是元素、元素数组或选择器。`each` 是多个目标之间的间隔秒数，`from` 指定从哪头开始错开（start、end、center、edges、random、序号）；`repeat: -1` 一直重复，`yoyo` 往返 |
| 属性 | `x`、`y`（px）、`xPercent`、`yPercent`（%）、`rotate`、`scale`、`scaleX`、`scaleY`、`skewX` 等组合成 transform；`opacity`、颜色、宽高、`clipPath`、`filter` 等 CSS 属性（数字默认 px，`inset(0 100% 0 0)` 这类字符串逐个数字补间）；`"--变量"`；`attr: {SVG 属性}`；`text: "逐字打出的文字"` |
| 值 | `终值`、`[起值, 终值]`、`{from: 起值}`（从起值回到原状态）、函数 `(i, el, n) => 值` |
| `tl.set(目标, 属性, at)` | 在 at 秒直接设成某状态 |
| `tl.call((p, t) => …, {at, dur, ease})` | 每帧都会调用，p 在 at 之前是 0、at+dur 之后是 1 |
| `tl.add(子时间线, at)` | 把模板或另一条时间线放到 at 秒处 |
| `SLATE.easing(名字)` | 缓动：linear、inQuad/outQuad/inOutQuad、Cubic、Quart、Quint、Sine、Expo、Circ、`outBack(1.7)`、`outElastic(1, 0.3)`、Bounce、`steps(5)` |

- 起值没写时，接着这个元素这个属性上一段的终值；再没有就是原状态。`[起值, 终值]` 在开始前就显示起值，所以入场前隐藏的元素不用另外处理。
- 要补间 transform 的元素，不要在 CSS 里写 transform（会被覆盖），居中用 flex 或 `xPercent: -50`。
- 时间线只在初始化时排一次，`render(t)` 里只调用 `tl.at(t)`，可以任意跳转，结果只由 t 决定。

熟悉 React 视频框架写法的话，可以这样对应：
- `useCurrentFrame() / fps` → `t`；
- `interpolate(frame, …)` → `SLATE.interpolate(t, …)`（输入单位是秒）；
- `spring({frame, fps, config})` → `SLATE.spring(t, {start, stiffness, damping})`；
- `<Sequence from>` → `SLATE.local(t, start)` 或 `SLATE.sequence`；
- 转场序列 → `SLATE.transition`。

区别在于：这里没有 React，元素在脚本开头一次性创建，`render(t)` 里只改它们的属性。

## 规则

- 全局函数 `render(t)` 必须存在，并且是纯函数：每一帧都要从头设置所有元素的状态。
- 运行时会禁用 CSS 动画和 transition。
- 场景脚本在全局作用域运行，**不要用浏览器已占用的名字当全局变量**，比如 `top`、`parent`、`name`、`self`、`status`、`length`、`origin`、`history`、`location`，否则脚本会直接报错。可以把代码包在 `{ ... }` 块里，或者换个名字（例如 `y0`、`y1`）。
- 只起装饰作用的文字副本（光晕、色差、倒影），在它们的容器上加 `data-qa="ignore"`，slate-qa 就不会把它们算成文字重叠。
- 页面只能加载以下几类资源，其他请求都会被拦截：
  - `/skills/<风格>/…`；
  - `/input/…`（用户上传的文件）；
  - `/assets/fonts/…`（平台自带的 OFL 字体，各风格 SKILL.md 会写明用哪个；`/assets/fonts/lib/` 下是按字符切片的字体库，清单见 `/opt/slate/assets/fonts/lib/FONTS.md`）；
  - `/core/…`、`/node_modules/three/…`（影片风格 film-* 的公共库和 three.js，用法见 film-kit）；
  - 同目录的相对路径；
  - `data:` 地址。
- 字体：中文默认用 `"Noto Sans CJK SC", sans-serif`（风格 Skill 的 style.css 里已经设置好）。需要宋体、毛笔字等字体时，只用风格 Skill 里写明的 `/assets/fonts/` 字体，不要自己找别的字体。
- 字幕：运行时自动画在 `SLATE.captionZone`。风格可以用 CSS 变量（`--slate-caption-bg`、`--slate-caption-color`、`--slate-caption-font`）或 `.slate-caption` 类调整样式，但不要改字幕的位置。
