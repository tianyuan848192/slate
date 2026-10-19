---
name: film-kit
description: 影片风格（film-* 开头的 43 个风格）的总说明：在 Slate 里用这类风格做片子的流程、页面写法、公共库、字体和 3D。选了任何 film-* 风格时先读这里。
---

# 影片风格总说明

film-* 是一组影片风格，共 43 个，清单见 `STYLES.md`。和其他官方风格相比，它们更像短片：故事和节奏先行，画面用 Canvas 2D 或 WebGL 逐帧画出来，很多风格自带画笔引擎、角色绑定和后期处理。每个风格的 SKILL.md 里是风格说明（英文原文），`DEMO.md` 和 `demo/` 是一支示范短片的说明和源码。

## 1. 流程

在导演手册的 7 个步骤之上，做这几件事：

- **写分镜前**：读选定风格的 SKILL.md，再读本目录的 `DIRECTOR.md` 第 3～5 节和第 7～10 节。要点：
  - 故事先行：一个主体、一个目标、一个转折；
  - 开头 3 秒要有钩子；
  - 安排一个只有这种风格才能做的招牌镜头，放在情绪最高点；
  - 节奏有快有慢，至少有一处停顿；
  - 每个镜头运动都要有理由。
- **先定自己的结构，再看示范片**：示范片只用来学技法（笔触引擎、角色绑定、着色器、转场写法），不要照搬它的故事、角色、镜头、片名和片尾字卡。
- **声音由平台处理**：旁白照常用 `slate-voice` 配音，镜头时长按配音定。配乐、音效、混音由平台负责，风格说明和 `DIRECTOR.md` 里讲声音的部分跳过。
- **每镜一个页面** `scenes/NN/index.html`。镜与镜之间用本风格自己的转场手法，比如纸张折过去、墨晕开、网格扫过：写在上一镜的结尾和下一镜的开头，两边要对上。
- **先出样片再铺开**：第一镜写好后，先 `slate-render`、`slate-qa`，再用 `slate-look` 对照风格说明看一次，达到标准再写其他镜。
- **自检**：交付前按 `DIRECTOR.md` 第 10、11 节过一遍。

## 2. 页面写法

照示范片的组织方式写：

```html
<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<link rel="stylesheet" href="/assets/fonts/lib/archivo.css">
<style>html,body{margin:0;background:#EAE9E5}canvas{display:block}</style>
</head><body><canvas id="c"></canvas>
<script type="module">
import { clamp, lerp, seg, ss, eio, mulberry, track } from '/core/lib.js';
const W = SLATE.width, H = SLATE.height;
const cv = document.getElementById('c'); cv.width = W; cv.height = H;
const g = cv.getContext('2d');
await document.fonts.load('700 120px Archivo', '这一镜画布上要写的全部文字');
// 一次性准备好纹理、几何体、离屏画布……
window.render = t => { /* 只根据 t 画这一帧 */ };
window.READY = true;   // 全部准备好后才设
</script></body></html>
```

- **画面只由 t 决定**：t 是这一镜内的秒数。示范片用整片时间轴，要换算成镜内时间。
- **尺寸**：用 `SLATE.width`、`SLATE.height`，横屏、竖屏都要排得开。示范片里写死的 1920×1080 要改掉。
- **就绪信号**：初始化里可以 `await`，全部准备好后再设 `window.READY = true`。渲染器最多等 90 秒。
- **字幕**：运行时会按配音把字幕显示在 `SLATE.captionZone`，画布里不要再画字幕。示范片里 `subs`、`SUBS`、`TEXTS`、`EV` 这类字幕和音效事件的代码都不用。
- **随机数**：`render(t)` 里只用 `mulberry(种子)` 或 `SLATE.rng(种子)`。`Math.random` 已换成固定种子的版本，three.js 内部可以用；但如果在 `render(t)` 里调用，`slate-qa` 会报出来。
- **网络**：页面不能访问外网，只能加载 `/core/`、`/node_modules/three/`、`/assets/`、`/skills/`、`/input/` 和本镜目录里的文件。

## 3. 公共库（`/core/`）

- **`/core/lib.js`**：`clamp`、`lerp`、`seg`、`ss`、`eio`/`eo`/`ei`、`back`、`spring`、`mulberry`（确定性随机）、`hash`、`vnoise`、`monotone`、`track`（关键帧插值）等。用之前先 `cat /opt/slate/film-core/lib.js` 看完整的函数表。
- **`/core/three/post.js`**：three.js 后期，包括超采样、环境光遮蔽、景深、辉光、调色、暗角。入口是 `makePost(renderer, scene, camera, w, h, opts)`。
- **`/core/post/crt.js`**：CRT 和录像带后期（WebGL2）。
- **`/core/assets/polyhaven/`**：CC0 素材，包括 HDR 环境贴图（`lythwood_lounge_2k.hdr`、`photo_studio_loft_hall_2k.hdr`）、胡桃木纹理、台灯和茶具的 glTF 模型。
- **`/core/fonts/fonts.css`**：几款拉丁展示字体，另有一款只有约 200 个字的中文展示字体。中文正文不要用它。

## 4. 字体

- **在哪里**：风格说明点名的字体大多在 `/assets/fonts/lib/`。完整清单和 CSS 路径见 `/opt/slate/assets/fonts/lib/FONTS.md`，用法是引用 `<link rel="stylesheet" href="/assets/fonts/lib/<名字>.css">`。
- **中文**：
  - 标题可以用 Noto Serif SC（宋体）、Ma Shan Zheng（毛笔楷书）、Long Cang（手写）、ZCOOL KuaiLe（快乐体）、Zhi Mang Xing（行书）；
  - 日文有 Noto Sans JP、Shippori Mincho、Yuji Syuku、Dela Gothic One；
  - 正文用系统自带的 `"Noto Sans CJK SC"`。
- **加载**：字体按字符范围切片。画布里用之前，必须先 `document.fonts.load('<字重> <字号> <字体>', '<要写的文字>')`，再设 READY。DOM 里的文字会自动加载。
- **找不到点名的字体时**：从清单里挑气质最接近的，不要从网上下载。

## 5. 3D 和 WebGL

- **哪些风格要 WebGL**：21 个，`STYLES.md` 里标了出来。
- **速度**：渲染浏览器用 CPU 软件渲染 WebGL，比 2D 慢得多。实测 1080p 下：
  - 几十个普通材质物体加阴影，一帧约 0.7 秒；
  - 玻璃这类透射材质，再加景深和辉光后期，一帧约 13 秒，一个 5 秒的镜头要渲染 2～3 分钟。
- **分片**：`slate-render` 会自动多开分片，结果里的 `frame_s` 是每帧秒数。
- **超过 3 秒一帧就该降低复杂度**：
  - 几何体数量和面数尽量少；
  - 阴影贴图不超过 2048；
  - 后期 pass 不超过 3 个；
  - 超采样不超过 1.5 倍；
  - 透射材质只用在主角上，背景用普通材质加环境贴图。
- **引用方式**：three.js 用 importmap 引用，版本是 0.170.0，扩展在 `three/addons/` 下。
- **资源**：模型、贴图、HDR 都要在初始化时加载完，再设 READY。

## 6. 不能做的

- 不加任何片尾署名、水印或 "Made with" 字样。
- 不照搬示范片的故事、角色、片名和镜头。示范片里出现的第三方产品界面、吉祥物和品牌，用户的片子里都不要用。
- 不模仿真实艺术家的具体作品，不用真实品牌的 Logo（用户上传的除外）。

<!-- 版本标识：slate-skill-5c1f0e7a93 -->
