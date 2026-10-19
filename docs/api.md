# Slate API 契约（前端 ↔ 后端）

- 前端和 API 同源：CloudFront 把 `/api/*` 转发给 API Gateway，其余路径返回前端静态页。本地开发时用 `config.json` 里的 `apiBase`。
- 鉴权：请求头 `Authorization: <Cognito idToken>`。token 过期返回 401，前端用 refreshToken 刷新后重试一次。
- 错误统一格式：HTTP 4xx/5xx，响应体 `{"error": "code", "message": "给用户看的中文说明"}`。

## 配置 `GET /config.json`（静态文件，部署时生成）

```json
{"apiBase": "/api", "region": "us-east-1", "userPoolId": "us-east-1_xxx", "clientId": "xxxx"}
```

## 登录（浏览器直接调用 Cognito，不经过 API）

- 用 `fetch` 直接 POST 到 `https://cognito-idp.<region>.amazonaws.com/`，请求头：
  - `Content-Type: application/x-amz-json-1.1`
  - `X-Amz-Target: AWSCognitoIdentityProviderService.<操作名>`
- 登录：`InitiateAuth`，参数 `{"AuthFlow": "USER_PASSWORD_AUTH", "ClientId", "AuthParameters": {"USERNAME": email, "PASSWORD": pw}}`，返回 `AuthenticationResult.{IdToken, AccessToken, RefreshToken, ExpiresIn}`。
- 管理员建的账号首次登录会返回 `ChallengeName: "NEW_PASSWORD_REQUIRED"`。这时让用户设置新密码，再调用 `RespondToAuthChallenge`，参数 `{"ChallengeName": "NEW_PASSWORD_REQUIRED", "ClientId", "Session", "ChallengeResponses": {"USERNAME": email, "NEW_PASSWORD": 新密码}}`。
- 刷新：`InitiateAuth`，`AuthFlow: "REFRESH_TOKEN_AUTH"`，`AuthParameters: {"REFRESH_TOKEN": …}`。
- 退出：清掉本地 token。

## `GET /api/me`

```json
{"email": "a@b.com", "sub": "…", "quota": {"running": 1, "runningLimit": 3, "today": 4, "dailyLimit": 30},
 "credits": {"month": "2026-10", "used": 12.5, "quota": 1000, "remaining": 987.5, "warn": null, "custom": false}}
```

- `credits` 是本月 Credit 用量和额度，`warn` 是 `null`、`"80"` 或 `"100"`。

## `POST /api/uploads`：上传前先申请

请求：`{"filename": "白皮书.pdf", "contentType": "application/pdf", "size": 12345, "purpose": "ref"}`

- `purpose` 是 `"ref"`（参考资料，默认）或 `"image"`（3D 图片任务的参考照片）：
  - `ref`：只接受 pdf、docx、md、txt、csv、xlsx，每个不超过 1 MB；
  - `image`：只接受 png、jpg、jpeg、webp，每张不超过 10 MB。
- 不符合时返回 400，`message` 是中文说明。

响应：`{"uploadId": "u-…", "url": "https://<S3 预签名 PUT>", "headers": {"Content-Type": "…"}}`

前端用 `PUT url` 上传文件本体，带上响应里给出的 headers。成功后，在创建任务时引用 `uploadId`。

## `POST /api/tasks`：创建并开始生成

```json
{
  "mode": "quick",
  "description": "给第一次接触大模型的产品经理讲清楚 RAG，一分钟左右",
  "refs": {"web": true, "strict": false, "items": [
    {"kind": "file", "uploadId": "u-…", "name": "白皮书.pdf", "note": "重点看第三节"},
    {"kind": "text", "title": "术语表", "text": "……", "note": ""},
    {"kind": "link", "url": "https://…", "note": "博客"}]},
  "options": {
    "skills":  {"enabled": false, "ids": []},
    "spec":    {"enabled": false, "ratio": "16:9", "duration": 60, "resolution": "1080p", "fps": 30,
                "voice": true, "voice_id": "Zhiyu", "subtitles": true, "bgm": false},
    "confirm_storyboard": false
  }
}
```

- 快速模式只需要 `mode`、`description` 和 `refs`，`options` 可以省略。
- `refs` 两种模式都可以带（设计见 `docs/references-design.md`）：
  - `web` 是联网搜索开关；`strict` 是强制引用，开了以后片子里的事实、数字和术语只能来自资料；
  - `items` 合计最多 10 份，其中链接最多 5 个，粘贴的文字每段不超过 2 万字；
  - 老前端传的顶层 `web_search` 还接受，以 `refs.web` 为准；
  - `options.script`（讲解稿）和 `options.assets`（素材：图片、Logo、风格参考网站）都已下线，传了也忽略。
- 勾了某项（`enabled: true`）却没填内容时，返回 400，`message` 写明是哪一项。
- `duration` 的取值是 15、30、60、90、180；`ratio` 是 16:9、9:16、1:1、4:5；`resolution` 是 720p 或 1080p；`fps` 是 30 或 60。

响应：`201 {"id": "<taskId>"}`。超出额度时返回 429，并在 `message` 里说明。

### 3D 图片任务和素材库引用

- 3D 图片：`{"product": "model3d", "description": "…", "images": ["u-…"], "web_search": true}`，`images` 是 0～4 张同一物体不同角度的照片（上传时 `purpose: "image"`），`web_search` 默认开：有具体型号时 Agent 联网查尺寸、配色和材质。
- 视频任务可以多带两样东西，都来自素材库：
  - `models`：最多 3 个已完成的 3D 任务号。系统把模型文件和素材卡放进任务的 `input/models/m01/` 等目录。
  - `refs.items` 里的 `{"kind": "library", "fileId": "f-…"}`：素材库里的文件，算一份参考资料。
  - `images`：视频里用的普通图片，最多 8 张，每张都要写描述（1～200 字）。上传的写 `{"kind": "file", "uploadId", "name", "desc"}`（先用 `purpose: "image"` 申请上传，png、jpg、webp，不超过 10 MB），素材库的写 `{"kind": "library", "fileId", "desc"}`。按顺序编号 i01、i02……；上传的图片带着描述进素材库。任务详情的 `request.images` 是 `[{id, name, desc, fileId, url(缩略图), error}]`，分镜每镜的 `images` 对得上这些编号。见 `docs/image-refs-design.md`。
- 详细格式见 `docs/library-3d-design.md` 第五节。

## `GET /api/tasks?status=all|active|done|failed`

```json
{"items": [{"id": "…", "title": "RAG 是怎么工作的", "description": "…用户描述的前 60 字…", "kind": "原理讲解",
            "spec": "16:9，60 秒", "status": "running", "statusText": "渲染中 3/6 镜", "thumb": "editorial",
            "versions": 0, "failure": null, "updatedAt": 1791800000000}]}
```

- `status` 取值：`queued`、`running`、`awaiting_confirmation`、`completed`、`failed`。
- 筛选规则：active 对应 queued、running 和 awaiting_confirmation，done 对应 completed，failed 对应 failed。
- `thumb` 是这个任务用的第一个风格 Skill 的 id，前端拿它选缩略图；还没定风格时为 null。

## `GET /api/tasks/{id}`：生成页轮询（生成中每 2 秒一次）

```json
{
  "id": "…", "title": "RAG 是怎么工作的", "status": "running", "statusText": "渲染中 3/6 镜",
  "mode": "quick", "createdAt": 1791800000000, "updatedAt": 1791800050000, "elapsed": 312,
  "request": {"description": "…", "web_search": true, "options": {…},
              "refs": {"web": true, "strict": false, "items": [{"id": "r01", "kind": "file", "name": "白皮书.pdf", "note": "…", "chars": 8200, "error": null}]}},
  "steps": [
    {"name": "research", "label": "资料整理", "state": "done", "note": "读完 2 份资料，选定坐姿提醒为主卖点", "startedAt": 0, "endedAt": 0},
    {"name": "analyze", "label": "分析需求", "state": "done", "note": "…"},
    {"name": "script", "label": "写剧本", "state": "done", "note": ""},
    {"name": "storyboard", "label": "写分镜", "state": "done", "note": ""},
    {"name": "code", "label": "写动画代码", "state": "done", "note": ""},
    {"name": "render", "label": "渲染画面", "state": "running", "note": "第 4 镜渲染中"},
    {"name": "compose", "label": "合成配音和字幕", "state": "pending", "note": ""}
  ],
  "brief": {"title": "…", "kind": "原理讲解", "audience": "…", "ratio": "16:9", "duration": 60, "resolution": "1080p", "fps": 30,
            "skills": [{"id": "editorial", "name": "编辑图解"}], "voice": "温和女声（Zhiyu）", "subtitles": true, "bgm": "calm",
            "decided": ["kind", "skills"]},
  "sources": {"queries": ["…"], "sources": [{"title": "…", "url": "…", "note": "…", "used": true}]},
  "notes": {"angle": "…", "items": [{"id": "r01", "summary": "…", "used": true, "facts": ["…"], "terms": [{"term": "…", "meaning": "…"}], "reason": ""}]},
  "scriptCheck": {"rounds": 1, "ok": true, "strict": false, "issues": [{"kind": "contradiction", "text": "剧本原句", "ref": "r01", "suggestion": "…"}]},
  "script": {"mode": "agent", "paragraphs": ["…"]},
  "storyboard": {"title": "…", "ratio": "16:9", "scenes": [
    {"id": "01", "title": "开场提问", "narration": "…", "visual": "…", "duration": 8, "start": 0,
     "clip": {"url": "https://<预签名>", "dur": 8.0}}
  ]},
  "versions": [{"n": 1, "url": "https://<预签名>", "download": "https://<预签名，带 attachment>", "dur": 61.2, "createdAt": 1791800099000}],
  "messages": [{"id": "…", "role": "user", "kind": "text", "text": "第 1 镜的问题字太小了", "scope": "01", "at": 1791800000000},
               {"id": "…", "role": "agent", "kind": "plan", "text": "第 1 镜：问题文字放大到 44px", "at": 1791800001000}],
  "canMessage": true, "canConfirm": false, "canRetry": false,
  "failure": null
}
```

- `step.state` 取值：`pending`、`running`、`done`、`skipped`、`failed`。
- `brief`、`sources`、`notes`、`scriptCheck`、`script`、`storyboard` 在 Agent 发布之前都是 null；没有参考资料的任务，`notes` 和 `scriptCheck` 一直是 null。
- `request.refs.items[].chars` 是抽出的字数；文件解析失败或链接抓不到时有 `error`。
- `scriptCheck.issues[].kind`：`contradiction`（和资料矛盾）、`unsupported`（资料里找不到依据）、`term`（术语用错）。关强制引用时只拦第一种；最多拦两轮，没解决的问题留在这里给用户看。
- `clip` 是 null，表示这一镜还没渲染。
- `failure` 的格式：`{"message": "第 5 镜渲染超时：粒子数量太多", "at": …}`，`canRetry` 为 true 时显示"让 Agent 修复后重试"。
- `message.role`：`user` 或 `agent`。`kind` 取值：`text`、`plan`（改动计划卡片）、`info`、`system`（系统提示，比如"已切换备用模型继续"）。
- 预签名链接 1 小时内有效，每次轮询都会重新生成。

### 3D 图片任务的详情

- `product` 为 `"model3d"`，步骤是看图分析、建模规格、建模、比对修正、导出。
- `model.asset` 是素材卡，`model.versions` 是各版成品：多角度图、转台视频、对比图、GLB 下载链接。
- `GET /api/tasks/{id}/module?v=<版本号>` 返回 `{"code", "factory"}`，是模型的 JS 源码，给前端的 3D 预览用。
- 格式见 `docs/library-3d-design.md` 第五节。

## 素材库

- `GET /api/library?kind=video|model3d|image|file&q=<搜索词>`：列出自己的视频、3D 图片、图片或文件。图片条目多 `desc`（描述）和 `url`。
- `PATCH /api/library/{kind}/{id}`：改名称和标签，请求体 `{"name"?, "tags"?}`；图片还能改描述 `"desc"`（不能改空）。
- `DELETE /api/library/{kind}/{id}`：视频和 3D 图片只是从素材库移除，任务还在；文件和图片会删除。
- 视频只用来保存历史，新建视频时不能引用。条目格式见 `docs/library-3d-design.md` 第五节。

## `POST /api/tasks/{id}/confirm`

请求：`{"storyboard": {…用户改过的分镜，可选…}}`，响应 `{"ok": true}`。只有 `awaiting_confirmation` 状态下可以调用。

## `POST /api/tasks/{id}/messages`

请求：`{"text": "节奏快一点", "scope": "all"}`，其中 `scope` 是 `"all"` 或镜头 id（如 `"03"`）。

响应 `{"ok": true}`。生成中（`running`）调用会返回 409，`message` 是"Agent 正在工作，等这一轮完成后再发"。

## 工作流模式（`docs/workflow-mode-design.md`）

**画板和我的工作流**：记录是 `kind: "canvas"`（画板，第一次运行节点时创建，之后前端有改动就自动保存，节点上带着任务编号）或 `kind: "template"`（我的工作流，只有节点、连线和设置，不带任务）。

- `GET /api/flows`：`{"items": [{id, kind, name, createdAt, updatedAt, doc}]}`，按更新时间倒序。列表里的 `doc` 是精简的（节点类型、位置、几个主要设置）。
- `POST /api/flows`：`{"kind", "name", "doc": {"nodes": [{k, type: "text"|"image"|"av", x, y, cfg, task?}], "edges": [[from, to, "text"|"img"]]}}` → `{"id", "updatedAt"}`。文字、音画节点各最多 1 个，图片最多 3 个；连错的线会被丢掉；整体不超过 60 KB。画板最多留 100 个，超出时删掉最久没动的（任务不受影响）。
- `GET /api/flows/{id}`、`PATCH /api/flows/{id}`（`{"name"?, "doc"?}`）、`DELETE /api/flows/{id}`。

**节点运行**：

- 文字节点：`POST /api/tasks`，带上 `"flow": "<画板编号>"`，`mode` 必须是 `advanced`、规格必须打开。服务端强制 `confirm_storyboard: true`，时长超过 3 分钟返回 400 `flow_long`。
- 图片节点：`POST /api/tasks`，`product: "model3d"`，也带上 `flow`。
- 音画节点：`POST /api/tasks/{id}/av`，请求 `{"skills": {"ids": [主风格, 插入风格?]}, "spec": {ratio, resolution, fps, voice_id, subtitles, bgm}, "models": [3D 任务编号], "storyboard"?, "note"?}`，响应 `{"ok": true, "changes": [给 Agent 的改动清单]}`。
  - 还没出片时就是确认分镜（任务要在 `awaiting_confirmation`）；
  - 出片以后是"重跑"：和任务记录比，风格、规格、3D 图片有变化就写进任务，再加上分镜在最新一版成片之后改过的镜头，交给 Agent 只重做变了的镜头。什么都没变、也没有 `note` 时返回 400 `nothing_to_do`。
- 节点对话：`POST /api/tasks/{id}/messages` 多一个 `"node": "text" | "av"`。`text` 只改剧本和分镜（可以带 `storyboard`：分镜表里直接改过的分镜），不配音、不渲染；`av` 是平常的修改，要先出片。不传时，出片前算文字节点、出片后算音画节点。

**任务详情里多的字段**（只有工作流建的任务有）：`flow: {id, node, changed, removed}`。`node` 是这一轮（或最近一轮）属于哪个节点；`changed`、`removed` 是分镜在最新一版成片之后改过、去掉的镜头号。每条消息多一个 `node`。

## `POST /api/tasks/{id}/retry`

响应 `{"ok": true}`。只有 `failed` 状态下可以调用。

## `GET /api/skills`

```json
{"items": [{"id": "editorial", "name": "编辑图解", "cat": "原理讲解", "ver": "1.0", "summary": "…一句话…",
            "highlights": ["马克笔线条按笔画顺序画出来", "…"], "applies": ["原理讲解", "产品演示"], "ratio": null}]}
```

- 分类 `cat` 有：原理讲解、广告宣传、数据可视化、竖屏社媒。
- 详情抽屉只展示 `summary`、`highlights` 和效果预览（前端内置的示意图，按 id 选择），不展示 SKILL.md 原文。

## Credit 用量

任务列表每项加 `credits`；任务详情加 `billing: {credits, pending, turns}`；明细 `GET /api/tasks/{id}/usage`（`?format=csv` 导出）；用量页 `GET /api/usage?from=&to=`。
额度用完时，新建、确认、修改、重试返回 HTTP 402 `{"error": "quota_exceeded", "message": "本月额度已用完，下月 1 日恢复"}`。
字段和管理端接口见 [credit-design.md](credit-design.md) 第 9 节。

## 写法

- `GET /api/skills` 返回 `{"items": [风格…], "genres": [{"id": "science", "name": "知识科普", "group": "讲解", "summary": "…", "example": "…", "styles": ["film-iso-infographic", …]}]}`。`styles` 是常搭配的风格，第一个是没选风格时的默认风格。风格不再带 `applies`。
- `POST /api/tasks` 请求体顶层可以带 `"genre": "<写法 id>"`，快速模式和高级模式都可以；不传或 null 表示交给 Agent。不认识的 id 返回 400 `bad_genre`。
- `GET /api/tasks/{id}` 的 `request.genre` 是 `{"id", "name"}` 或 null。`brief.kind` 是写法的中文名；用户指定了写法时，`brief.decided` 里不会有 `kind`。

## 视频链接

任务详情里的 `storyboard.scenes[].clip.url`、`versions[].url` 和 `versions[].download` 是视频 CDN 的签名链接，有效期 1～2 小时。同一小时内，同一个视频的链接不变。下载链接多带一个 `dl=<文件名>` 参数，CDN 返回时会加上 `Content-Disposition`。没部署视频 CDN 时，后端退回 S3 预签名链接。
