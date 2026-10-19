---
name: whiteboard
description: 白板手绘讲解风格。马克笔线条按笔画顺序画出来，节奏平稳，每镜只讲一个要点；适合讲流程、因果关系和原理。
---

# 白板手绘讲解

## 画面

- 底色 `#FBFAF7`（白板），主线条用马克笔蓝 `#1F3A93`，文字用墨色 `#2B2B2B`；强调色只用红色 `#D64545`，**一镜最多一处**。
- 线条带一点手绘抖动，粗细约为短边的 0.5%，圆头圆角。
- 每镜不超过 5 个主要元素，留白要多。标题放在左上角；正文图形**以画面中心为基准横向排开或居中**，整体宽度约占画面的 60%～80%，主要图形高度约占画面的 30%～45%，不要缩在一角。

## 动画

- 线条和形状按笔画顺序"画出来"（`WB.*().draw(p)`），不要整块淡入。
- 文字用打字机效果或从下方轻轻浮入，一次只出现一组。
- 元素的出现时间要跟着旁白里提到它的时刻（看 `SLATE.captions`）。
- 转场：每镜开头 0.4 秒内从空白开始画；不用缩放转场。

## 节奏

- 每镜 6～12 秒；画完后至少停留 1 秒，让观众看清。

## 用法

```html
<link rel="stylesheet" href="/skills/whiteboard/style.css">
<script src="/skills/whiteboard/components.js"></script>
```

- 页面主体放一个铺满的 `<svg class="wb-canvas">`。在脚本里先用 `WB.*` 创建元素，然后在 `render(t)` 里调用它们的 `draw(p)`，其中 `p` 是 0～1 的进度。
- 组件列表：
  - `WB.box`：手绘方框，可带标签；
  - `WB.arrow`：手绘箭头；
  - `WB.bubble`：对话气泡；
  - `WB.icon`：图标，可选 doc、docs、search、db、user、bulb、check、cross、gear、cloud、chip、chart；
  - `WB.text`：文字；
  - `WB.circle`：圈出重点（红色）；
  - `WB.underline`：下划线；
  - `WB.cross`：打叉。
- 参数和完整示例见 `components.js` 文件头注释和 `example/index.html`。

<!-- 版本标识：slate-skill-e5a5a78210 -->
