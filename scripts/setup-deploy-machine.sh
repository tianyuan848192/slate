#!/usr/bin/env bash
# 部署机装环境（docs/deploy.md 第一部分第 3 步）：Amazon Linux 2023，arm64 或 x86_64。可以重复运行。
# 装 git、Docker、Node.js 22、Python 3.12 和 pip，启动 Docker，把当前用户加进 docker 组。
# x86_64 机器另外装 QEMU，用来构建 arm64 的会话镜像（慢几倍，推荐用 arm64 的部署机）。
set -euo pipefail
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

. /etc/os-release
[[ "${ID:-}" == "amzn" && "${VERSION_ID:-}" == "2023" ]] || die "这个脚本只支持 Amazon Linux 2023（现在是 ${PRETTY_NAME:-未知系统}）。其他系统请按 docs/deploy.md 手动装：git、Docker、Node.js 20 以上、Python 3.12 和 pip、AWS CLI v2"
SUDO=""; [[ "$(id -u)" == 0 ]] || SUDO="sudo"

say "安装 git、Docker、Node.js 22、Python 3.12"
$SUDO dnf install -y -q git docker nodejs22 nodejs22-npm python3.12 python3.12-pip tar gzip rsync
# nodejs22 装的命令叫 node-22、npm-22：没有 node、npm 这两个名字时补上
for b in node npm npx; do
  if ! command -v "$b" >/dev/null 2>&1 && command -v "$b-22" >/dev/null 2>&1; then
    $SUDO ln -sf "$(command -v "$b-22")" "/usr/local/bin/$b"
  fi
done
command -v aws >/dev/null || $SUDO dnf install -y -q awscli-2

say "启动 Docker"
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO systemctl start docker || true
if [[ "$(id -u)" != 0 ]] && ! id -nG | tr ' ' '\n' | grep -qx docker; then
  $SUDO usermod -aG docker "$(id -un)"
  RELOGIN=1
fi

if [[ "$(uname -m)" == "x86_64" ]]; then
  say "x86_64 机器：安装 QEMU，用来构建 arm64 镜像（会慢几倍）"
  $SUDO docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
fi

say "版本"
for b in git docker node npm python3.12 aws; do printf '  %-10s %s\n' "$b" "$("$b" --version 2>&1 | head -1)"; done
python3.12 -m pip --version >/dev/null || die "python3.12 没有 pip"
major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$major" -ge 20 ]] || die "Node.js 版本太低（$major），需要 20 以上"

echo
if [[ -n "${RELOGIN:-}" ]]; then
  say "装好了。还差一步：重新登录一次，让 docker 组的权限生效（exit 以后再 sudo su - $(id -un)），然后运行 ./deploy.sh check"
else
  say "装好了。下一步：./deploy.sh check"
fi
