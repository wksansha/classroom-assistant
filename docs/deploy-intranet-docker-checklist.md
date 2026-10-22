# 内网 Docker 部署清单（勾选式）

> 场景：内网完全隔离（不出外网），采用 Docker Compose 部署，全部物料在外网开发机制作后带内。
> 详细背景与命令见《内网部署指南》（deploy-intranet.md）与《公网云部署指南》踩坑实录（deploy-cloud.md §十）。

## A. 物料制作（Windows 开发机 + 百度云服务器协同，Windows 无需安装 Docker）

> 分工：**构建与镜像导出全部在百度云服务器完成**（有 Docker、有代码、有网络）；Windows 只负责下载与轻量制作。前置：Windows 已配好 SSH 别名 `baidu-cloud`（scp/ssh 通道）。

- [ ] **A1. 云服务器构建最新服务端镜像**（顺手把云上服务端也更新到最新）：

```bash
cd /opt/classroom/classroom-assistant
git pull
cd deploy && docker buildx bake -f docker-compose.yml --allow network.host && cd ..
docker compose -f deploy/docker-compose.yml up -d --no-build
```

- [ ] **A2. 云服务器确认 Gitea 镜像在**：`docker images | grep gitea`（没有则 `docker pull gitea/gitea:latest`）
- [ ] **A3. 云服务器导出镜像包**：

```bash
docker save -o /tmp/classroom-images.tar deploy-server:latest gitea/gitea:latest
```

- [ ] **A4. Windows 下载镜像包**：`scp baidu-cloud:/tmp/classroom-images.tar D:\ruan\`（约 400~600MB）
- [ ] **A5. Docker 离线安装包**（内网服务器未装时）：云服务器 `curl -LO https://download.docker.com/linux/static/stable/x86_64/docker-<版本>.tgz` + `docker-compose` v2 二进制 → scp 下载；或 Windows 浏览器下载（麒麟源 rpm 全家桶亦可）
- [ ] **A6. 内网版插件 vsix**：`vscode-pylearner` 的 `src/constants.ts` 第 41 行 `DEFAULT_TEACHER_URL` 改为 `http://<内网IP>:3000` → `npx @vscode/vsce package`（sync 脚本自动同步 package.json，勿手改 package.json）
- [ ] **A7. 花名册文本**（每行「学号 姓名」）
- [ ] **A8. 学生机离线包**：~~VS Code arm64~~（✅ 学生机已装好）+ Git arm64 离线包 + A6 的 vsix
- [x] **A9.（评审用）本地大模型**：✅ 已部署并验证（大模型服务器就绪）

## B. 内网服务器部署

- [ ] **B1. 装 Docker**（A5 包）+ systemd 自启 → `docker compose version` 验证
- [ ] **B2. 导入镜像**：`docker load -i classroom-images.tar` → `docker images` 应见两个
- [ ] **B3. 建目录**：`mkdir -p /opt/classroom && 放入 compose 文件与 .env`
- [ ] **B4. 写 `.env`**（LLM 三行**要填**，指向内网大模型）：

```ini
LLM_API_KEY=local
LLM_BASE_URL=http://<内网模型机IP>:11434/v1     # Ollama 示例；vLLM 则 :8000/v1
LLM_MODEL=qwen2.5:7b                            # 实际模型名
GITEA_URL=http://gitea:3000
GITEA_ADMIN_TOKEN=<占位，B7 回填>
GITEA_REPO=classroom/exercises
GITEA_PUBLIC_BASE=http://<内网IP>:3001
PORT=3000
```

- [ ] **B5. compose 文件**（用仓库 `deploy/docker-compose.yml`，**删掉 server 的 build: 整段**——内网不构建，只留 `image: deploy-server:latest`）
- [ ] **B6. 起容器**：`docker compose -f deploy/docker-compose.yml up -d` → `ps` 两个 Up
- [ ] **B7. Gitea 初始化**（网页 `http://<内网IP>:3001`）：SQLite3 → 管理员 → **建组织 `classroom` → 组织内建仓库 `exercises`（勾选初始化）** → 核对路径与 `GITEA_REPO` 一致 → 生成 token（**四项全读写**：admin/organization/repository/user）→ 回填 `.env` → 重启
- [ ] **B8. 导花名册**（`http://<内网IP>:3000/#/admin`）——**必须在 B7 之后**
- [ ] **B9. 防火墙**：`firewall-cmd --permanent --add-port={3000,3001}/tcp && firewall-cmd --reload`
- [ ] **B10. 本机验收**：`curl http://127.0.0.1:3000/api/summary` 出 JSON

## C. 教师机（内网）

- [ ] **C1. clone 内网仓库**：`git clone http://<内网IP>:3001/classroom/exercises.git`（铁律：仓库已在 B7 建好且路径一致）
- [ ] **C2. VS Code 写题**（模板：`#` 注释题面 + `# ===== 代码区 =====` 分隔）→ commit → push 即布置

## D. 学生机（arm64 麒麟）

- [ ] **D1. 学生机**：✅ VS Code 已装好 → 待装 Git + 内网版 vsix（A8）
- [ ] **D2. 身份页保存学号姓名** → 校验通过领凭证（零配置，地址已烤入）
- [ ] **D3. 拉取作业 → F5 运行（评审走内网大模型，✅/❌ 真实反馈）→ 提交作业** → Gitea 出现 `student-<学号>` 分支

## 常见坑速查

| 症状 | 翻文档 |
|---|---|
| 「彻底清除」403 / 镜像悬空 / 构建超时 | deploy-intranet.md §九 + deploy-cloud.md §十 |
| token 认证失败 | 四项权限 + 反引号检查（deploy-intranet.md §5.3） |
| 身份保存「服务器暂不可达」 | 扩展输出面板诊断行；Trae 代理坑见 deploy-cloud.md §十 |
| 铁律：仓库路径先于花名册定稿 | deploy-intranet.md §5.2 ⚠️ |
