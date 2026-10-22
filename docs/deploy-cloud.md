# 公网云部署指南（百度云 · 学生家庭练习环境）

场景：内网生产环境（见《内网部署指南》）**不退役**，另在百度云服务器部署一份**学生家庭练习环境**。学生在没有内网的电脑（家庭机）上拉题、交题、练习；课堂数据与家庭练习数据物理隔离，互不影响。

> 与内网部署的核心差异：云服务器可直连公网（无需离线打包），**全程 Docker Compose 部署，宿主机只需装 Docker**；**不配置 LLM**（评审走 mock 兜底、聊天不可用）；无 HTTPS（纯 IP 无备案域名）；无管理端鉴权（见「安全与已知限制」）。

```text
学生家庭机（公网，独立电脑）──扩展 teacher.url 指云──▶ ┌──────────────────────┐
  git 直连 ────────────────────────────────────────▶ │ 百度云（公网 IP）        │
                                                     │  服务端 :3000          │
                                                     │  Gitea  :3001         │──▶ 无 LLM
                                                     └──────────────────────┘
内网全套（服务器/Gitea/大模型）不动，两套环境完全隔离
```

## 一、定位与边界

| 项 | 云上环境 |
|---|---|
| 学生能做什么 | 身份校验领凭证、拉取作业、提交作业、L1 练习数据入库、Gitea 网页查看 |
| 学生不能做什么 | **AI 评审**（F5 触发后返回「评审服务不可用」，不会给出误判结果）、**AI 聊天**（代理无上游，请求失败） |
| 题目来源 | 云侧在外网产出：U 盘摆渡 + 网页上传，或在家 clone 直推（见第六节），与内网 main 各自独立 |
| 学生分支 | 云 Gitea 上的 `student-<学号>` 分支独立存在，与内网同名分支**互不同步**（两台电脑各做各的，天然无冲突） |
| 花名册 | 教师在云上导入同一份文本，云 Gitea 重新建号，密码独立 |
| 服务端职责 | **仅身份校验 / 联动建号 / 凭证下发**（拉取提交的前置依赖）；仪表盘仅作花名册导入入口，监控/聚合在云上无意义，不用管 |

## 二、前置：百度云安全组（最容易漏的一步）

百度云控制台 → 云服务器 → 安全组，放行**仅以下两个端口**（其余默认全关）：

| 端口 | 用途 |
|---|---|
| 3000/tcp | 服务端（扩展上报/身份校验/拉题接口） |
| 3001/tcp | Gitea（git 拉取/提交 + 网页） |

> SSH(22) 保持默认。服务器系统内 firewalld 也需放行同样端口（见下文命令）。

## 三、安装 Docker（宿主机唯一依赖）

```bash
# CentOS/openEuler/麒麟系（任选其一）
sudo dnf install -y docker                       # 发行版仓库
# curl -fsSL https://get.docker.com | bash        # 或官方脚本（版本更新）

sudo systemctl enable --now docker
docker -v && docker compose version              # compose v2 为 compose 子命令；若只有 docker-compose v1 也可用
```

## 四、获取代码与配置 .env

```bash
sudo mkdir -p /opt/classroom && cd /opt/classroom
sudo git clone https://github.com/wksansha/classroom-assistant.git
cd classroom-assistant
```

创建 `packages/server/.env`（**GITEA_ADMIN_TOKEN 先留占位**，第五节 Gitea 初始化后再回来填）：

```ini
# LLM：刻意留空 —— 评审走 mock 兜底（返回「评审服务不可用」，无误判风险），聊天代理无上游
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=

# Gitea：容器内由 compose 覆盖为 http://gitea:3000，这里无需关心
GITEA_URL=http://127.0.0.1:3001
GITEA_ADMIN_TOKEN=<第五节生成的 token>
GITEA_REPO=classroom/exercises
GITEA_PUBLIC_BASE=http://<公网IP>:3001

PORT=3000
```

## 五、一键部署（Gitea + 服务端）

```bash
# 构建（buildx bake：build 段声明了 network:host，需授权；compose 版本不支持 --allow 透传时走这条）
cd deploy && docker buildx bake -f docker-compose.yml --allow network.host && cd ..
# 启动
docker compose -f deploy/docker-compose.yml up -d --no-build
sudo firewall-cmd --permanent --add-port={3000,3001}/tcp && sudo firewall-cmd --reload
docker compose -f deploy/docker-compose.yml ps    # 两个容器均 Up 即成功
```

compose 做了什么：构建服务端镜像（build 走宿主网络绕开容器出网限制；apt 用阿里 http 源 + npmmirror，better-sqlite3 编译兜底内置；`image: deploy-server:latest` 显式命名防悬空镜像）→ 拉起 Gitea 与服务端，端口 3001/3000 映射宿主，数据落 `deploy/data/`，`restart: unless-stopped` 开机自启。

> ⚠️ 若同机 3000 端口被其他服务占用（如已有 new-api）：把 compose 里 server 的端口映射改为 `"3002:3000"`，安全组同步放行 3002，`.env` 之外无需其他改动。

Gitea 初始化（浏览器 `http://<公网IP>:3001`）：

> ⚠️ **铁律：仓库路径必须在「导入花名册」之前定稿**——导入时按 `.env` 的 `GITEA_REPO` 创建分支保护、添加学生协作者，路径不一致这些步骤会全部失败（须重导花名册修复）。

1. 安装向导：数据库 **SQLite3**，其余默认
2. 底部「管理员账号设置」创建教师管理员账号（密码自设，用于推题与生成 token）
3. 管理员登录 → 右上角 **+** → **新建组织** `classroom` → 组织内**新建仓库** `exercises`（勾选初始化）→ 核对路径 = `<公网IP>:3001/classroom/exercises`，与 `GITEA_REPO=classroom/exercises` 一致
4. 管理员 → 设置 → 应用 → 生成 token——**权限四项全部「读写」：admin / organization / repository / user**（缺 user 会 401；缺写权限 purge 会 403）→ 复制时**检查首尾无反引号/引号** → **回填 `.env` 的 GITEA_ADMIN_TOKEN → `docker compose -f deploy/docker-compose.yml up -d --no-build` 重建服务端容器生效**

## 六、教师配置

### 1. 导入花名册（联动建号）

浏览器 `http://<公网IP>:3000/#/admin` → 导入花名册（每行「学号 姓名」，与内网同一份文本）→ 云 Gitea 自动批量建号 + 分支保护。**学生凭证与内网无关，由学生外网电脑首次身份校验时领取。**

### 2. 题目同步（二选一，或组合）

> 前提事实：内网与外网完全隔离，**不存在既连内网又连外网的电脑**——云侧题目在外网侧产出，与内网出题互不相干。

**方式 A：文件摆渡 + 云网页上传（推荐，零 git）**

1. 内网机出题（现状不变，推内网 Gitea）
2. 题目目录（几个 `.py` 文本文件）拷 U 盘 / 微信文件传输助手带出
3. 任意外网电脑浏览器打开 `http://<公网IP>:3001` → `classroom/exercises` → 网页上传，按同样目录结构传（`#` 注释题面 + `# ===== 代码区 =====` 分隔，规范与内网一致）

**方式 B：在家出题直推云（教师熟 Git）**

家庭电脑直接 clone 云仓库出题：

```bash
git clone http://<公网IP>:3001/classroom/exercises.git
# 新建一级子目录放题文件 → commit → push（push 即在云侧布置）
```

即：内网侧的题在内网机出，云侧的题在家出，两边各自产出无需摆渡。

> 出题清单加一步「确认云侧已有本题」；忘记传云 = 学生在家拉不到新题。已推文件不可改名/移动（与内网规范一致）。

## 七、学生使用（家庭机，一次性配置）

1. 安装 VS Code + Git（[git-scm.com](https://git-scm.com)）+ 扩展 vsix（**云版 1.0.0**：`src/constants.ts` 默认地址已指向云服务器，学生零配置）
2. 扩展身份页输入学号姓名 → 校验通过自动领取云上 Git 凭证 + 作业仓库地址
3. 「拉取作业」拉题 → 练习 → 「提交作业」归档到云上 `student-<学号>` 分支
4. F5 运行成功触发的评审在云上**完全静默**（未配置 LLM，不弹任何提示）；AI 聊天在云上不可用（如需可自行把聊天 provider 切换为本地/自有 API）

## 八、安全与已知限制

| 项 | 说明 |
|---|---|
| 无管理端鉴权 | `#/admin` 与管理接口裸奔公网。被恶意 purge 的概率低；应急 = 重新导入花名册 + 学生重新校验（家庭练习分支会丢）。缓解：安全组已收口至服务端/Gitea 端口；可选改高位端口进一步降低扫描命中 |
| HTTP 明文 | 凭证/事件明文传输（纯 IP 无法签正规证书）。升级路径：域名备案后反代 HTTPS，学生仅需改 `teacher.url` 前缀 |
| 数据分叉 | 家庭练习与课堂提交分别存两套 Gitea，不同步；教师查提交时注意区分看哪套 |
| 身份可猜 | 身份校验无验证码，学号+姓名可被猜中领凭证——但分支保护限定只能写本人分支，危害限于污染本人练习数据 |

## 九、验收清单

```bash
curl http://127.0.0.1:3000/api/summary          # 服务存活
# 云 Gitea 网页：花名册导入后出现 student-<学号> 账号与分支保护
```

家庭机验收：

- 身份校验通过，状态栏显示姓名
- 「拉取作业」能拉到教师推的题目文件
- 「提交作业」后云 Gitea `student-<学号>` 分支出现提交，且非本人账号不可写
- F5 运行成功 → **无任何评审弹窗**（云上未配置 LLM，静默属预期；无 pass/fail 误判）
- 日志 `docker logs -f classroom-server` 出现 `db.insert_event`（L1 入库正常）

## 十、部署踩坑实录（2026-10-21/22 实测，均已修复或内置）

| 坑 | 现象 | 预防/修复 |
|---|---|---|
| **复制粘贴污染**（高频） | `.env` 的 URL/token 带反引号 `` ` `` 或引号 → 下发仓库地址损坏、token 认证失败 | 从聊天/网页复制任何配置后**检查首尾**；`grep -n '\`' packages/server/.env` 有输出即中招，`sed -i 's/\`//g'` 清理后重启 |
| **token 权限不全** | 管理页「彻底清除」报 403（删分支被拒） | 生成 token 时 **admin / organization / repository / user 四项全部「读写」**（缺 user 401，缺写 403） |
| **Gitea 28 保护规则无 id 字段** | purge 删保护 404 被容错跳过 → 规则残留 → 删分支 403 | 已在代码修复（按 rule_name 删，commit b3f1a3d）；应急手动 `DELETE /api/v1/repos/<owner>/<repo>/branch_protections/<rule_name>` |
| **构建容器出不了网** | apt/npm 连任何镜像源都超时（宿主机 git clone 却正常） | compose build 已内置 `network: host`；需授权时 `docker buildx bake -f deploy/docker-compose.yml --allow network.host`（在 deploy 目录内执行） |
| **国内镜像源不可达** | deb.debian.org/清华源超时；阿里 https 源证书失败（slim 镜像无系统 CA） | Dockerfile 已内置：apt 用 **http 阿里源** + 补装 ca-certificates，npm 用 npmmirror |
| **镜像悬空** | bake 构建成功但 `up` 报 No such image | compose 已显式 `image: deploy-server:latest`；应急 `docker tag <镜像id> deploy-server:latest` |
| **同机端口冲突** | 3000 被同机其他服务（如 new-api）占用 → 容器起不来 | compose 里 server 端口映射改 `"3002:3000"`，安全组同步放行 |
| **Trae 系统代理劫持** | 家庭机浏览器通、插件报「服务器暂不可达」；服务器日志无请求 | Trae 设置：`"trae.network.proxy.effectiveMode": "off"` + `"http.proxySupport": "off"`（改文件需**先杀干净 Trae 进程**，运行中改会被覆写）；残留系统代理清理由：`Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyServer` |

## 十一、日常运维

| 事项 | 命令/位置 |
|---|---|
| 日志 | `docker logs -f classroom-server` / `docker logs -f classroom-gitea` |
| 数据备份 | 整目录拷走 `deploy/data/`（含 SQLite 与 Gitea 仓库/账号，容器停机时拷最稳） |
| 升级版本 | `cd /opt/classroom/classroom-assistant && git pull && cd deploy && docker buildx bake -f docker-compose.yml --allow network.host && cd .. && docker compose -f deploy/docker-compose.yml up -d --no-build` |
| 改配置 | 编辑 `packages/server/.env` → `docker compose -f deploy/docker-compose.yml up -d`（重建服务端容器生效） |
