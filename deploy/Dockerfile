# 课堂助手服务端镜像（含仪表盘静态资源构建）
# 构建期：全量安装依赖（better-sqlite3 原生二进制取 linux-x64 版，编译兜底工具已装）+ 构建前端
# 运行期：仅 Node 运行时，cwd = packages/server（与裸机部署行为一致：.env 与 SQLite data/ 均按 cwd 解析）
FROM node:22-slim AS build
# 国内网络适配：apt 换阿里云源（教育网源对公有云路由差）、npm 换 npmmirror（better-sqlite3 预编译包若 GitHub 拉取失败会自动退回源码编译，编译工具已装）
RUN sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9 --registry=https://registry.npmmirror.com \
 && echo "registry=https://registry.npmmirror.com" > /root/.npmrc
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @classroom/dashboard build

FROM node:22-slim
WORKDIR /app/packages/server
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
