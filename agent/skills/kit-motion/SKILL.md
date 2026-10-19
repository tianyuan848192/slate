---
name: kit-motion
description: 动作库。可以用在任何风格里的成熟动作：文字出场、打字、数字滚动、光标点击、手绘标注、镜头推拉、转场、收尾。场景里给元素加动作时先看这里，比自己从头写更稳、更好看。
---

# 动作库

每个动作是一个函数，把一套动作排进场景的时间线。动作只负责"怎么动"，内容和样式由场景自己决定，所以和任何风格都能搭配。

## 用法

```html
<h1 class="title">三步搞懂向量数据库</h1>
<script src="/skills/kit-motion/kit.js"></script>
<script src="/skills/kit-motion/soft-blur-in.js"></script>
<script src="/skills/kit-motion/count-up.js"></script>
<script>
  const tl = SLATE.timeline();
  KIT.motions.softBlurIn(tl, ".title", { at: 0.3 });          // at：从第几秒开始；dur：总时长（不写用默认）
  KIT.motions.countUp(tl, ".num", { at: 1.2, to: 128 });
  window.render = t => tl.at(t);
</script>
```

- 先加载 `kit.js`，再加载要用的动作文件。每个文件开头的注释写了参数。
- `SLATE.timeline()` 的用法见 `/.agents/skills/core-director/runtime.md`。动作和自己写的补间可以排在同一条时间线里。
- 动作的时间要跟着旁白走：配音时间轴在 `voice/NN.json` 的 `captions` 里，关键词出现的时刻就是动作的 `at`。
- 示范页在 `demos/<文件名>.html`。
- **配合"一拍两帧"的风格**：手绘、定格、剪纸这类影片风格的角色和画面是按每秒 12 次更新的。用它们做主风格时，动作也要跟着顿挫，在 render 里把时间取整到 1/12 秒再交给时间线：`window.render = t => { tl.at(Math.floor(t * 12) / 12); …风格自己的绘制… }`。平滑的动作放进这类画面里会显得像两种动画叠在一起。

## 清单

<!-- 清单开始 -->
| 函数 | 文件 | 名称 | 适合 | 默认时长 |
|---|---|---|---|---|
| `KIT.motions.countUp` | `count-up.js` | 数字滚动计数 | 展示统计数据、增长率、金额、倒计时等关键数字，需要克制可信的“数据落定”感时 | 3 秒 |
| `KIT.motions.ctaLockup` | `cta-lockup.js` | 行动号召收尾 | 产品片、发布视频、讲解片的结尾，需要一个清楚的最终行动号召（标题 + 按钮 + 小字）并稳稳停住 | 4 秒 |
| `KIT.motions.cursorAnnotate` | `cursor-annotate.js` | 马克笔圈注 | 讲解图表、界面或卡片时，需要像手写批注一样突出某个数字、柱子或区域 | 2.95 秒 |
| `KIT.motions.directionalWipe` | `directional-wipe.js` | 方向擦除转场 | 两块叠放的画面或卡片之间的转场，比如前后对比、换章节、换镜头 | 0.9 秒 |
| `KIT.motions.headlineSlam` | `headline-slam.js` | 标题重砸 | 开场主标题、口号、需要重量感和冲击感的一句话，进场后停留再干脆退场 | 3.5 秒 |
| `KIT.motions.hwArrow` | `hw-arrow.js` | 手绘箭头 | 需要用手绘批注的感觉指向某个标题、卡片、数字或画面局部，提示观众“看这里”时 | 4 秒 |
| `KIT.motions.hwCalloutCircle` | `hw-callout-circle.js` | 手绘圈注标注 | 讲解画面里需要手绘风格地圈出某个元素（数字、卡片、图片局部），并配一句手写批注时使用 | 2.03 秒 |
| `KIT.motions.irisReveal` | `iris-reveal.js` | 圆形光圈揭示 | 前后对比、改版前后、夜转昼这类两种状态的切换；也可以当整屏转场，用圆形揭开后一个画面 | 1.45 秒 |
| `KIT.motions.kineticTypeSwap` | `kinetic-type-swap.js` | 句中换词滚动 | 口号、标语里要依次换几个关键词（更快→更清楚→更动人），又不想整句重新排版的时候 | 4 秒 |
| `KIT.motions.logoSting` | `logo-sting.js` | 标志重击定格 | 品牌标志、片头或片尾定版，需要一下有力的"落地"冲击感，随后稳稳停住 | 0.95 秒 |
| `KIT.motions.markerHighlight` | `marker-highlight.js` | 马克笔强调 | 标题或金句里需要把某个词突出出来的时候，比如结论、口号、关键数字 | 3.5 秒 |
| `KIT.motions.mkUsageArc` | `mk-usage-arc.js` | 细线环形仪表 | 展示单个占比或进度类数据（使用率、完成度、增长占比），适合简洁、偏数据可视化的画面 | 3.35 秒 |
| `KIT.motions.numberWheel` | `number-wheel.js` | 数字滚轮 | 展示一个关键数字（用户数、金额、比分、星标数），想要机械计数器一位位滚到位的效果时 | 1.44 秒 |
| `KIT.motions.oversizedCursor` | `oversized-cursor.js` | 巨型光标点击 | 界面演示开场、需要一个“点这里”的因果点击来触发后续变化，或给静态界面画面加一点视线引导 | 2.6 秒 |
| `KIT.motions.parallaxZoom` | `parallax-zoom.js` | 视差放大转场 | 从一组卡片或图块网格转场到某一张卡片的主题画面，适合作为开场或章节过渡 | 6 秒 |
| `KIT.motions.perWordRise` | `per-word-rise.js` | 逐词上浮 | 标题、口号、关键句入场，想要克制、干净、有节奏感的逐词或逐字揭示时使用；也可以选择淡出或上浮退场 | 1.45 秒 |
| `KIT.motions.pressRipple` | `press-ripple.js` | 按下涟漪 | 产品演示里表现"点一下按钮→确认成功"的收尾一拍，例如保存、提交、批准等控件的状态切换 | 2.4 秒 |
| `KIT.motions.pullBackReveal` | `pull-back-reveal.js` | 拉远揭示 | 先让观众盯住一个数字或细节，再拉远交代它所在的完整画面，让这个数字有了上下文 | 2.4 秒 |
| `KIT.motions.pushIn` | `push-in.js` | 镜头推进 | 需要强调某个居中标题或画面、营造“镜头慢慢推近”的专注感时；适合可长可短的停留镜头 | 4 秒 |
| `KIT.motions.radialSurround` | `radial-surround.js` | 环形包围 | 提出问题的开场，比如“团队被一堆工具淹没”：中心主体不动，被一圈标签包围、挤压 | 5 秒 |
| `KIT.motions.scrambleReveal` | `scramble-reveal.js` | 乱码解码显现 | 科技、黑客、终端、数据解码风格的标题或关键词出场；需要"破译""加载完成"感时 | 1.65 秒 |
| `KIT.motions.softBlurIn` | `soft-blur-in.js` | 柔焦上浮显现 | 标题、副标题、说明文字、数据标签、产品界面标注的入场；需要克制、带电影感的柔和显现时 | 0.8 秒 |
| `KIT.motions.staggeredFadeUp` | `staggered-fade-up.js` | 逐词浮现 | 标题、口号、金句需要一词一词地入场；也可用于一组卡片或图标依次出现 | 2.02 秒 |
| `KIT.motions.streamingText` | `streaming-text.js` | 流式吐字 | 展示 AI 助手回答、聊天气泡、模型输出等需要“边生成边显示”质感的段落文字；比打字机更自然。 | 2.2 秒 |
| `KIT.motions.strikethroughReplace` | `strikethrough-replace.js` | 划线替换 | 对比新旧说法、纠正措辞、“从A变成B”的改写强调，如价格变动、流程升级、观点修正 | 0.54 秒 |
| `KIT.motions.svgStrokeTrace` | `svg-stroke-trace.js` | SVG 描线显形 | 标志、签名、波浪线、图标这类线稿入场；想让一个图形“被画出来”时用 | 1.85 秒 |
| `KIT.motions.trackingIn` | `tracking-in.js` | 字距收拢入场 | 高级感标题、栏目标签、界面文字的克制入场；多行文字依次出现 | 1 秒 |
| `KIT.motions.typedPrompt` | `typed-prompt.js` | 提示词打字 | 产品演示里展示向 AI 输入提示词、搜索框输入、命令行输入等场景；需要真实的打字节奏、光标和打错改正的小细节时使用。 | 4 秒 |
| `KIT.motions.typewriter` | `typewriter.js` | 打字机 | 命令行、口号、标题需要一字一字敲出来的时候；浅色底、深色底都能用，光标可以是细线、方块，也可以不要 | 2.12 秒 |
| `KIT.motions.vignette` | `vignette.js` | 电影暗角 | 画面主体在中央，需要电影感、聚焦氛围或给画面"收边"时；可叠在整块场景、图片或卡片上 | 3.8 秒 |
<!-- 清单结束 -->
