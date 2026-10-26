# 课堂助手服务端镜像（含仪表盘静态资源构建）
# 构建期：全量安装依赖（better-sqlite3 原生二进制取 linux-x64 版，编译兜底工具已装）+ 构建前端
# 运行期：仅 Node 运行时，cwd = packages/server（与裸机部署行为一致：.env 与 SQLite data/ 均按 cwd 解析）
FROM node:22-slim AS build
# 国内网络适配：apt 换阿里云源（教育网源对公有云路由差）、npm 换 npmmirror（better-sqlite3 预编译包若 GitHub 拉取失败会自动退回源码编译，编译工具已装）
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9 --registry=https://registry.npmmirror.com \
 && echo "registry=https://registry.npmmirror.com" > /root/.npmrc
WORKDIR /app
# 分层缓存：先只拷清单文件装依赖（lockfile 不变则命中缓存），再按包拷源码
# 效果：只改 server 代码时，依赖安装与 dashboard 构建两层全部命中缓存，更新耗时从 3~5 分钟降到 1 分钟内
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# dashboard 构建单独成层：仅 dashboard/shared 源码变化时才重跑 vue-tsc + vite
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/dashboard packages/dashboard
RUN pnpm --filter @classroom/dashboard build
# server 源码放最后：改服务端代码不会触发上面任何重构建
COPY packages/server packages/server

FROM node:22-slim
WORKDIR /app/packages/server
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
