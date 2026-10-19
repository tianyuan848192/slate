---
name: anatomy
description: 机械图解风格。把一个技术概念画成一台真实、精细的小机器（测试台、千分表、抽屉柜、绘图仪、锁芯），用等轴测 SVG 画出几十上百个带体积的小零件，机构怎么动就是概念怎么运作，读数由同一个模型算出。适合硬核原理讲解：算法、缓存、渲染管线、系统架构、物理和工程原理。
---

# 机械图解

像精密仪器的产品插图：一块厚底板，导轨、滑台、弹簧、旋钮、表盘，螺丝是小圆点。观众一看就认出这是一台机器，也就看懂了它在讲的道理。

**最重要的一条：机器本身就是解释。** 不画方框、箭头和标签，而是发明一台真实的、做工精良的机器，让它的工作方式一一对应概念：

| 概念 | 机器 |
|---|---|
| 一个 GPU 上下文服务多块画布 | 龙门绘图仪：一个打印头轮流访问 16 个格子 |
| 内容没变就跳过计算的缓存 | 弹子锁：弹子全对齐，锁芯才转，什么都不用重画 |
| 七种渲染目标，每种每像素字节数不同 | 七个抽屉的柜子，每个抽屉的深度就是它的字节数 |
| 弹簧按压后会倾斜 | 带弹簧、探针和千分表的测试台 |
| 光照取决于朝向 | 小摄影棚：主灯和补光灯围着一个转台 |

先用一句话说清"什么在动、动代表什么"，再开始画。

## 是什么 / 不是什么

**是什么**：
1. 等轴测视角（方位角默认 45°，仰角 30°），所有零件都是实心的，按前后顺序遮挡，没有透视线和虚线；
2. 四档明暗：底座和脚 `lo`、结构 `mid`、主体 `hi`，**只有一个零件是 `lit`**（深色主题里是白色），就是观众该盯着看的那个；
3. 细节小而准：0.4～1.6 的倒角、离边 3～5 的沟槽、角上的螺丝点、旋钮上的滚花、刻度尺、铭牌；每个细节都属于一个零件；
4. 线条都有着落：每根线都结束在一个面、另一根线或一个端点上，没有悬空的引线和标签；
5. 动作平静而真实：滑台滑过去慢慢停住，弹簧回弹一次，指针转到新读数。读数和动作来自同一个模型。

**不是什么**：
- 不是流程图：不用框、箭头、气泡标签说明关系；
- 不是 3D 渲染：没有透视、没有贴图，靠四档明暗和细节出体积；
- 不是卡通：比例和动作要像真机器，数字要真实。

## 画面

- **主题**：`dark`（默认，炭黑底）或 `light`（纸白底）。深色更有质感，亮色在手机上更醒目。全片统一一种。
- **版式**：画面是一整张"图版"。左上角图号（如"图 1"），右上角短标题，左下角一句说明，右下角实时读数（如"第 2 块 · 读数 14.0"）。四角文字由 `A.stage` 放好，都在安全区内、字幕区上方。**画面里除了最多一个刻在零件上的小铭牌字，不放别的字。** 要解释的话交给旁白和字幕。
- **构图**：机器居中，占图版的 55%～65%。一支片子里各镜的比例尺保持一致。
- **颜色**：只有颜色本身就是讲解对象时（比如红绿蓝三个通道）才用颜色，否则全靠明暗。

## 用法

页面是 ES module 写法（和影片风格一样）：最前面 `window.READY = false`，初始化做完调用 `A.ready()`。

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<script>window.READY = false;</script></head><body>
<script type="module">
import * as A from "/skills/anatomy/slate.mjs";
const { k } = A;                       // 工具库：k.fitProjection、k.slabOf、k.cylinder、k.solidSvg……
// 1. 几何：世界坐标约 1 单位 = 真机 1 像素，x、y 在地面，z 朝上
const P = k.fitProjection(/* 所有关键点 */ pts, 600, 380, { pad: 18, azimuth: 42 });
// 2. 一次性算好所有静态零件的路径（照 examples/ 里 build.mjs 的写法），拼成 SVG
const st = A.stage({ fig: "图 1", title: "千分表", sub: "测杆落在哪块上，指针就转多少" });
const svg = st.mount(k.figureSvg({ width: 600, height: 380, label: "…", body: [/* 从后往前画 */] }));
// 3. 动画：时间表 + 固定步长仿真，画面只由 t 决定
const target = A.cue([[0, x0], [2.4, x1], [4.8, x2]]);       // 按旁白讲到的时刻安排
const motion = A.sim({ init: () => ({ x: x0, tip: { at: 0, rate: 0 } }),
                       step: (s, dt, t) => { s.x = A.follow(s.x, target(t), dt, 0.28); A.spring(s.tip, h(s.x), dt, 420, 26); } });
window.render = t => { const s = motion.at(t); /* setAttribute 移动零件、改需要变形的路径 */ st.readout("…"); };
A.ready();
</script></body></html>
```

完整的示范页：`demo/dial-indicator/index.html`（千分表，约 200 行，先看它）。

### 文件

| 文件 | 内容 |
|---|---|
| `slate.mjs` | Slate 适配层：`stage` 全屏图版，`sim` 固定步长仿真，`follow` 指数跟随，`spring` 弹簧，`cue` 时间表，`audit` 页面内几何自检，`ready` |
| `kit/iso-kit.mjs` | 工具库核心：相机和投影、实体（`slabOf`、`cylinder`、`extrude`）、零件（`knurl`、`coil`、`topTicks`、`radialTicks`、`haloOf`）、绘制（`solidSvg`、`lineSvg`、`dotsSvg`、`wireSvg`、`faceTextSvg`）、`depthOf` 排序、`translateAlong` 移动 |
| `kit/lathe.mjs` | 任意轴上的回转体：法兰、阀门、钟形、球；圆面上的筋、螺栓圈；从密封套里伸出的活塞杆 |
| `kit/tube.mjs` | 管子和线缆：切成可排序的小段，管箍处断开，编织和波纹跟着截面走 |
| `kit/audit.mjs` | 几何自检：穿模、端点有没有落在接口上、折弯、遮挡顺序 |
| `kit/gl.mjs` | 画在机器里的 WebGL 效果（火焰、尾焰、水面、焦散、灯光），用同一个等轴测相机 |
| `references/craft.md` | 零件词汇和做法、遮挡顺序、管线走法（英文原文） |
| `references/kit.md` | 工具库每个函数的说明（英文原文） |
| `references/webgl.md` | WebGL 效果怎么做到不跳变、不穿帮（英文原文） |
| `examples/` | 原版 5 个示例的源码（千分表、台式电脑、街机柜、火箭发动机试车台、波纹槽），**照它们的几何写法**；其中构建、写文件和交互的部分不用管 |

参考文档里提到的 Node 构建脚本、`capture.mjs`、`drive.mjs`、`lines.mjs`、发布到画廊，在 Slate 里都不用：几何直接在页面里算，检查用 `slate-qa` 和 `slate-look`。

### 读什么、怎么读

- **必读**：这份 SKILL.md、示范页 `demo/dial-indicator/index.html`、下面的速查表。读完这三样就动手。
- **按需查**：`references/` 和 `examples/` 都很长（几百到上千行），**不要整篇读**。需要某个零件时用 `grep -n "knurl\|coil" references/craft.md` 这类命令找到位置，再用 `sed -n '起,止p'` 只看那一段。
- 不要从网页交互的角度研究原版示例（指针、键盘、可见性），这些在视频里都不用。

### 速查：`k`（kit/iso-kit.mjs）最常用的函数

| 用途 | 函数 |
|---|---|
| 投影 | `fitProjection(关键点, 宽, 高, {pad, azimuth, elevation})` → P；`iso([x,y,z], P)` 世界坐标转屏幕；`depthOf([x,y,z], P)` 排序用的深度 |
| 平面形状 | `roundedPlan({x,y,w,d,r})`、`corners(plan, 内缩)`、`insetPlan(plan, 距离)`、`circleRing(cx, cy, r)` |
| 实体 | `slabOf(plan, z, 高, P, 圆角步数, 倒角)` 圆角长方体；`cylinder(cx, cy, r, z, 高, P, 步数, 倒角)`；`extrude(环, z, 高, P)` 任意截面 |
| 线和细节 | `planOutline(plan, z, P)`、`lineOnTop(a, b, z, P)`、`ring(cx, cy, r, z, P)`、`knurl(...)` 滚花、`coil(...)` 弹簧、`topTicks` / `sideTicks` / `radialTicks` 刻度、`haloOf(plan, z, 高, P)` 底部柔光 |
| 绘制成 SVG 字符串 | `solidSvg(路径, {tone, crease, lit})`、`lineSvg(d, {tone})`、`dotsSvg(点, {size, tone})`、`wireSvg(起, 止, {via})`、`faceTextSvg(topMatrix(...), 文字, {size})`、`figureSvg({width, height, label, body})` |
| 移动 | `translateAlong(P, [dx, dy, dz])` 返回 transform 字符串，写到 `<g>` 上 |

tone 取 `lo`、`mid`、`hi`；全图只有一个零件 `lit: true`。

### 文件怎么写

- 机器的代码拆成几个模块，放在 `scenes/_machine/` 下（比如 `world.mjs` 尺寸和投影、`parts.mjs` 静态零件、`moving.mjs` 会动的零件和模型），各镜的 `index.html` 只 import 它们，再写这一镜的时间表和 `render(t)`。场景里用相对路径 `../_machine/parts.mjs` 引用。
- **每个文件不超过约 250 行，一条命令只写一个文件。** 零件多就多拆几个文件，不要一次写一个上千行的大文件。
- 先写出最简单的一版（底座、主体、会动的那一个零件），渲染第一镜看效果，再加细节。动手后 20 分钟内应该能渲染出第一镜。

## 做法

1. **先定一台机器**：一句话说清"什么在动、动代表什么"。数字要真实（尺寸、数量、阈值）。能写成一个纯函数模型的（比如"测杆下面有多高"），画面和读数都从它来。
2. **零件清单**：至少 40 个零件，按底座、结构、机构、操作件、主体分组，每个零件都坐在另一个零件上。一支片子通常**一台机器贯穿多镜**：每镜换一个动作阶段或镜头位置，比做几台不同的机器效果好，也省时间。
3. **画法照原版**：静态零件在初始化时一次算好；会动的零件放在 `<g>` 里，在 `render(t)` 里用 `translateAlong` 移动；只有形状会变的零件（压缩的弹簧、转动的指针）每帧重算路径。从后往前、从下往上画，包住别的零件的东西拆成前后两半。
4. **动作跟旁白走**：用 `A.cue` 把"讲到第几块量块"这类时刻排成时间表（配音时间轴在 `voice/NN.json` 的 `captions` 里）；用 `A.follow`、`A.spring` 在 `A.sim` 里推进。**不要用 requestAnimationFrame、鼠标、键盘、IntersectionObserver、prefers-reduced-motion**，这些是原版做网页交互用的。
5. **读数**：`st.readout()` 每帧更新，单位真实、文字短。读的是零件此刻的位置，不是目标值。
6. **有管线、圆形零件时跑几何自检**：照 `references/kit.md` 第 12 节用 `audit.recorder` 记录零件，初始化末尾 `await A.audit(R, P)`。有问题会在控制台报错，`slate-qa` 会报出来，按提示改几何，不要靠调排序值掩盖。
7. **WebGL 效果**（可选）：照 `references/webgl.md` 和火箭、波纹槽两个示例，用 `kit/gl.mjs` 的 `glLayer`。着色器在 CPU 上软件渲染，复杂效果每帧要零点几秒到几秒，一支片子里少用。效果的强度要有起落（attack、decay），由 t 决定，不能突然出现或消失。

## 节奏和时间

- 一镜 5～12 秒，一个动作阶段配一句旁白。动作开始前留 0.3～0.5 秒让观众看清机器，动作结束后停 1 秒让读数被读到。
- 精细的机器写起来慢：40～80 个零件的一台机器，写好通常要 30～60 分钟。用户没有特别要求时控制在这个规模，不做上百个零件的大机器。
- 渲染：纯 SVG 的机器每帧约 0.25 秒；带 WebGL 的复杂机器每帧 0.1～1 秒。

## 坑（症状 → 修法）

- 画面一片黑、零件看不清 → 深色主题本来对比就低，确认 `lit` 零件只有一个、主体用 `hi`；需要更醒目时整片换 `light` 主题。
- 线条太细 → `A.stage` 已经让线条随画面放大；还是细就把 `fitProjection` 的宽高调小一些（图在画面里放得更大）。
- 分片渲染时某一帧和前后对不上 → 状态必须全部放在 `sim` 的 state 里，不要在 `render` 外面累加变量；`step` 里只用 dt 和 t。
- 自检报穿模 → 改几何（留出 1.5 倍管径的间隙、在直段交叉），不要调排序值。
- 文字压到字幕区 → 机器里不要放说明文字；四角文字由 `A.stage` 摆放，不要自己挪。

<!-- 版本标识：slate-skill-c376608e09 -->
