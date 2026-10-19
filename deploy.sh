#!/usr/bin/env bash
# Slate 一键部署入口。本项目用到的全部 AWS 资源都在 CDK 栈里（infra/），由本脚本统一创建和删除。
#
#   ./deploy.sh [all]                 检查 → 构建镜像 → 部署主栈和管理端栈（首次会自动 bootstrap）
#   ./deploy.sh check                 部署前检查：本机工具、AWS 凭证和权限、默认 VPC、Bedrock 模型、AgentCore、GPU 配额（docs/deploy.md）
#   ./deploy.sh admin                 只更新管理端栈（管理端的前端、API 和 Lambda）
#   ./deploy.sh web                   只更新用户端的前端静态页（不动其他资源）
#   ./deploy.sh user add <邮箱> [密码] [--admin]  开账号（不给密码时生成临时密码，首次登录要求修改；--admin 设为管理员）
#   ./deploy.sh user list
#   ./deploy.sh status                打印访问地址和资源信息
#   ./deploy.sh secret minimax        写入 MiniMax 中国区 API Key（存进 Secrets Manager；读环境变量 MINIMAX_API_KEY，没有就提示输入）
#   ./deploy.sh logs <api|turn|finish|events|voice|llm|admin> [分钟]
#   ./deploy.sh destroy [--purge [--yes]]  删除栈；默认保留数据桶、任务表和用户池，加 --purge 一起删除
#   ./deploy.sh cleanup               清理栈已不再管理的残留 VPC（从 vpc 模式切回 public 时，AgentCore 托管网卡释放前删不掉）
#
# 环境变量：STACK（栈名，默认 Slate）、MODELS（逗号分隔的模型列表，第一个是主模型）、
#           NETWORK（public 或 vpc；vpc 模式下 Agent 会话没有公网出口）、
#           MINIMAX_API_KEY（设置了的话，部署完自动写进 Secrets Manager）。区域固定 us-east-1。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STACK="${STACK:-Slate}"
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 CDK_DEFAULT_REGION=us-east-1
OUT="$ROOT/.slate/outputs-$STACK.json"
CTX=(-c "stackName=$STACK")
[[ -n "${MODELS:-}" ]] && CTX+=(-c "models=$MODELS")
[[ -n "${NETWORK:-}" ]] && CTX+=(-c "network=$NETWORK")
[[ -n "${EXCLUDE_SKILLS:-}" ]] && CTX+=(-c "excludeSkills=$EXCLUDE_SKILLS")

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

check_deps() {
  for b in aws node npm docker python3.12; do command -v "$b" >/dev/null || die "缺少 $b"; done
  python3.12 -m pip --version >/dev/null 2>&1 || die "python3.12 没有 pip（Lambda 打包需要）"
  docker info >/dev/null 2>&1 || die "docker 没有运行"
  aws sts get-caller-identity >/dev/null || die "AWS 凭证不可用"
  export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
  [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] || say "提示：当前不是 arm64 机器，镜像会用 QEMU 交叉构建，速度较慢"
}

npm_install() {
  (cd "$ROOT/infra" && { [[ -d node_modules ]] || npm ci --silent || npm install --silent; })
}

bootstrap() {
  aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1 || {
    say "首次使用：cdk bootstrap"
    (cd "$ROOT/infra" && npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/us-east-1")
  }
}

output() { python3.12 -c "import json,sys; d=json.load(open('$OUT')); print(d['$STACK']['$1'])"; }
admin_output() { python3.12 -c "import json,sys; d=json.load(open('$OUT')); print(d['$STACK-admin']['$1'])"; }

# 部署前检查（docs/deploy.md 第一部分第 4 步）：✗ 是必须处理的（不处理部署会失败），! 是提醒（不影响部署，但影响使用）
cmd_check() {
  local bad=0 b v
  ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
  no() { printf '  \033[31m✗\033[0m %s\n' "$*"; bad=1; }
  warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
  say "本机工具"
  for b in git aws node npm docker python3.12; do
    if command -v "$b" >/dev/null; then ok "$b：$("$b" --version 2>&1 | head -1)"; else no "缺少 $b：运行 ./scripts/setup-deploy-machine.sh"; fi
  done
  if command -v node >/dev/null; then
    v="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$v" -ge 20 ]] || no "Node.js 版本太低（$v），需要 20 以上"
  fi
  if command -v python3.12 >/dev/null; then python3.12 -m pip --version >/dev/null 2>&1 || no "python3.12 没有 pip：运行 ./scripts/setup-deploy-machine.sh"; fi
  if command -v docker >/dev/null; then
    if docker info >/dev/null 2>&1; then ok "Docker 在运行，当前用户有权限"
    else no "Docker 用不了：没有启动，或者当前用户还不在 docker 组（装完环境要重新登录一次）"; fi
  fi
  # 代码目录和 Docker 的数据目录（构建镜像用）取剩余空间小的那个
  v="$(df -Pk "$ROOT" "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo "$ROOT")" 2>/dev/null | awk 'NR>1 {g=int($4/1048576); if (m=="" || g<m) m=g} END {print m+0}')"
  if [[ "$v" -ge 20 ]]; then ok "磁盘剩余 ${v} GB"; else warn "磁盘只剩 ${v} GB，构建镜像建议至少 20 GB（docker system prune -af 可以清理旧镜像）"; fi
  case "$(uname -m)" in
    aarch64|arm64) ok "arm64 机器，会话镜像可以直接构建" ;;
    *) if docker run --rm --platform linux/arm64 public.ecr.aws/docker/library/alpine:3 true >/dev/null 2>&1; then warn "x86 机器：会用 QEMU 构建 arm64 镜像，会慢几倍"
       else no "x86 机器上没装 QEMU，构建不了 arm64 镜像：docker run --privileged --rm tonistiigi/binfmt --install arm64"; fi ;;
  esac

  say "AWS 账号（区域固定 us-east-1）"
  local arn
  if ! arn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)"; then
    no "AWS 凭证不可用：部署机要挂 IAM 角色，或者配置 aws configure"
    echo; die "有必须处理的问题（✗），处理完再运行 ./deploy.sh check"
  fi
  ok "身份：$arn"
  # 权限：模拟几个部署一定会用到的操作（需要 iam:SimulatePrincipalPolicy；查不了就只提醒）
  local role="$arn" denied
  [[ "$arn" == *":assumed-role/"* ]] && role="$(sed -E 's#:sts::([0-9]+):assumed-role/([^/]+)/.*#:iam::\1:role/\2#' <<<"$arn")"
  if denied="$(aws iam simulate-principal-policy --policy-source-arn "$role" --action-names iam:CreateRole iam:PassRole cloudformation:CreateStack \
      s3:CreateBucket ecr:CreateRepository lambda:CreateFunction dynamodb:CreateTable cognito-idp:CreateUserPool cloudfront:CreateDistribution \
      bedrock-agentcore:CreateAgentRuntime codebuild:CreateProject --query 'EvaluationResults[?EvalDecision!=`allowed`].EvalActionName' --output text 2>/dev/null)"; then
    if [[ -z "$denied" || "$denied" == "None" ]]; then ok "部署需要的权限都有"; else no "部署机的权限不够，缺：$denied（部署机的角色要挂 AdministratorAccess）"; fi
  else
    warn "查不了权限（没有 iam:SimulatePrincipalPolicy）：部署机的角色要挂 AdministratorAccess"
  fi
  if [[ "$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'length(Vpcs)' --output text 2>/dev/null)" -ge 1 ]]; then ok "有默认 VPC"
  else no "没有默认 VPC（渲染机要用）：aws ec2 create-default-vpc --region us-east-1"; fi
  if aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then ok "CDK 已经 bootstrap"; else ok "还没有 CDK bootstrap：部署时会自动做"; fi

  say "Bedrock 模型和 AgentCore"
  local models m id need
  models="$("$(command -v python3.12 || command -v python3)" - "$ROOT" "${MODELS:-}" <<'PY'
import re, sys
root, env = sys.argv[1], sys.argv[2]
src = open(f"{root}/infra/bin/slate.ts", encoding="utf-8").read()
agent = (env or re.search(r"tryGetContext\('models'\) \|\| '([^']+)'", src).group(1)).split(",")
vision = re.findall(r'"SLATE_VISION_(?:MODEL|FALLBACK)", "([^"]+)"', open(f"{root}/backend/lib/models.py", encoding="utf-8").read())
video = re.search(r'VIDEO_MODEL = "([^"]+)"', open(f"{root}/backend/lib/models.py", encoding="utf-8").read()).group(1)
seen = []
for i, m in enumerate(agent):
    seen.append((m, "必需" if i == 0 else "备用", "主 Agent"))
for i, m in enumerate(vision):
    seen.append((m, "必需" if i == 0 else "备用", "看图自检"))
seen.append((video, "可选", "风格创建听视频"))
done = set()
for m, need, use in seen:
    if m not in done:
        done.add(m); print(m, need, use)
PY
)"
  while read -r m need use; do
    [[ -n "$m" ]] || continue
    id="$(sed -E 's/^(global|us|eu|apac|jp|au)\.//' <<<"$m")"
    v="$(aws bedrock get-foundation-model-availability --model-id "$id" --query authorizationStatus --output text 2>/dev/null || echo unknown)"
    if [[ "$v" == "AUTHORIZED" ]]; then ok "$id（$use$([[ "$need" == 必需 ]] || echo "，$need")）"
    elif [[ "$v" == "unknown" ]]; then warn "$id（$use）：查不到开通状态（AWS CLI 太旧，或者没有权限），请在 Bedrock 控制台确认"
    elif [[ "$need" == "必需" ]]; then warn "$id（$use，必需）还没开通：做片会失败。到 Bedrock 控制台开通（Anthropic 的模型要先提交用途说明）"
    else warn "$id（$use，$need）还没开通：$([[ "$need" == 备用 ]] && echo '主模型被误拦时没有备用' || echo '风格创建时不能生成写作方法')"; fi
  done <<<"$models"
  if aws bedrock-agentcore-control list-agent-runtimes --max-results 1 >/dev/null 2>&1; then ok "可以使用 Bedrock AgentCore"
  else warn "调不通 Bedrock AgentCore（list-agent-runtimes）：确认区域是 us-east-1、AWS CLI 是最新的"; fi

  say "GPU 配额（渲染机 g4dn.xlarge / g5.xlarge，每台 4 vCPU，每个任务一台）"
  v="$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-DB2E81BA --query 'Quota.Value' --output text 2>/dev/null | cut -d. -f1 || true)"
  if [[ -z "$v" || "$v" == "None" ]]; then warn "查不到配额：在 Service Quotas 里确认 Running On-Demand G and VT instances 至少 8"
  elif [[ "$v" -ge 8 ]]; then ok "Running On-Demand G and VT instances：$v vCPU（最多同时 $((v / 4)) 个任务渲染）"
  elif [[ "$v" -ge 4 ]]; then warn "Running On-Demand G and VT instances：$v vCPU，只能同时 1 个任务渲染，建议申请到 8 以上"
  else warn "Running On-Demand G and VT instances：${v} vCPU，渲染机开不起来，做片会卡在渲染。到 Service Quotas 申请到 8 以上"; fi

  echo
  if [[ "$bad" == 0 ]]; then say "检查通过，可以运行 ./deploy.sh（标 ! 的是提醒，不影响部署）"
  else die "有必须处理的问题（✗），处理完再运行 ./deploy.sh check"; fi
}

cmd_all() {
  cmd_check
  check_deps; npm_install; bootstrap
  mkdir -p "$ROOT/.slate"
  say "部署栈 $STACK（构建会话镜像、打包 Lambda、更新 Harness 和前端）"
  (cd "$ROOT/infra" && npx cdk deploy "${CTX[@]}" "$STACK" "$STACK-admin" --require-approval never --outputs-file "$OUT")
  [[ -n "${MINIMAX_API_KEY:-}" ]] && cmd_secret minimax
  cmd_status
}

cmd_admin() {
  check_deps; npm_install
  [[ -f "$OUT" ]] || die "还没有部署过，先运行 ./deploy.sh"
  say "只部署管理端栈 $STACK-admin"
  local tmp; tmp="$(mktemp)"
  (cd "$ROOT/infra" && npx cdk deploy "${CTX[@]}" "$STACK-admin" --exclusively --require-approval never --outputs-file "$tmp")
  # 合并进总的输出文件（只部署一个栈时，CDK 只写这个栈的输出）
  python3.12 - "$OUT" "$tmp" <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
a.update(b); json.dump(a, open(sys.argv[1], "w"), indent=2)
PY
  rm -f "$tmp"
  say "管理端地址：$(admin_output AdminUrl)"
}

# 第三方服务的 API Key：栈里只建了 Secret（模板里是占位值），真实的值在这里写入，不经过 CloudFormation
cmd_secret() {
  [[ -f "$OUT" ]] || die "还没有部署过，先运行 ./deploy.sh"
  case "${1:-}" in
    minimax)
      local key="${MINIMAX_API_KEY:-}"
      if [[ -z "$key" ]]; then read -rsp "MiniMax 中国区 API Key：" key; echo; fi
      [[ -n "$key" ]] || die "API Key 为空"
      aws secretsmanager put-secret-value --secret-id "$(output MinimaxSecretArn)" --secret-string "$key" >/dev/null
      say "已写入 MiniMax API Key（$(output MinimaxSecretArn | sed 's/.*:secret://')）" ;;
    *) die "用法：./deploy.sh secret minimax" ;;
  esac
}

cmd_web() {
  [[ -f "$OUT" ]] || die "还没有部署过，先运行 ./deploy.sh"
  local bucket dist
  bucket="$(output WebBucket)"; dist="$(output DistributionId)"
  say "同步前端到 s3://$bucket"
  aws s3 sync "$ROOT/web" "s3://$bucket" --delete --exclude "dev/*" --exclude "config.json" --cache-control no-cache
  python3.12 - "$OUT" "$STACK" > "$ROOT/.slate/config.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))[sys.argv[2]]
print(json.dumps({"apiBase": "/api", "region": "us-east-1", "userPoolId": d["UserPoolId"], "clientId": d["ClientId"]}))
PY
  aws s3 cp "$ROOT/.slate/config.json" "s3://$bucket/config.json" --content-type application/json --cache-control no-cache
  aws cloudfront create-invalidation --distribution-id "$dist" --paths '/*' --query Invalidation.Id --output text
}

cmd_user() {
  [[ -f "$OUT" ]] || die "还没有部署过，先运行 ./deploy.sh"
  local pool; pool="$(output UserPoolId)"
  case "${1:-}" in
    add)
      local email="${2:-}" pw="${3:-}" admin=""
      [[ "$pw" == "--admin" ]] && { pw=""; admin=1; }
      [[ "${4:-}" == "--admin" ]] && admin=1
      [[ -n "$email" ]] || die "用法：./deploy.sh user add <邮箱> [密码] [--admin]"
      if [[ -z "$pw" ]]; then
        pw="Slate-$(python3.12 -c 'import secrets; print(secrets.token_urlsafe(9))')1"
        aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" --message-action SUPPRESS \
          --temporary-password "$pw" --user-attributes Name=email,Value="$email" Name=email_verified,Value=true >/dev/null
        say "已创建 $email，临时密码：$pw（首次登录需要修改）"
      else
        aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" --message-action SUPPRESS \
          --user-attributes Name=email,Value="$email" Name=email_verified,Value=true >/dev/null
        aws cognito-idp admin-set-user-password --user-pool-id "$pool" --username "$email" --password "$pw" --permanent
        say "已创建 $email（密码已设为永久）"
      fi
      if [[ -n "$admin" ]]; then
        aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$email" --group-name admin
        say "已设为管理员，管理端地址：$(admin_output AdminUrl 2>/dev/null || echo '部署管理端后见 ./deploy.sh status')"
      fi ;;
    admin)  # 把已有账号设为管理员
      [[ -n "${2:-}" ]] || die "用法：./deploy.sh user admin <邮箱>"
      aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$2" --group-name admin
      say "已把 $2 设为管理员" ;;
    list)
      aws cognito-idp list-users --user-pool-id "$pool" --query 'Users[].[Username,UserStatus,UserCreateDate]' --output table
      say "管理员："; aws cognito-idp list-users-in-group --user-pool-id "$pool" --group-name admin --query 'Users[].Username' --output text ;;
    *) die "用法：./deploy.sh user add <邮箱> [密码] [--admin] | user admin <邮箱> | user list" ;;
  esac
}

cmd_status() {
  [[ -f "$OUT" ]] || die "还没有部署过"
  say "访问地址：$(output Url)"
  admin_output AdminUrl >/dev/null 2>&1 && say "管理端地址：$(admin_output AdminUrl)"
  python3.12 -c "import json; [print(f'  {k}: {v}') for k, v in json.load(open('$OUT'))['$STACK'].items()]"
  # 只报告密钥有没有配置，不打印内容
  local v; v="$(aws secretsmanager get-secret-value --secret-id "$(output MinimaxSecretArn 2>/dev/null)" --query SecretString --output text 2>/dev/null || true)"
  if [[ -n "$v" && "$v" != PLACEHOLDER* ]]; then echo "  MiniMax API Key：已配置"; else echo "  MiniMax API Key：未配置（./deploy.sh secret minimax）"; fi
}

cmd_logs() {
  local fn="${STACK}-${1:-api}" mins="${2:-30}"
  aws logs tail "/aws/lambda/$fn" --since "${mins}m" --format short
}

# 管理端在运行时创建的模型密钥（<栈名>/models/*）和 AgentCore Identity 凭证（<栈名>-oa-*、<栈名>-bedrock-key）不归 CDK 管，--purge 时一并删除
purge_model_keys() {
  for arn in $(aws secretsmanager list-secrets --filters Key=name,Values="$STACK/models/" --query 'SecretList[].ARN' --output text); do
    aws secretsmanager delete-secret --secret-id "$arn" --force-delete-without-recovery >/dev/null && say "已删除密钥 $arn"
  done
  for n in $(aws bedrock-agentcore-control list-api-key-credential-providers --query "credentialProviders[?starts_with(name, '$STACK-oa-') || name == '$STACK-bedrock-key'].name" --output text 2>/dev/null); do
    aws bedrock-agentcore-control delete-api-key-credential-provider --name "$n" >/dev/null && say "已删除凭证 $n"
  done
}

# 栈删掉以后 Lambda、CodeBuild 和 AgentCore 自己建的日志组还在：删栈前记下名字，--purge 时一起删
stack_log_groups() {
  local s
  for s in "$STACK" "$STACK-admin"; do
    aws cloudformation list-stack-resources --stack-name "$s" --output text 2>/dev/null \
      --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' || ResourceType=='AWS::CodeBuild::Project'].[ResourceType,PhysicalResourceId]" |
      awk '$1 == "AWS::Lambda::Function" {print "/aws/lambda/" $2} $1 == "AWS::CodeBuild::Project" {print "/aws/codebuild/" $2}'
  done
  for s in "${STACK}_" "harness_${STACK}_"; do
    aws logs describe-log-groups --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/$s" --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'
  done
}
purge_logs() {
  local g n=0
  while read -r g; do
    [[ -n "$g" && "$g" != "None" ]] || continue
    aws logs delete-log-group --log-group-name "$g" 2>/dev/null && n=$((n + 1))
  done <<<"$1"
  say "已删除 $n 个日志组"
}

cmd_destroy() {
  check_deps; npm_install
  if [[ "${1:-}" == "--purge" ]]; then
    if [[ "${2:-}" != "--yes" ]]; then
      read -r -p "将删除栈 $STACK 和全部用户数据（数据桶、任务表、用户池），输入栈名确认：" ans
      [[ "$ans" == "$STACK" ]] || die "已取消"
    fi
    say "先把保留策略改成删除"
    (cd "$ROOT/infra" && npx cdk deploy "${CTX[@]}" -c purge=true "$STACK" --require-approval never)
    purge_model_keys
    local logs; logs="$(stack_log_groups)"
    (cd "$ROOT/infra" && npx cdk destroy "${CTX[@]}" -c purge=true "$STACK-admin" "$STACK" --force)
    purge_logs "$logs"
  else
    (cd "$ROOT/infra" && npx cdk destroy "${CTX[@]}" "$STACK-admin" "$STACK" --force)
    say "栈已删除；数据桶、任务表和用户池按保留策略留在账号里（再次部署会新建一套）。彻底清理请用 --purge。"
  fi
  rm -f "$OUT"
}

cmd_cleanup() {
  # 找带本栈标签、但已不在栈资源里的 VPC，在托管网卡释放后删除它和它的子网、安全组、终端节点
  local live; live="$(aws cloudformation describe-stack-resources --stack-name "$STACK" --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" --output text 2>/dev/null || true)"
  for vpc in $(aws ec2 describe-vpcs --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" --query 'Vpcs[].VpcId' --output text); do
    [[ " $live " == *" $vpc "* ]] && { say "$vpc 仍由栈管理，跳过"; continue; }
    local n; n="$(aws ec2 describe-network-interfaces --filters Name=vpc-id,Values="$vpc" --query 'length(NetworkInterfaces)' --output text)"
    if [[ "$n" != "0" ]]; then say "$vpc 里还有 $n 张网卡（AgentCore 托管，等服务释放后再运行本命令）"; continue; fi
    say "删除残留 VPC $vpc"
    for ep in $(aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values="$vpc" --query 'VpcEndpoints[].VpcEndpointId' --output text); do aws ec2 delete-vpc-endpoints --vpc-endpoint-ids "$ep" >/dev/null; done
    for sn in $(aws ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" --query 'Subnets[].SubnetId' --output text); do aws ec2 delete-subnet --subnet-id "$sn"; done
    for sg in $(aws ec2 describe-security-groups --filters Name=vpc-id,Values="$vpc" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text); do aws ec2 delete-security-group --group-id "$sg"; done
    for rt in $(aws ec2 describe-route-tables --filters Name=vpc-id,Values="$vpc" --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text); do aws ec2 delete-route-table --route-table-id "$rt"; done
    aws ec2 delete-vpc --vpc-id "$vpc" && say "已删除 $vpc"
  done
}

case "${1:-all}" in
  all) cmd_all ;;
  check) cmd_check ;;
  web) cmd_web ;;
  user) shift; cmd_user "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  destroy) shift; cmd_destroy "$@" ;;
  cleanup) cmd_cleanup ;;
  admin) cmd_admin ;;
  secret) shift; cmd_secret "$@" ;;
  *) sed -n "2,20p" "$0"; exit 1 ;;
esac
