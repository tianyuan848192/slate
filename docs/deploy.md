# 部署指南

照这份文档，在你自己的 AWS 账号里部署一套 Slate。一共三部分：

1. **[系统部署](#第一部分系统部署)**：准备 AWS 账号和一台部署机，装好环境，一条命令部署。第一次大约 1 小时，其中部署脚本自己运行 20～30 分钟。
2. **[系统初始化](#第二部分系统初始化)**：开管理员账号，配置密钥。
3. **[操作手册](#第三部分操作手册)**：日常的开账号、更新、看日志、删除，和常见问题。

# 第一部分：系统部署

## 1. 准备 AWS 账号（只做一次）

| 要准备的 | 为什么 | 怎么做 |
|---|---|---|
| **区域 us-east-1** | Slate 固定部署在美国东部（弗吉尼亚北部） | 下面所有操作都在这个区域做 |
| **默认 VPC** | 渲染机用默认 VPC 的公有子网（不需要 NAT） | VPC 控制台的 "Your VPCs" 里要有一个 Default VPC 为 Yes 的。没有就执行 `aws ec2 create-default-vpc --region us-east-1` |
| **Bedrock 模型** | 写稿、看图、听视频都用 Bedrock 上的模型 | 在 Bedrock 控制台的 Model catalog 里确认下面这些模型可用。第一次用 Anthropic 的模型，要先提交一次用途说明（use case form） |
| **GPU 配额** | 渲染机是 g4dn.xlarge 或 g5.xlarge，每台 4 个 vCPU，每个任务一台 | Service Quotas → Amazon EC2 → **Running On-Demand G and VT instances**，至少 8（可以同时跑 2 个任务）。新账号常常是 0，要提申请，批下来可能要几个小时到几天 |

要开通的模型：

| 用途 | 模型 | 必需吗 |
|---|---|---|
| 主 Agent | Claude Opus 5.5 | 必需 |
| 主 Agent 的备用（被内容安全策略误拦时换用） | Claude Opus 4.8、GPT-6 Astra | 建议 |
| 看图自检、核对文字 | Claude Sonnet 5.5（备用 Claude Opus 4.8） | 必需 |
| 风格创建时听参考视频 | TwelveLabs Pegasus 1.5 | 不用风格创建可以不开 |

配音默认用 Amazon Polly，不需要准备。想用 MiniMax 中国区的音色，部署后再填它的 API Key（见第二部分）。

## 2. 准备部署机（只做一次）

部署脚本要在一台 Linux 机器上运行：构建 Agent 的会话镜像，打包 Lambda，再用 CDK 创建资源。推荐专门开一台 EC2：

| 项目 | 推荐 |
|---|---|
| 系统镜像（AMI） | **Amazon Linux 2023，64 位（Arm）** |
| 实例类型 | **t4g.xlarge**（4 vCPU、16 GB 内存），或者 c7g.xlarge |
| 磁盘 | **50 GB** gp3 |
| 网络 | 默认 VPC 的公有子网，自动分配公网 IP（要能访问 GitHub、AWS 和 Docker Hub） |
| 安全组 | 不需要开任何入站端口，用 Session Manager 连接 |
| IAM 角色 | 见下面 |

会话镜像是 arm64 的，在 arm64（Graviton）机器上能直接构建。x86 机器也可以用，但要先装 QEMU，构建慢好几倍（见"常见问题"）。

### 部署机的 IAM 角色

新建一个给 EC2 用的 IAM 角色，挂两个 AWS 托管策略：

| 策略 | 为什么要 |
|---|---|
| **AdministratorAccess** | 部署要创建几十种资源：IAM 角色、CloudFormation 栈、Lambda、S3、DynamoDB、Cognito、CloudFront、ECR、CodeBuild、Bedrock AgentCore 等。第一次部署还要做 CDK bootstrap（创建 CDK 自己用的角色和存储桶）。这些都要管理员权限 |
| **AmazonSSMManagedInstanceCore** | 用 Session Manager 连接这台机器，不需要开 SSH 端口和密钥 |

这台机器只用来部署。部署完可以把它停掉，要更新时再开；不用了就终止，同时删掉这个角色。

### 在控制台创建

1. **IAM** → Roles → Create role：Trusted entity 选 AWS service、EC2；权限勾上 `AdministratorAccess` 和 `AmazonSSMManagedInstanceCore`；角色名比如 `slate-deployer`。
2. **EC2**（区域 us-east-1）→ Launch instance：
   - Name：`slate-deployer`；
   - AMI：Amazon Linux 2023 AMI，Architecture 选 **64-bit (Arm)**；
   - Instance type：`t4g.xlarge`；
   - Key pair：选 Proceed without a key pair；
   - Network settings：默认 VPC，Auto-assign public IP 选 Enable；安全组新建一个，**去掉 SSH 规则**，入站不留任何规则；
   - Storage：50 GiB gp3；
   - Advanced details → IAM instance profile：选刚才的 `slate-deployer`；
   - Launch instance。
3. 等实例状态变成 Running、Status check 通过（大约 2 分钟）：选中实例 → Connect → **Session Manager** → Connect。进去以后先切到 ec2-user：

   ```bash
   sudo su - ec2-user
   ```

不想新开机器也可以用自己的 Linux 或 macOS，前提是：装好第 3 步的那些工具，配置好有管理员权限的 AWS 凭证。

## 3. 装环境（只做一次）

在部署机上执行：

```bash
sudo dnf install -y git
git clone https://github.com/tianyuan848192/slate.git
cd slate
./scripts/setup-deploy-machine.sh
```

脚本会装好 Docker、Node.js 22、Python 3.12 和 pip，启动 Docker，并把当前用户加进 docker 组。可以重复运行。

装完**重新登录一次**，让 docker 组的权限生效：

```bash
exit
sudo su - ec2-user
cd slate
```

## 4. 部署前检查

```bash
./deploy.sh check
```

检查的项目：
- **本机工具**：工具和版本、Docker 有没有权限、磁盘空间、机器架构；
- **AWS 账号**：凭证、默认 VPC、CDK bootstrap、有没有部署需要的权限；
- **Bedrock 模型和 AgentCore**：要用的模型有没有开通，AgentCore 能不能用；
- **GPU 配额**：G 系列实例的 vCPU 配额。

- ✗ 是**必须处理**的，不处理部署会失败，提示里写了怎么办；
- ! 是**提醒**：不影响部署，但会影响使用。比如模型没开通，做片会失败；GPU 配额不够，渲染会排不上。

## 5. 部署

```bash
./deploy.sh
```

脚本会依次做这些事，首次大约 20～30 分钟：

1. 再检查一遍；
2. 第一次使用时做 CDK bootstrap；
3. 构建 Agent 的会话镜像，打包 Lambda；
4. 部署主栈 `Slate` 和管理端栈 `Slate-admin`；
5. 渲染机的镜像由 CodeBuild 在云端构建。

结束时会打印用户端和管理端的访问地址。接下来做第二部分。

中途失败了，处理完错误后**直接再运行一次 `./deploy.sh`**。CDK 会接着上次的状态继续，不会重复创建资源。

# 第二部分：系统初始化

部署完做一次。

## 1. 开管理员账号

```bash
./deploy.sh user add you@example.com --admin   # 开第一个管理员，会打印临时密码
./deploy.sh status                             # 用户端和管理端的访问地址
```

- 打开**管理端**地址，用这个邮箱和临时密码登录。第一次登录要改密码。
- 不想用临时密码，可以直接给定一个：`./deploy.sh user add you@example.com '你的密码' --admin`。直接给定的密码是永久的，不用首次修改；至少 8 位，要有大小写字母和数字。
- 管理员用同一个账号登录**用户端**，就可以做片子。

## 2. 配置密钥

| 密钥 | 要不要配 | 说明 |
|---|---|---|
| 模型 | **不用配** | 模型全部用 IAM 权限调用，不用任何模型 Key。部署时已经给 Agent 挂好了模型调用的策略 `<栈名>-models`（默认是 `Slate-models`）。管理端"模型与密钥"里能看到当前用的模型 |
| MiniMax 中国区 API Key（配音） | 可选 | 在管理端"模型与密钥"里填写，可以先点测试；也可以执行 `MINIMAX_API_KEY=你的key ./deploy.sh secret minimax`。Key 存在 Secrets Manager 里，Agent 的会话读不到。填好以后 5 分钟内生效，不用重新部署 |

**不配 MiniMax 时的配音**：所有片子的配音都用 Amazon Polly 的智语（Zhiyu，女声）。v1.0.0 有一个已知问题：用户端的音色列表里还是会显示 MiniMax 的音色，但选了哪个都会用智语；Agent 在回复里也可能说"原本选的音色没配成功，用的是备用音色"。配上 MiniMax Key 就正常了。

## 3. 设置额度（可选）

- 管理端"计费设置"：Credit 的换算比例、默认月额度（新部署默认每人每月 1000 Credit）和各模型单价。
- 管理端"用户" → 某个用户：单独给这个用户设月额度，或者临时加额度。

## 4. 验证一下（可选）

开一个测试账号，用它做一支 15 秒的片子：

```bash
./deploy.sh user add tester@example.com 'Test1234abcd'
python3.12 scripts/smoke.py --email tester@example.com --password 'Test1234abcd' create "15 秒讲清楚为什么切洋葱会流泪" --duration 15 --no-web
```

大约 20 分钟出片，成片下载到 `/tmp/`。

# 第三部分：操作手册

## 访问地址

```bash
./deploy.sh status        # 用户端、管理端地址和主要资源
```

## 开账号、管理用户

第一版关闭了自助注册，账号由管理员开：

- **管理端"用户"**：开账号、设额度、看每个人的用量和任务；
- **命令行**：

  ```bash
  ./deploy.sh user add 邮箱                  # 开普通用户，打印临时密码
  ./deploy.sh user add 邮箱 '密码' --admin   # 开管理员，密码直接给定
  ./deploy.sh user list                     # 列出用户
  ```

管理端"用量"看全站的用量，"操作日志"看管理员做过的操作。

## 更新

```bash
git pull && ./deploy.sh   # 更新到最新版本（会先自动检查一遍）
./deploy.sh web           # 只更新用户端前端
./deploy.sh admin         # 只更新管理端
```

更新不影响已有的用户、任务和成片。

## 看日志

```bash
./deploy.sh logs voice 30   # 某个 Lambda 最近 30 分钟的日志
```

可以看的有 `api`、`turn`、`finish`、`events`、`voice`、`llm`、`admin`。比如配音有问题看 `voice`，管理端出错看 `admin`。

## 部署机

部署机只在部署和更新时用。平时可以在 EC2 控制台把它停掉（停掉不收计算费），要更新时再开。不用了就终止，同时删掉它的 IAM 角色。

## 删除

```bash
./deploy.sh destroy           # 删除两个栈，保留数据桶、任务表和用户池
./deploy.sh destroy --purge   # 连数据一起删除（要输入栈名确认）
```

## 常见问题

| 现象 | 原因和处理 |
|---|---|
| `docker: permission denied` | 当前用户还不在 docker 组里：退出重新登录（`exit` 再 `sudo su - ec2-user`） |
| `缺少 python3.12`、`缺少 node` | 还没装环境：运行 `./scripts/setup-deploy-machine.sh` |
| `AccessDenied`、`is not authorized to perform` | 部署机的角色权限不够：确认挂了 AdministratorAccess。公司账号如果有 SCP 限制，请账号管理员放行 |
| 找不到默认 VPC（`Could not find any VPCs matching`） | `aws ec2 create-default-vpc --region us-east-1` |
| 部署成功，但做片时报模型没权限 | 对应的模型没开通，或者没提交 Anthropic 的用途说明。用 `./deploy.sh check` 看是哪个模型 |
| 片子一直停在"渲染中" | GPU 配额不够，渲染机开不起来。用 `./deploy.sh check` 看配额，再到 Service Quotas 申请 |
| 选了不同的音色，听到的都是同一个女声 | 没配 MiniMax Key，配音都用 Polly 的智语。见第二部分"配置密钥" |
| x86 机器上构建镜像报 `exec format error` | 先装 QEMU：`docker run --privileged --rm tonistiigi/binfmt --install arm64`，或者换一台 arm64 的部署机 |
| 磁盘不够（`no space left on device`） | 部署机磁盘至少 50 GB。可以执行 `docker system prune -af` 清理旧镜像 |
| 想在同一个账号里部署第二套 | 用不同的栈名，比如 `STACK=SlateTest ./deploy.sh`。所有资源名都跟着栈名变，两套互不影响 |
