# MiniMax 中国区语音合成调研（2026-10-13）

来源：MiniMax 开放平台中国区文档（platform.minimax.cn），查阅日期 2026-10-13。价格以官网为准。

## 能力

- **接口**：`POST https://api.minimax.cn/v1/t2a_v2`，用 Bearer API Key 鉴权。
  - 一次最多 1 万个字符，可以流式返回。
  - 另有异步长文本接口，单个文件 10 万字符以内。
- **模型**：
  - `speech-2.8-hd` / `speech-2.8-turbo`：最新，支持语气词标签；
  - `speech-2.6-*`、`speech-02-*`：旧版。
- **语气词标签**（只有 2.8 支持）：在文本里插入即可，例如：
  - 笑：`(laughs)`、`(chuckle)`；
  - 叹气、喘气：`(sighs)`、`(breath)`、`(gasps)`；
  - 其他：`(clear-throat)`、`(emm)`、`(humming)` 等。
- **情绪**：`emotion` 可选 happy、sad、angry、fearful、disgusted、surprised、calm、fluent（2.8 不支持 whisper）。不填时模型自己判断。
- **调节**：
  - 语速 0.5～2，音高 -12～12；
  - 变声效果有空旷回声、礼堂回声、电话音、机器人；
  - 最多 4 个音色按比例混合。
- **停顿和读音**：
  - `<#0.5#>` 插入 0.5 秒停顿；
  - `处理/(chu3)(li3)` 指定多音字读音，粤语可以用粤拼。
- **时间戳**：`subtitle_enable=true`，`subtitle_type=word` 时返回逐字时间（毫秒），可以直接替代现在 Polly 的逐字时间轴。
- **AI 标识**：`aigc_watermark=true` 会在音频末尾加一段节奏提示，可以用来满足国内对合成音频的标识要求。

## 音色

系统音色中文共 64 个：普通话 58 个，粤语 6 个。

| 类别 | 音色（voice_id） |
|---|---|
| 趣味、角色 | 搞笑大爷 `Chinese (Mandarin)_Humorous_Elder`、热心大婶 `…_Kind-hearted_Antie`、花甲奶奶 `…_Kind-hearted_Elder`、嚣张小姐 `Arrogant_Miss`、机械战甲 `Robot_Armor`、嘴硬竹马 `…_Stubborn_Friend`、霸道少爷 `badao_shaoye`、病娇弟弟 `bingjiao_didi`、俏皮萌妹 `qiaopi_mengmei`、嗲嗲学妹 `diadia_xuemei` |
| 萌娃、卡通 | 聪明男童 `clever_boy`、可爱男童 `cute_boy`、萌萌女童 `lovely_girl`、卡通猪小琪 `cartoon_pig`、憨憨萌兽 `…_Cute_Spirit` |
| 播音、主播 | 新闻女声 `…_News_Anchor`、播报男声 `…_Male_Announcer`、电台男主播 `…_Radio_Host`、沉稳高管 `…_Reliable_Executive` |
| 口音 | 港普空姐 `…_HK_Flight_Attendant`、南方小哥 `…_Southern_Young_Man` |
| 粤语 | 专业女主持、专业男主持、温柔女声、活泼男声、可爱女孩、善良女声（需要 `language_boost: "Chinese,Yue"`） |
| 其他 | 青涩青年、精英青年、霸道青年、少女、御姐、成熟女性、甜美女性、温润男声、温暖闺蜜、清脆少女等 |

- `…` 是 `Chinese (Mandarin)` 的缩写。
- **方言**：只有粤语是原生支持的。东北话、四川话、上海话、河南话等**没有系统音色**，可能的办法有两个，都需要实测：
  - **音色复刻**：上传 10 秒到 5 分钟的方言说话人录音，复刻出音色。能保留多少口音，文档没有说。录音需要说话人授权。
  - **音色设计**：用一段文字描述生成音色，例如"东北口音的中年大叔，说话幽默"。文档的示例里没有提到口音或方言。

## 价格（按量计费）

| 项目 | 价格 |
|---|---|
| speech-2.8-hd / 2.6-hd | 3.5 元 / 万字符 |
| speech-2.8-turbo / 2.6-turbo | 2.0 元 / 万字符 |
| 音色复刻、音色设计 | 每个音色 9.9 元，第一次用来合成时才扣费；复刻的音色 7 天内不用会被删除 |

- **计费口径**：1 个汉字算 2 个字符。
- **折算到片子**：用 HD 模型时，1000 个汉字约 0.7 元。一支 72 秒的片子旁白约 300 字，配音不到 0.3 元。
- **资源包**：比如 HD 套餐一 630 元/月，含 200 万字符，适合量大以后再买。
- **免费额度**：文档里没有提到。

## 开通门槛

- 要在中国区开放平台注册账号。
  - 用复刻功能前，必须完成个人实名认证或企业认证。
  - 在线充值只支持微信；对公转账只支持企业。
- 文档没有说明海外主体能不能用、能不能转售给自己的用户，这两点需要问 MiniMax 商务。
- **API Key 不能暴露在客户端**：放在我们的服务端（Lambda），不能放进 Agent 的沙箱。

## 已上线（2026-10-13）

- **密钥**：API Key 存在 Secrets Manager（`<栈名>/minimax-api-key`）。
  - CDK 只建 Secret，模板里是占位值；真实的值由 `./deploy.sh secret minimax` 写入，或在部署时设环境变量 `MINIMAX_API_KEY`。
  - 只有 `Slate-voice` Lambda 能读它，Agent 的沙箱读不到。
  - 更换 Key：重新运行 `./deploy.sh secret minimax`，Lambda 冷启动后生效。
- **合成**：`slate-voice` 通过 `Slate-voice` Lambda 调 `speech-2.8-hd`，取逐字时间戳生成字幕。
  - 字幕里会自动去掉语气词标记和停顿标记；
  - 调用失败时退回 Polly 的 Zhiyu。
- **音色目录**：`agent/voices.json`，23 个音色，按讲解风格分成 6 类：亲切聊天、正式播报、故事电台、搞笑吐槽、萌趣卡通、粤语港风。
  - 镜像里在 `/opt/slate/voices.json`；
  - 接口 `GET /api/voices` 返回目录；
  - 任务规格里的 `voice_id` 填目录 id，或 `auto` 由 Agent 挑选。
- **试听**：每个音色读同一句"大家好，今天由我来给你讲一个有趣的小知识。"，存成 `web/voices/<id>.mp3`，随前端发布，试听时不调用 MiniMax。
  - 用 `scripts/build_voice_previews.py` 生成；新增音色后再运行一次，已有的会跳过。
- **方言**：需求方确认要的是讲解风格，不一定是方言。粤语作为一种风格保留，东北话、四川话等不做。
