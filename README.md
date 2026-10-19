# Slate：讲解片和广告片生成平台

用一段话描述想做的片子，可以附上参考资料、图片和 3D 素材，选一种写作方法和画风。一个 Amazon Bedrock AgentCore Harness Agent 会查资料、写稿、写分镜、写动画代码（HTML 场景，按时间逐帧渲染），配音、渲染、自检后合成 MP4。

全部资源都在你自己的 AWS 账号里，由 CDK 创建，`./deploy.sh` 一条命令部署。

## 功能

- **新建视频**：快速模式只写描述；高级模式可以指定画风、规格、配音和分镜确认。
  - 参考资料：文件、链接、粘贴的文字，可以开"强制引用"；
  - 图片：每张写一句描述，Agent 自己决定放在哪几镜、怎么排；
  - 3D 图片：引用素材库里做好的 three.js 模型。
- **写作方法 × 画风**：两类 Skill 自由搭配。写作方法决定剧本怎么组织，内置 11 种；画风决定画面长什么样，内置 44 种。
- **工作流模式**：在画板上分节点操作。文字节点出剧本和分镜，音画节点出成片，各自修改、各自重跑。
- **长片**：超过 3 分钟的片子按章节并行制作，再拼成整片。
- **3D 图片**：照片或描述 → 程序化 three.js 模型，可以拆解、导出 3D 打印文件。
- **素材库**：做好的视频、3D 图片，上传过的图片和资料，都可以再用。
- **管理端**：用户和额度、用量和计费（Credit）、模型与密钥、操作日志。
  - Skill 创建：上传一段参考视频，"反编译"成画风和写作方法两种 Skill，验证、内测后再公开。

## 架构

| 部分 | 用的服务 |
|---|---|
| Agent | Bedrock AgentCore Harness：每个任务一个会话（独立的 microVM），会话镜像里有配音、渲染、自检、看图、合成等 `slate-*` 命令 |
| 渲染 | AgentCore Runtime 的 Instance 模式：每个任务一台 GPU 实例（g4dn / g5），本机 Chrome 逐帧截图，ffmpeg 编码 |
| 模型 | Amazon Bedrock：Claude（主 Agent、看图自检），TwelveLabs Pegasus（风格创建时听参考视频） |
| 配音 | MiniMax 中国区（可选），没配置时用 Amazon Polly |
| 后端 | API Gateway + Lambda、DynamoDB、S3、Cognito；成片走 CloudFront 签名链接 |
| 前端 | 用户端和管理端都是纯静态页，S3 + CloudFront |

设计文档在 `docs/`：总体设计 [design.md](docs/design.md)、接口 [api.md](docs/api.md)，以及各功能的设计说明。

## 部署

**第一次部署请照 [部署指南](docs/deploy.md) 一步一步做。** 分三部分：系统部署（AWS 账号的准备、部署机 EC2 的配置和 IAM 角色、装环境、检查、部署），系统初始化（管理员账号、密钥），操作手册（日常操作和常见问题）。

简单来说：

1. **AWS 账号**：区域固定 `us-east-1`；开通要用的 Bedrock 模型；GPU 配额 "Running On-Demand G and VT instances" 至少 8 个 vCPU；有默认 VPC。
2. **部署机**：一台 Amazon Linux 2023（arm64）的 EC2，挂有 AdministratorAccess 的 IAM 角色。
3. **部署**：

```bash
git clone https://github.com/tianyuan848192/slate.git && cd slate
./scripts/setup-deploy-machine.sh             # 装环境：Docker、Node.js、Python 3.12（装完重新登录一次）
./deploy.sh check                             # 部署前检查：工具、权限、模型、GPU 配额
./deploy.sh                                   # 首次约 20～30 分钟：检查、bootstrap、构建镜像、部署两个栈
./deploy.sh user add you@example.com --admin  # 开第一个管理员账号，会打印临时密码，首次登录要改
./deploy.sh status                            # 用户端和管理端的访问地址
```

部署完会创建两个栈：主栈 `Slate` 和管理端栈 `Slate-admin`。第一版关闭了自助注册，用户由管理员在管理端开账号，或者用 `./deploy.sh user add` 开。配音默认用 Amazon Polly；想用 MiniMax 中国区的音色，在管理端填它的 API Key，或者执行 `MINIMAX_API_KEY=... ./deploy.sh secret minimax`。

### 常用命令

```bash
./deploy.sh                       # 部署或更新全部资源
./deploy.sh web                   # 只更新用户端前端
./deploy.sh admin                 # 只更新管理端
./deploy.sh user list             # 列出用户
./deploy.sh logs turn 30          # 看某个 Lambda 最近 30 分钟的日志（api、turn、finish、events、voice、llm、admin）
./deploy.sh destroy               # 删除栈，默认保留数据桶、任务表和用户池
./deploy.sh destroy --purge       # 连数据一起删除
```

### 环境变量

| 变量 | 作用 |
|---|---|
| `STACK` | 栈名，默认 `Slate`。同一个账号里部署第二套时用 |
| `MODELS` | 主 Agent 的模型列表，逗号分隔，第一个是主模型，后面是备用 |
| `NETWORK` | `public`（默认）或 `vpc`。vpc 模式下 Agent 会话没有公网出口（还在试验，见 `docs/design.md`） |
| `MINIMAX_API_KEY` | 设置了的话，部署完自动写进 Secrets Manager |

## 权限和密钥

- **模型都用 IAM 角色调用**，平台不存任何模型的 Key。Agent 执行角色上挂两份托管策略：
  - `<栈名>-agent-services`：调用其他 AWS 服务；
  - `<栈名>-models`：调用模型。它同时挂在看图服务（llm Lambda）上，想收窄或更换模型调用的权限，改这一份就行。

  详见 [docs/model-keys-design.md](docs/model-keys-design.md)。
- **唯一的第三方 Key 是 MiniMax**，存在 Secrets Manager，只有配音 Lambda 读得到。
- **会话里没有长期凭证**：每一轮写进会话的只有这个任务的临时存储凭证，1 小时有效，只能读写这个任务的目录。
- **账号如果开启了 Bedrock 的模型调用日志**，并且记录文本内容，平台的提示词和用户资料会进那份日志，请按你的数据政策决定。

## 费用

按量计费，没有常驻的计算资源。

- **主要是模型费用**，一般占八到九成。实测提示缓存命中率 93%～96%：
  - 15 秒的片子大约 2～3 美元；
  - 3 分钟的片子大约 6～9 美元；
  - 复杂画风、带图片的片子会更多。
- **渲染机**：做片期间每个任务开一台 GPU 实例，任务停下来几秒后关机。
- **其他**：CloudFront、Lambda、DynamoDB、S3 按用量计，通常很少。

管理端可以按模型设置单价和换算比例（Credit），给用户设月额度。统计方法见 [docs/cost.md](docs/cost.md) 和 [docs/credit-design.md](docs/credit-design.md)。

## 本地开发

```bash
python3.12 -m venv .venv && .venv/bin/pip install boto3 fastjsonschema cryptography pytest
cd backend && ../.venv/bin/python -m pytest tests -q       # 后端单元测试
python3 web/dev/mock_server.py                            # 用户端的本地 mock（用法见文件开头）
python3 admin/dev/mock_server.py --port 8790              # 管理端的本地 mock
```

部署后的端到端冒烟测试在 `scripts/`：`smoke.py`（做一支片子）、`admin_smoke.py`（管理端接口）、`flow_smoke.py`（工作流模式）、`style_smoke.py`（Skill 创建）。它们从 `.slate/test-user.json` 和 `.slate/test-admin.json` 读测试账号，格式是 `{"email": "...", "password": "..."}`。这两个文件要你自己创建，`.slate/` 不进 git。

## 目录

```
deploy.sh        一键部署入口
infra/           CDK（TypeScript）：主栈和管理端栈
agent/image/     Agent 会话镜像：slate-* 命令、场景运行时、字体和素材
agent/render/    渲染机镜像
agent/skills/    做片手册、风格创建手册、写作方法、画风、镜头模板和动作库
agent/prompts/   系统提示词
backend/         Lambda：api、turn、finish、events、llm、voice、meter、admin 等
web/             用户端前端（web/dev/ 是本地 mock）
admin/           管理端前端（admin/dev/ 是本地 mock）
scripts/         冒烟测试、导入和构建工具
docs/            设计文档
```

## 许可

- 本项目以 [Apache-2.0](LICENSE) 发布。
- 用到的第三方代码、风格、字体和素材，各自的来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，许可证原文在 `agent/licenses/` 和字体目录里。
