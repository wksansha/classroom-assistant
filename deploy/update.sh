#!/usr/bin/env bash
# 课堂助手云服务器一键更新：拉取 → 构建（带 network.host 授权）→ 启动 → 状态确认
# 用法：bash deploy/update.sh   （在服务器仓库的任意位置执行均可）
set -e
cd "$(dirname "$0")/.."   # 仓库根

echo "==> git pull"
git pull origin main

echo "==> buildx bake（compose up --build 不支持透传 network.host 授权，必须走 bake）"
cd deploy
docker buildx bake -f docker-compose.yml --allow=network.host --allow=fs.read=..

echo "==> compose up"
cd ..
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps

echo "==> 完成。验证：curl http://localhost:3002/api/summary"
