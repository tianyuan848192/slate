# 发布文件的格式（slate-publish 会按这些格式校验）

## brief.json

```json
{
  "title": "RAG 是怎么工作的",
  "kind": "原理讲解",
  "audience": "第一次接触大模型应用的产品经理",
  "summary": "用公司报销制度的例子，讲清楚先检索再生成",
  "ratio": "16:9", "duration": 60, "resolution": "1080p", "fps": 30,
  "skills": ["film-iso-infographic"],
  "voice": "warm-bestie",
  "subtitles": true,
  "bgm": "calm",
  "decided": ["kind", "audience", "ratio", "duration", "skills", "voice", "bgm"]
}
```

- `kind` 写写法的中文名：知识科普、原理讲解、教程步骤、清单盘点、故事案例、数据故事、产品介绍、新品发布、功能上新、品牌故事、促销活动（见做片手册第 2 节"写法和风格"）。用户指定了写法时，照任务说明里的 `genre.name` 写。
- `decided` 列出哪些项是你决定的（用户没指定的），前端会标成"Agent 决定"。
- `bgm` 可以是 `calm`、`bright`、`tech` 或 `null`。用户没指定时由你决定，讲解片一般用 calm 或不用。

## notes.json（资料摘要，有参考资料时必须写）

```json
{
  "angle": "资料讲的是公司内部的报销制度，片子从新员工第一次报销的困惑切入",
  "items": [
    {"id": "r01", "summary": "报销制度全文：额度、流程、时限", "used": true,
     "facts": ["住宿标准：一线城市每晚 600 元", "发票要在 30 天内提交"],
     "terms": [{"term": "事前审批", "meaning": "出差前在系统里提交申请，批准后才能报销"}]},
    {"id": "r02", "summary": "去年的报销数据表", "used": false, "reason": "片子不讲统计数字"}
  ]
}
```

- `id` 和 `input/refs/index.json` 里的编号一致，每一份都要有；`used` 为 false 时写 `reason`。
- `facts` 写要用到的事实和数字，照资料的原意；`terms` 写要用到的术语和资料里的解释。

## sources.json

```json
{"queries": ["RAG 检索增强生成 原理"], "sources": [{"title": "…", "url": "https://…", "note": "用到了它对检索步骤的描述", "used": true}]}
```

## script.json

```json
{"mode": "agent", "paragraphs": ["你问 AI：公司的报销额度是多少？……", "……"]}
```

## storyboard.json

```json
{
  "title": "RAG 是怎么工作的", "ratio": "16:9", "resolution": "1080p", "fps": 30, "bgm": "calm",
  "scenes": [
    {"id": "01", "title": "开场提问", "narration": "你问 AI：公司的报销额度是多少？它答得头头是道，可惜是编的。",
     "visual": "对话气泡，AI 的回答被朱红线划掉", "duration": 8, "skill": "film-iso-infographic"}
  ]
}
```

- `duration` 先按每秒 4.5 个字估算；配音后改成 `slate-voice` 返回的 `suggested_duration`，再重新发布。
- `caption_style`（可以不写）：全片统一的字幕样式，`{"bg": "rgba(20, 20, 20, .86)", "color": "#F5F0E8", "font": "\"Noto Serif SC\", serif"}`，取主风格的配色和字体。写了以后，所有镜头的字幕都按它显示，场景里设置的字幕样式不再生效。
- 全片用到的 `skill` 最多两个：主风格和一个插入风格（见做片手册第 4 节）。
- `images`（有用户图片时写）：这一镜用到的图片编号，比如 `["i01"]`，编号见 `input/images/index.json`。每张图至少要在一镜里用到。
- `unused_images`（顶层，可以不写）：实在不合适用的图片，`[{"id": "i03", "reason": "图太糊，放大后看不清"}]`。写了的要在给用户的总结里说明。

## outline.json（长片的总纲，只在 `long_video` 为 true 时写）

```json
{
  "title": "大模型简史",
  "look": {
    "skill": "film-iso-infographic",
    "palette": "米白底 #F5F0E8，正文墨黑 #1A1A1A，强调色朱红 #E85D5D，只用来标重点",
    "fonts": "标题 Noto Serif SC 粗体，正文 Noto Sans CJK SC",
    "recurring": "每章第一镜用 scenes/_shared/chapter-card.js 的章节标题卡（KIT 写法，content 传章号和章名）；数据图统一用 kit-shots 的 data-chart 模板，配色换成全片的配色",
    "transitions": "章与章之间：上一章最后一镜整体淡出到米白，下一章标题卡从米白淡入；镜与镜之间多用推移"
  },
  "voice": "warm-bestie",
  "chapters": [
    {"id": "01", "title": "起点：会下棋的机器", "duration": 150, "summary": "从图灵测试讲到深蓝，交代全片的主线问题",
     "narration": "1950 年，图灵问了一个问题：机器能思考吗？……", "opening": "片头直接进入", "closing": "引出：下棋赢了，可机器懂语言吗？"},
    {"id": "02", "title": "……", "duration": 160, "summary": "……", "narration": "……", "opening": "接上一章的问题", "closing": "……"}
  ]
}
```

- `duration` 是这一章的计划时长（秒），20～600；各章加起来约等于全片时长。
- `narration` 每章最多 6000 字，章号从 01 开始连续编号，最多 60 章。
- `images`（有用户图片时写）：这一章要用到的图片编号。每张图都要分到某一章，各章会话按它安排进镜头。
