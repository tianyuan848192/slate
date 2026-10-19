# Credit 计费：设计稿 v3

2026-10-14。需求（第二轮沟通后）：
- **实时记账**：每次模型推理完成，就把实际消耗写进 DynamoDB；
- **对模型 token、配音和渲染计费**：渲染按渲染机（GPU 实例）实际占用的秒数计费，2026-10-15 起；会话容器、Lambda、存储这些基础服务都算赠送；
- **和用户对账**：每一笔扣费都能追到具体的模型调用，加起来正好等于账单；
- **虚拟额度**：没接支付，只限制虚拟 Credit。每人每月一个额度（比如 1000），月底自动清零；
- 默认 1 美元成本 = 1.3 Credit（2026-10-15 从 1.5 调整，已经记下的 Credit 不变；多出的部分覆盖会话容器、渲染机开机和空闲、Lambda 等基础服务），比例可调；管理员能按用户、按任务、按自定义日期查看。

## 1. 同类平台怎么做

| 平台 | 记账单位 | 做法 |
|---|---|---|
| OpenAI、Anthropic 控制台 | 每次请求 | 每个响应自带 usage（输入、缓存、输出），按价格表算出费用写进用量表；控制台的汇总有几分钟延迟 |
| OpenRouter | 每次生成 | 生成完成时按实际 token 扣余额；余额不够时，下一次请求直接拒绝 |
| LiteLLM 代理 | 每次请求一条花费记录 | 记录请求号、模型、token、花费、用户；预算挂在用户或团队上，带重置周期（如 30 天），每次请求前检查已花费是否超预算 |
| Stripe 按量计费 | 用量事件 | 每个事件带一个幂等键（重复上报只算一次），按账期汇总，期末出账单 |

通行的几条原则：
1. 以**一次请求**为最小记账单位，用量取自模型服务返回的真实数字；
2. 每条记录带**幂等键**，重复处理只算一次；
3. 记账时按当时的价格算好费用并存下来，**改价不追溯**；
4. 明细只追加不修改，**汇总用原子累加**；
5. 预算按周期重置，**请求前检查**是否超额。

## 2. 在 Slate 里怎么拿到"每次推理"的用量（已实测）

模型调用发生在 Harness 内部，Harness 只有调用前后、工具调用前后四种 hook，没有"每次模型调用后"这一种。而且调用后那个 hook 只给总的输入和输出 token，没有缓存读写的拆分，算不准钱（缓存读的价格只有原价的 1/20）。

**不用另开日志，也不用埋点代码**：Harness 本来就往我们自己的运行日志组 `/aws/bedrock-agentcore/runtimes/harness_<名字>-…` 写两种记录，量很小，不带提示词文本：

| 记录 | 内容 | 用途 |
|---|---|---|
| 每轮开始的一条应用日志 `Returning streaming response` | 实例号（`service.instance.id`）和会话号（`sessionId`） | 把实例对应到会话，会话对应到任务 |
| 每个实例每分钟一条用量指标（EMF） | `strands.event_loop` 的输入、缓存读、缓存写、输出 token，`Sum` 是这一分钟的精确合计，`Count` 是调用次数 | 记账 |

- **记账单位是"一个实例一分钟"**：这一分钟里的几次模型调用合成一条明细，token 是精确合计，钱算得准。幂等键是"实例 + 分钟"，重复读不会重复记。
- **对应到任务和轮次**：turn Lambda 每轮开始时在 `BILLSESSION#<会话>` 上追加一段"开始时间、轮次、章、模型、是否免费"。meter 按用量的时间找到所在的那一段，决定算在哪一轮、按哪个模型定价。
- **延迟约 1～2 分钟**：meter Lambda 每分钟读一次，和上次读的时间段重叠 10 分钟，防止日志晚到。
- **看图自检**：走 `Slate-llm` Lambda，每次调用直接记一条，模型返回的 usage 原样入账。
- **配音**：走 `Slate-voice` Lambda，每次合成直接记一条，按 MiniMax 返回的计费字数（`usage_characters`）算钱。

**部署前留意**：账号如果开启了 Bedrock 的模型调用日志并记录文本内容，平台每一次模型调用的完整提示词和输出（系统提示词、Skill 内容、用户的需求和上传的资料）都会进那份日志。计费不读这份日志；要不要开、谁能看，按你账号的数据政策决定。

## 3. 计费规则

- **只算模型 token 和配音**：主 Agent（Opus 5.5，被拦时的备用模型 Opus 4.8、GPT-6 Astra）、看图自检（Sonnet 5.5）、配音（MiniMax，按计费字数）。会话容器、渲染浏览器、Lambda、存储都不计费。
- **价格表**：每个模型四个单价：输入、缓存读、缓存写、输出（美元 / 百万 token），管理端可改。
  - 默认 Opus 5.5：4 / 0.2 / 5 / 20；
  - Sonnet 5.5：2 / 0.2 / 2.5 / 10；Opus 4.8、GPT-6 Astra 先按 Opus 5.5 的价格记；
  - 没登记的模型按表里最贵的价格记；
  - 配音：人民币 3.5 元 / 万字符，按 1 美元 = 7.2 元换算，都可改。
- **换算**：Credit = 美元成本 × 比例（默认 1.3）。每条记录存下当时的单价版本、美元成本和 Credit。按这个比例，每月 1000 Credit 约等于 769 美元的成本。
- **渲染**：渲染机每次渲染、自检的忙碌秒数 × 机型单价（EC2 按需价 + 7.8% 管理费：g4dn.xlarge 每小时 0.567 美元，g5.xlarge 每小时 1.084 美元）。渲染机做完往任务的 events/ 写一条用量，由 events Lambda 记账。开机和空闲不算，由比例覆盖。见 [gpu-render-design.md](gpu-render-design.md)。
- **失败任务**（建议）：
  - 平台原因的调用不收费：启动失败、拼接失败、系统 bug 导致的重跑，以及被安全策略误拦后自动换模型重做的那一轮。记账时照常记，但标成"不计费"，用户能看到这笔被免掉了；
  - 用户的修改和用户主动的重试照常收费；
  - 管理员可以手动调整。

## 4. 虚拟额度

- **月额度**：
  - 每人每月一个额度，默认 1000 Credit，管理员可以给个别用户改；
  - 按北京时间的自然月，每月 1 日零点自动重新计算，不需要定时任务；
  - 用量按月份记，到了新的月份，新月份的用量从 0 开始。
- **什么时候检查**：
  - 新建任务、确认分镜、发修改意见、重试时检查本月已用量，用完了就拒绝，提示"本月额度已用完，下月 1 日恢复"；
  - 正在跑的那一轮不打断，做完为止，所以可能超出一点。
- **超额兜底**：正在跑的任务让本月用量超过额度的 120% 时（比如长片），停掉这个用户正在跑的任务，任务标成失败并说明原因，避免一个任务无限消耗。
- **提醒**：用到 80% 和 100% 时，在前端顶部提示。

## 5. 和用户对账：每一笔都能追溯

- 任务详情里能看到这个任务的 Credit，按轮次展开（首版、每次修改、重试；长片按章），再展开到**每一次模型调用**：时间、模型、各类 token、Credit、是否计费。
- 明细加起来正好等于任务合计，任务合计加起来等于月度合计。
- 用户和管理员都能导出 CSV。

## 6. 看到什么

**用户端**：
- 页面顶部显示本月已用和剩余额度；
- 任务列表每行显示 Credit；任务详情里的 Credit 实时更新（约 1 分钟延迟），可以按轮次展开、导出；
- 新增"用量"页：本月合计、按日柱状图、按任务明细，可以选日期范围。

**管理端**：
- 用户列表加本月 Credit 和额度两列，用户详情里可以改这个用户的额度；
- 新增"用量"页：选日期范围，看全部用户的合计、按用户排行、按天趋势、按任务明细，可以导出；
- 价格表、Credit 比例、默认月额度的设置；
- 对任务做调整（退还、补扣），记进操作日志。

## 7. 数据结构（沿用任务表）

| 记录 | 键 | 内容 |
|---|---|---|
| 会话 → 任务 | `pk=BILLSESSION#<会话>`，`sk=META` | 任务、用户，和每轮一段：开始时间、轮次、章、是否免费、标签、模型（30 天后自动过期） |
| 实例 → 会话 | `pk=BILLINST#<实例>`，`sk=META` | 会话号（30 天后自动过期） |
| 调用明细 | `pk=TASK#<任务>`，`sk=CALL#<时间>#<幂等键>` | 类型（主 Agent、看图、配音、调整）、模型、四类 token 或字数、单价版本、美元成本、Credit、是否计费、轮次、章 |
| 幂等标记 | 写明细时带条件"这条不存在" | 重复处理只算一次 |
| 任务合计 | 任务记录上的 `credits`、`costUsd`；按轮次的小计 `sk=BILLTURN#<轮次>` | 原子累加 |
| 用户月合计 | `pk=USAGE#<用户>`，`sk=M#<年-月>` | 本月 Credit，检查额度只读这一条 |
| 用户日合计 | `pk=USAGE#<用户>`，`sk=D#<年-月-日>` | 用户端和管理端按日期范围查 |
| 全平台日合计 | `pk=USAGEDAY#<年-月-日>`，`sk=USER#<用户>` | 管理端按日期查所有用户 |
| 调整 | 和调用明细同一类，类型是 adjust | 正负 Credit、原因、操作人 |
| 价格和额度设置 | `CONFIG#billing` | 各模型单价、配音单价、汇率、比例、默认月额度、版本号 |
| 个别用户的额度 | `pk=USAGE#<用户>`，`sk=QUOTA` | 月额度（没有这条就用默认值） |
| 轮询进度 | `CONFIG#metering` | 读到的日志时间点 |

## 8. 实现

| 步骤 | 内容 |
|---|---|
| 1 | turn Lambda 每轮开始时在 `BILLSESSION#` 上记一段（轮次、章、模型、是否免费） |
| 2 | meter Lambda，每分钟一次：读运行日志组的两种记录 → 实例对应到会话、任务、轮次 → 按价格表算钱 → 写明细和合计（幂等） |
| 3 | `Slate-llm` 直接记看图的用量，`Slate-voice` 直接记配音字数（会话里的 slate-look、slate-voice 调用时带上任务号和章） |
| 4 | 额度检查：api Lambda 开新一轮前检查；meter 发现用户本月用量超过额度的 120% 时停掉他正在跑的任务 |
| 5 | 用户端：额度条、任务 Credit、用量页、导出 |
| 6 | 管理端：用量页、额度设置、价格表、调整 |
| 7 | 上线后用一个真实任务核对：明细加起来等于任务合计，和 `scripts/task_cost.py` 的结果对一下 |

## 9. 接口（前后端按这个对接）

数字都是 Credit，保留两位小数。用户端不显示美元成本。日期是北京时间的 `YYYY-MM-DD`，月份是 `YYYY-MM`。

### 用户端（`/api`）

| 接口 | 返回 |
|---|---|
| `GET /me` | 在原有字段上加 `credits: {month, used, quota, remaining, warn}`。warn 是 `null`、`"80"`（用到 80%）或 `"100"`（用完） |
| `GET /tasks` | 每项加 `credits` |
| `GET /tasks/{id}` | 加 `billing: {credits, pending, turns: [{turnId, label, credits, calls}]}`。pending 为 true 表示还在统计（任务进行中，或结束不到 3 分钟）。label 例如"首版""第 1 次修改""重试""第 3 章" |
| `GET /tasks/{id}/usage` | `{items: [{at, turnId, label, kind, model, input, cacheRead, cacheWrite, output, chars, credits, billable, note}], total}`。kind 是 `model`（主 Agent）、`vision`（看图）或 `voice`（配音，用 chars）；billable 为 false 表示不计费，note 写原因（比如"安全策略误拦后自动重做，不计费"）。加 `?format=csv` 返回 CSV 文件 |
| `GET /usage?from=&to=` | `{from, to, total, days: [{date, credits}], tasks: [{id, title, credits, createdAt, status}], month: <同 /me 的 credits>}`，不传日期时默认本月 |
| 新建、确认、修改、重试 | 额度用完时返回 HTTP 402，`{"error": "quota_exceeded", "message": "本月额度已用完，下月 1 日恢复"}` |

### 管理端（`/api`）

| 接口 | 返回 |
|---|---|
| `GET /usage?from=&to=` | `{from, to, total, days: [{date, credits}], users: [{sub, email, credits}]}`（users 按 credits 从高到低） |
| `GET /users` | 每项加 `monthCredits`、`quota` |
| `GET /users/{sub}` | 加 `credits: {month, used, quota, custom}`（custom 为 true 表示单独设过额度）；`months[]` 每项加 `credits` |
| `GET /users/{sub}/tasks` | 每项加 `credits` |
| `GET /users/{sub}/usage?from=&to=` | `{from, to, total, days: [{date, credits}], tasks: [{id, title, credits, createdAt, status}]}` |
| `PUT /users/{sub}/quota` | 请求 `{monthly: 数字或 null}`，null 表示恢复默认额度 |
| `GET /tasks/{id}/usage` | 同用户端（管理员可以看任意任务），加 `?format=csv` 导出 |
| `POST /tasks/{id}/adjust` | 请求 `{credits, reason}`：负数是退还，正数是补扣。记一条调整，写进操作日志 |
| `GET /billing`、`PUT /billing` | `{version, ratio, defaultMonthly, models: {<模型 id>: {name, input, cacheRead, cacheWrite, output}}, voice: {per10kChars, currency}, fx: {CNY}, updatedAt, updatedBy}`。单价单位：模型是美元 / 百万 token，配音是人民币 / 万字符 |
