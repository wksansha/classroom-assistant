# 内网部署指南（x86_64 Linux 服务器）

场景：服务器在隔离内网（不能出外网），已部署本地大模型；教师机与学生机均为麒麟系统（服务器 x86_64，学生机 arm64）。监控流走扩展上报；作业走学生分支直连模型——教师 push Gitea main 即布置，学生端扩展代执行本机 git 直连 Gitea 拉取/提交，服务端旁路化（notify 轻量索引 + F5 评审 + 实时监控），教师端浏览器打开仪表盘。

> 与《内网离线开发环境手册》（Verdaccio npm 私服 :4873 / PyPI 镜像 :8080 / ARM Node 运行时）的关系：
> 基础设施按该手册搭建，**本项目应用本身推荐用第二节的独立部署包**（自带 linux-x64 node_modules，不依赖私服内容）。
> 想改走私服安装见第二节方式 C 的兼容性清单。学生端的 Python 包安装走 PyPI 镜像，与本应用无关。

```text
学生机 ×N ──HTTP 上报/拉作业──▶ ┌─────────────────────┐ ◀──浏览器 http://IP:3000── 教师机
（VS Code 扩展，     │  内网 x86 服务器     │──本地调用──▶ 本地大模型服务
 无需装 Node）       │  Node.js + SQLite   │
                     │  + Gitea :3001      │◀──git push 出题──── 教师机（麒麟）
                     └─────────────────────┘
```

## 一、服务器装 Node.js（离线）

在有外网的机器上下载 linux-x64 的 tar 包（Node 22 LTS 推荐）：

> <https://nodejs.org/dist/latest-v22.x/> → `node-v22.x.x-linux-x64.tar.xz`

拷到服务器后解压到 `/opt/classroom/node`：

```bash
mkdir -p /opt/classroom
tar -xJf node-v22.x.x-linux-x64.tar.xz -C /opt/classroom
mv /opt/classroom/node-v22.x.x-linux-x64 /opt/classroom/node
/opt/classroom/node/bin/node -v   # 验证
```

## 二、制作离线部署包（开发机 Windows 上做）

服务器不能出网，而 `better-sqlite3`、`esbuild` 含平台原生二进制 —— **依赖必须在 linux-x64 环境安装**，直接把 Windows 的 node_modules 拷过去是跑不起来的。两种方式任选：

```bash
# 方式 A：Docker（一行命令，推荐）
docker run --rm -v "$(pwd)":/repo -w /repo node:22 bash deploy/make-bundle.sh

# 方式 B：WSL2（内部需已装 node20+ 与 pnpm）
wsl bash deploy/make-bundle.sh
```

脚本产出 `classroom-assistant-dist-<日期>.tar.gz`（源码 + linux-x64 node_modules + dashboard/dist）。

> 备选：若服务器能访问内网 npm 镜像源（麒麟软件源/自建 Verdaccio），也可在服务器上直接 `pnpm install --frozen-lockfile`，省去打包。

### 方式 C：用内网 Verdaccio 私服安装（备选）

可行，但《内网离线开发环境手册》的预同步清单（`npm-presync-package.json`）与本项目的依赖有差异，需先在**外网准备机**补充同步（且要针对服务器架构 x64，手册脚本默认 arm64）：

| 差异 | 手册预同步清单 | 本项目需要 | 处理 |
|---|---|---|---|
| express | ^4.21 | **^5.2.1**（大版本不同） | 补同步 `express@5.2.1` |
| better-sqlite3 | **缺失** | ^13.0.3 | 补同步；且其预编译二进制在安装时从 GitHub 下载——离线私服装它会退回源码编译，**服务器需 gcc/make/python3**；否则回到方式 A/B |
| esbuild | ^0.21 | ^0.25（vite 7 / tsx 4.19 要求） | 补同步（tsx 依赖链会自动带上） |
| dotenv / vitest | ^16.4 / ^2.0 | ^17.4 / ^3.0 | 补同步（vitest 仅开发用，服务器可不需要） |
| 架构 | `--cpu=arm64` | 服务器 x86 → `--cpu=x64 --os=linux` | 用手册 `06-add-npm-package.sh` 前先改导出的环境变量 |

结论：**方式 A/B 的独立部署包一次打包、零私服依赖，仍为首选**；方式 C 适合后续要在内网反复改代码重装依赖时再补齐。

## 三、服务器部署

```bash
# 1. 解压部署包
mkdir -p /opt/classroom && tar xzf classroom-assistant-dist-*.tar.gz -C /opt/classroom

# 2. 配置环境变量（见下方「本地大模型接入」）
cd /opt/classroom/packages/server
cp .env.example .env && vim .env

# 3. 先手动跑一次验证
/opt/classroom/node/bin/node --import tsx src/main.ts
# 看到 [Server] 三行横幅 + server.startup 日志即成功，Ctrl+C 退出

# 4. 注册 systemd 服务（开机自启 + 崩溃自动重启）
cp /opt/classroom/deploy/classroom-server.service /etc/systemd/system/
# 若解压路径不是 /opt/classroom，编辑 unit 内的路径；建议用专用用户跑：
#   useradd -r -s /sbin/nologin classroom && chown -R classroom /opt/classroom
#   并把 unit 中 User/Group 放开
systemctl daemon-reload
systemctl enable --now classroom-server
systemctl status classroom-server

# 5. 防火墙放行（麒麟/firewalld）
firewall-cmd --permanent --add-port=3000/tcp && firewall-cmd --reload
```

## 四、本地大模型接入（.env）

服务端走 OpenAI 兼容协议（`/chat/completions`），常见本地部署方式对应：

**Ollama：**

```ini
LLM_API_KEY=local                 # 本地服务不校验 key，但必须非空（空 = 走 mock 规则）
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:7b              # ollama list 里实际存在的模型名
```

**vLLM：**

```ini
LLM_API_KEY=EMPTY
LLM_BASE_URL=http://127.0.0.1:8000/v1
LLM_MODEL=<启动时 --served-model-name 指定的名字>
```

> 大模型部署在另一台内网机器时，把 `127.0.0.1` 换成那台机器的 IP。
> 改完 .env 必须 `systemctl restart classroom-server`。
> 三层缓存（内存→SQLite→LLM）：同一错误只调一次模型，日志没有 llm.request_started 不代表没生效。

## 五、作业系统（Gitea 仓库 + .env 配置）

作业走学生分支直连模型，仍推荐在服务器上自建 **Gitea**（单个 Go 静态二进制，SQLite 存储，麒麟 x86_64 直接运行，无外部依赖）：教师经网页/PyCharm push 题目到 main（push 即布置）；学生端扩展代执行本机 git，用每生专属凭证直连 Gitea 拉取/提交，**服务端不 clone 任何仓库**。学生机需安装 Git（扩展启动时探测并给安装引导）；Gitea 账号由花名册导入时服务端联动自动创建，学生零感知。

### 1. 离线安装 Gitea

外网准备机下载单文件二进制（注意与服务器架构匹配，x86_64 选 amd64）：

> https://dl.gitea.com/gitea/release/latest/ → `gitea-<版本>-linux-amd64`

拷入服务器后：

```bash
sudo mkdir -p /opt/classroom/gitea/{custom,data,log}
sudo mv gitea-*-linux-amd64 /opt/classroom/gitea/gitea
sudo chmod +x /opt/classroom/gitea/gitea
sudo useradd -r -s /sbin/nologin gitea
sudo chown -R gitea:gitea /opt/classroom/gitea
```

systemd unit `/etc/systemd/system/gitea.service`：

```ini
[Unit]
Description=Gitea
After=network.target

[Service]
User=gitea
Group=gitea
WorkingDirectory=/opt/classroom/gitea
ExecStart=/opt/classroom/gitea/gitea web --port 3001
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now gitea
sudo firewall-cmd --permanent --add-port=3001/tcp && sudo firewall-cmd --reload
```

### 2. 初始化（浏览器 http://<服务器IP>:3001）

> ⚠️ **铁律：仓库路径必须在「导入花名册」之前定稿**——导入时会按 `.env` 的 `GITEA_REPO` 创建分支保护、添加学生协作者，路径不一致这些步骤会全部静默失败（公网部署实测踩坑：建在个人名下导致 404）。

1. 安装向导：数据库选 **SQLite3**，其余默认
2. 安装页底部「管理员账号设置」创建教师管理员账号
3. 管理员登录 → 右上角 **+** → **新建组织** → 名称 `classroom`
4. 进入组织 → 新建仓库 → 名称 `exercises` → **勾选「初始化仓库」** → 创建
5. 核对浏览器地址栏路径正好是 `<服务器IP>:3001/classroom/exercises`，且与 `.env` 的 `GITEA_REPO=classroom/exercises` 一致
6. **以上完成之后**才进行第四节的「导入花名册」

### 3. Gitea 管理员 token（花名册联动建号用）

服务端在花名册导入时联动 Gitea 管理员 API 批量建号（用户名 = 学号）+ 逐分支配保护规则 + 自动加仓库协作者，需要管理员 token：

1. 管理员登录 → 设置 → 应用 → 生成 **token**——**权限四项全部选「读写」：admin / organization / repository / user**（缺 user 会导致服务端身份核验类调用被拒；缺写权限会导致 purge 删分支/删账号 403）
2. 复制 token 后**检查首尾**：粘贴过程中聊天窗口/网页可能带进反引号 `` ` `` 或引号——`.env` 里必须只有纯字母数字（可用 `grep -c '^GITEA_ADMIN_TOKEN=[A-Za-z0-9]*$' .env` 验证，输出 1 = 干净）

`/opt/classroom/packages/server/.env` 增加：

```ini
GITEA_URL=http://127.0.0.1:3001
GITEA_ADMIN_TOKEN=<上一步生成的 token>
GITEA_REPO=classroom/exercises
```

改完 `systemctl restart classroom-server`。

### 4. 教师出题流程（教师机，麒麟）

```bash
sudo apt install git          # 或 yum install git，按麒麟版本
git config --global core.autocrlf input
git clone http://<服务器IP>:3001/classroom/exercises.git
cd exercises
```

1. 新建任意名一级子目录（如 `lesson5/`），放题文件：文件内 `#` 注释写题面，`# ===== 代码区 =====` 后写学生初始代码（LLM 评审以文件内题面注释为锚点，无需手写 exercise-id）
2. PyCharm/Trae 里 commit → push（**push 即布置**，学生「拉取作业」即发布闸门；已推文件/目录不再修改与改名，只新增）
3. 仪表盘 `#/admin` → 导入花名册（每行「学号 姓名」，联动自动建 Gitea 账号与分支保护）

### 5. 验收

- 教师推新目录后，学生扩展「拉取作业」能拉到新文件
- 学生提交后 Gitea 仓库出现 `student-<学号>` 分支，且该分支仅对同学号账户可写（分支保护）
- 服务端日志出现 `db.insert_event` 与评审链路日志；SQLite 中 `trace_events` 表出现该生记录（`docker exec classroom-server node -e "..."` 或 sqlite3 查询，只读）

> 历史注意：`/api/submissions/*` 接口已随 notify 机制退役（设计上返回 404），验收以日志与 Gitea 分支为准。

## 六、验收清单

```bash
# 1. 服务存活 + 快照接口
curl http://127.0.0.1:3000/api/summary

# 2. 模拟上报一条错误事件（flat 格式，与扩展一致）
curl -X POST http://127.0.0.1:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{"student_id":"s001","student_name":"张三","class_id":"3A","event_type":"run","success":false,"error_type":"NameError","error_message":"name '\''x'\'' is not defined","raw_message":"name '\''x'\'' is not defined"}'

# 3. 看日志确认链路（另一个终端）
journalctl -u classroom-server -f
# 应出现 route.event_received → llm.request_started（本地模型）→ state.new_record → route.event_processed
```

教师端浏览器：`http://<服务器IP>:3000/` —— 刚上报的学生应出现在「优先帮助」里。

## 七、学生端配置

学生机（麒麟 arm64）只需 VS Code + vscode-pylearner 扩展，全部离线安装：

1. **VS Code**：外网准备机下载 **linux-arm64** 版（rpm/deb 或 tar.gz，注意匹配麒麟的 glibc 版本），拷入内网安装
2. **扩展**：准备机从 marketplace 下载 `vscode-pylearner` 的 `.vsix` 文件拷入，学生机执行：
   `code --install-extension vscode-pylearner-<版本>.vsix`
3. **扩展默认地址 = 打包时烤入的内网服务器地址，学生零配置**。打包内网版：开发机 `vscode-pylearner` 项目里把 `src/constants.ts` 第 41 行 `DEFAULT_TEACHER_URL` 改为 `http://<服务器IP>:3000`（`package.json` 默认值由打包脚本自动同步，勿手改），再 `npx @vscode/vsce package`。特殊环境仍可用设置 `pylearner.teacher.url` 覆盖
4. 无需装 Node 或其他依赖（扩展本身是纯 JS）；学生跑 Python 代码所需的第三方包走 PyPI 镜像（手册 :8080）

## 八、日常运维

| 事项 | 命令/位置 |
|---|---|
| 看日志 | `journalctl -u classroom-server -f`（结构化 JSON，事件名见 docs/） |
| Gitea 运维 | `journalctl -u gitea -f` / `systemctl restart gitea`；仓库数据在 `/opt/classroom/gitea/data` |
| 数据备份 | SQLite 在 `packages/server/data/assistant.db`（WAL 模式），停服或用 sqlite3 `.backup` 拷贝 |
| 改配置 | 编辑 .env → `systemctl restart classroom-server` |
| 升级版本 | 开发机重新打部署包 → 解压覆盖 → 重启（数据库文件别覆盖） |
| LOG_LEVEL | 默认 info；排查问题时 .env 设 `LOG_LEVEL=debug` 显示全链路事件 |

## 九、常见问题

- **日志只有 `llm.mock_fallback (no_api_key)`** → .env 里 LLM_API_KEY 为空，或没重启服务
- **`llm.mock_fallback (reason: api_error)`** → 本地模型地址/模型名不对；先 `curl http://127.0.0.1:11434/v1/models` 验证服务通不通
- **浏览器打不开 3000** → 防火墙没放行，或服务器只监听了 localhost（默认全接口监听，一般不会）
- **better-sqlite3 报 ABI/平台错误** → 部署包不是在 linux-x64 环境里制作的，回到第二节重新打包
- **花名册导入后学生身份校验报错/无法拉取** → 看 `journalctl -u classroom-server` 是否有 `gitea.provision_failed`：GITEA_URL/GITEA_ADMIN_TOKEN/GITEA_REPO 配置错误或 token 权限不足
- **管理页「彻底清除」报 403 / 分支删不掉** → Gitea 28 的保护规则对象无 `id` 字段，旧版服务端按 id 删会 404 被容错跳过（规则残留 → 删分支 403）——该 bug 已在仓库代码修复（改按 rule_name 删），重新打部署包即可；应急可手动 `DELETE /api/v1/repos/<owner>/<repo>/branch_protections/<rule_name>`
- **token/URL 配置项里有反引号或引号** → 从聊天窗口/网页复制时被格式污染（高频坑）。`.env` 所有值必须纯文本：`grep -n '\`' .env` 有输出即中招，逐行清理后重启服务端
- **Gitea 页面打不开 3001** → `systemctl status gitea` 看服务状态，防火墙没放行 3001 也会如此
