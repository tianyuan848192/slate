# 模型来源和 Key 的管理（2026-10-18 定）

## 一、定下来的

- **整个平台只有一个模型来源**，所有用到模型的地方都走它：
  - 主 Agent：写稿、写分镜、写代码；
  - 看图自检、剧本和资料核对、风格创建的冷启动试写和评分；
  - 看视频：风格创建听旁白，用 TwelveLabs Pegasus。
- **现在用部署账号的 IAM 角色**调 Amazon Bedrock。平台不存任何模型的 Key。
- **不做 Bedrock API Key 这种来源**。它和 IAM 角色的区别只在能不能跨账号，而跨账号一般用 OpenAI 兼容接口解决。
- **以后跨账号**（部署到不能用 Bedrock 的账号）时，改走 OpenAI 兼容接口，也就是客户自己的代理平台。做法见第四节，还没做。
- **配音的 MiniMax Key 单独管**：存在 Secrets Manager，只有配音 Lambda 读得到，管理端能更换和测试。

## 二、权限：两份托管策略

Agent 的执行角色（Harness 用它调模型，会话沙箱里的代码也用它）上挂两份 IAM 托管策略：

| 策略 | 管什么 | 挂在哪 |
|---|---|---|
| `<栈名>-agent-services` | 调用其他 AWS 服务：渲染浏览器、渲染机、工具网关（联网搜索）、配音和 llm Lambda、轮次结束的 hook、Polly、日志、监控指标、拉会话镜像 | Agent 执行角色 |
| `<栈名>-models` | 调用模型：`bedrock:InvokeModel`、`bedrock:InvokeModelWithResponseStream`，所有资源 | Agent 执行角色、llm Lambda 的角色 |

- 调用模型的权限只在 `<栈名>-models` 这一份里。主 Agent 和 llm Lambda 共用它，**改这一份就同时管住平台所有的模型调用**，比如收窄到某几个模型，或者换成别的账号的 Bedrock 资源。
- 两份都由 CDK 管，`./deploy.sh` 会按代码重新设置。在控制台直接改的话，下次部署会被改回去，所以长期要改的写进 `infra/lib/slate-stack.ts`。
- 执行角色上**没有任何读 Key 的权限**。以前那条 `ModelKeys`（读 `<栈名>/models/*` 的密钥、读 AgentCore Identity 里的 API Key 凭证）已经去掉。

## 三、这次改了什么

- **后端**：
  - `lib/models.py` 只剩 IAM 角色一种来源：每个用途主模型在前、备用模型在后；
  - 主 Agent 被内容安全策略拦下时换备用模型，和以前一样；
  - 去掉"来源调不通换下一个来源"，因为只有一个来源，调不通就报错。
- **llm Lambda**：去掉经 Bedrock API Key、OpenAI 兼容接口调用的代码，只用 IAM 角色。
- **管理端"模型与密钥"**：
  - 显示模型来源（本账号 IAM 角色）、各用途的模型和调用模型的策略名；
  - 只有 MiniMax 能填 Key；
  - 去掉 Bedrock API Key、多个 OpenAI 兼容接口、来源优先级。对应的接口也去掉了。
- **管理端的权限**：去掉创建和读取模型密钥、管理 AgentCore Identity 凭证的权限。

## 四、以后跨账号：OpenAI 兼容接口（没做，记下思路）

- 管理端把模型来源从"IAM 角色"切成"OpenAI 兼容接口"，填地址、一把 Key、各用途的模型名。
- **主 Agent 不能直接拿这把 Key**：Harness 用 Key 时是拿执行角色去取的，沙箱和 Harness 共用执行角色，只要 Key 进了 Harness，就挡不住沙箱读到它。所以要加一个**模型网关**：
  - 一个按 OpenAI 协议提供服务的 Lambda，流式返回；
  - Harness 的模型配置指向它，只拿到网关令牌；
  - 真正的 Key 只有网关和 llm Lambda 读得到。沙箱就算读到网关令牌，也只能经过网关调模型，和 IAM 模式下"沙箱能用执行角色调 Bedrock"是同一个风险等级。
- 切到这种来源时，`<栈名>-models` 可以摘掉，执行角色就一点模型权限都没有了。
- 要实测的：
  - 10-14 发现 Harness 的 LiteLLM 接法会丢掉写大文件的工具参数，网关走的是 OpenAI 接法，要专门测；
  - 提示缓存还能不能生效；
  - 代理平台一般没有看视频的模型，到时风格创建的"写作方法"不能选；
  - 代理平台上的模型价格要在计费设置里填。
