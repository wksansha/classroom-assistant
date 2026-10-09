#!/usr/bin/env bash
# 在 linux-x64 环境中运行（WSL2 或 Docker 均可），生成内网离线部署包。
#
# 开发机是 Windows 时，最方便的两种运行方式：
#   ① WSL2:  wsl bash deploy/make-bundle.sh        （WSL 里需装 node20+ 和 pnpm）
#   ② Docker: docker run --rm -v "$(pwd)":/repo -w /repo node:22 bash deploy/make-bundle.sh
#
# 原理：依赖必须在 linux-x64 环境里安装，better-sqlite3 与 esbuild 的
# 原生二进制才会取到 linux-x64 版本（服务器不能出网，无法现场下载）。
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. 全量安装依赖（dashboard 构建需要 devDeps）
pnpm install --frozen-lockfile

# 2. 构建前端静态产物（纯静态，服务器直接托管）
pnpm --filter @classroom/dashboard build

# 3. 裁掉 devDependencies，只留运行时依赖
pnpm prune --prod

# 4. 打包（排除密钥、数据库、日志、git 等）
OUT="${1:-../classroom-assistant-dist-$(date +%Y%m%d-%H%M).tar.gz}"
tar czf "$OUT" \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='.env' \
  --exclude='*.log' \
  --exclude='data' \
  --exclude='docs' \
  --exclude='coverage' \
  .
echo "打包完成: $OUT"
echo "内容 = 源码 + linux-x64 node_modules + dashboard/dist + deploy/ + docs/"
