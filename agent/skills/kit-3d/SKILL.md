---
name: kit-3d
description: 3D 素材套件。镜头里用到素材库的 3D 图片（程序化 three.js 模型）时用：按时间拆开或合上（拆解动画）、按当前风格换画法（写实、素模、卡通、线稿）、零件引线标注。
---

# 3D 素材套件

视频镜头里用 3D 图片时，按这里的方式拆解、换画法、加标注。建模手册导出拆解动图和拆解图时也用这套代码，所以视频里的拆解和成品页上的一致。

## 引用

```html
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { explodeAt, explodeSteps, explodedBox, stepAt, stepNodes } from '/skills/kit-3d/explode.js';
import { applyLook } from '/skills/kit-3d/looks.js';
import { screenPoints, callouts } from '/skills/kit-3d/labels.js';
import { createXxxModel } from '../_shared/m01.js';
const model = createXxxModel();
</script>
```

## 拆解：`explode.js`

模型的拆解数据在 `model.userData.sculptRuntime.explode.steps` 里，每一步是一组零件和它们的位移（素材卡 `explode.steps` 里有每一步的名称和零件）。

- `explodeAt(model, t)`：t = 0 组装好，t = 步数时全部拆开；第 i 步在 t 从 i 到 i+1 之间完成，缓入缓出。**在 `render(t)` 里按时间算 t**（比如 `explodeAt(model, SLATE.seg(t, 2, 8) * explodeSteps(model).length)`），不要每帧累加。
- `stepAt(model, t)`：正在拆的是第几步，配合旁白和字幕。
- `stepNodes(model, i)`：第 i 步的零件节点，用来高亮或推近。
- `explodedBox(model)`：全部拆开时的包围盒，镜头取景要按它来，否则拆开后会出画。

讲结构的片子一般这样拍：先完整亮相 → 跟着旁白一步一步拆（每步 1～2 秒，讲到哪个零件高亮哪个）→ 全部拆开停住、加标注 → 合上收尾。

## 换画法：`looks.js`

`applyLook(model, look, opts)`，按主风格选：

| look | 效果 | 适合的风格 |
|---|---|---|
| `pbr` | 原样，写实材质 | 玻璃质感产品、暗色科技发布、积木、低多边形、移轴微缩 |
| `line` | 线稿加平涂：轮廓线和折边，平涂色映射到调色板 | 机械图解、蓝图 / 工程制图、等距信息图、瑞士排版 |
| `toon` | 卡通着色加描边 | 80 年代赛璐璐、50s 扁平卡通、科幻情景喜剧、综艺节奏扁平、象形运动图形 |
| `clay` | 统一哑光颜色的素模 | 讲结构和比例、做剪影；手绘、版画类风格的底模 |

- `opts.palette` 传风格的几种主色，零件颜色会映射到最接近的那一种。`line` 用 `fill`、`line`、`width` 定平涂色、线色和线宽（像素）；蓝图风格背景 `#1f4e9a` 时可以 `{fill: '#2a5cad', line: '#e8f1ff'}`（平涂比背景稍亮，零件才分得出来）。`toon` 用 `outline`、`steps`。
- `toon` 只认方向光、点光和半球光（环境贴图不算），镜头里要有一盏主光；渲染器 `toneMapping` 设成 `NoToneMapping`，颜色才和调色板一致。`line` 不受灯光和色调映射影响。
- 手绘、水彩、版画、像素这类风格：先 `toon` 或 `clay`，再叠风格自己的纸纹、半调或者低分辨率放大，模型不要用写实材质。
- 再调用一次 `applyLook(model, 'pbr')` 可以恢复原样（同一支片里前写实后线稿也行）。

## 标注：`labels.js`

- `screenPoints(model, camera, ids, width, height)`：零件中心在画面上的位置（像素）。
- `callouts(svg, items, opts)`：在一层盖在画布上的 SVG 里画引线和名称，标签排在画面左右两列、互不重叠。`items` 是 `[{x, y, text}]`；`opts` 定字体、字号、颜色、`opacity`（做淡入）。每帧重画前用返回的 `g.remove()` 清掉。
- 名称用素材卡 `parts` 里的中文名。标注别挡住字幕区（画面下方 15%）。

## 注意

- 用了模型的镜头是 WebGL，渲染比 2D 慢，一镜别塞太多别的 3D 元素。
- 不要改模型文件本身；零件动作、材质、灯光都在镜头代码里做。
