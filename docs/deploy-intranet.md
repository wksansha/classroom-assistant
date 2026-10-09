# 内网部署指南（x86_64 Linux 服务器）

场景：服务器在隔离内网（不能出外网），已部署本地大模型；学生机（麒麟 arm64）跑 VS Code 扩展上报；教师端浏览器打开仪表盘。

> 与《内网离线开发环境手册》（Verdaccio npm 私服 :4873 / PyPI 镜像 :8080 / ARM Node 运行时）的关系：
> 基础设施按该手册搭建，**本项目应用本身推荐用第二节的独立部署包**（自带 linux-x64 node_modules，不依赖私服内容）。
> 想改走私服安装见第二节方式 C 的兼容性清单。学生端的 Python 包安装走 PyPI 镜像，与本应用无关。

```text
学生机 ×N ──HTTP POST /api/events──▶ ┌──────────────────┐ ◀──浏览器 http://IP:3000── 教师机
（VS Code 扩展，     │  内网 x86 服务器  │
 无需装 Node）       │  Node.js + SQLite │──本地调用──▶ 本地大模型服务
                     └──────────────────┘            （OpenAI 兼容接口）
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

## 五、验收清单

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

## 六、学生端配置

学生机（麒麟 arm64）只需 VS Code + vscode-pylearner 扩展，全部离线安装：

1. **VS Code**：外网准备机下载 **linux-arm64** 版（rpm/deb 或 tar.gz，注意匹配麒麟的 glibc 版本），拷入内网安装
2. **扩展**：准备机从 marketplace 下载 `vscode-pylearner` 的 `.vsix` 文件拷入，学生机执行：
   `code --install-extension vscode-pylearner-<版本>.vsix`
3. 扩展设置里把上报地址改为 `http://<服务器IP>:3000/api/events`
4. 无需装 Node 或其他依赖（扩展本身是纯 JS）；学生跑 Python 代码所需的第三方包走 PyPI 镜像（手册 :8080）

## 七、日常运维

| 事项 | 命令/位置 |
|---|---|
| 看日志 | `journalctl -u classroom-server -f`（结构化 JSON，事件名见 docs/） |
| 数据备份 | SQLite 在 `packages/server/data/assistant.db`（WAL 模式），停服或用 sqlite3 `.backup` 拷贝 |
| 改配置 | 编辑 .env → `systemctl restart classroom-server` |
| 升级版本 | 开发机重新打部署包 → 解压覆盖 → 重启（数据库文件别覆盖） |
| LOG_LEVEL | 默认 info；排查问题时 .env 设 `LOG_LEVEL=debug` 显示全链路事件 |

## 八、常见问题

- **日志只有 `llm.mock_fallback (no_api_key)`** → .env 里 LLM_API_KEY 为空，或没重启服务
- **`llm.mock_fallback (reason: api_error)`** → 本地模型地址/模型名不对；先 `curl http://127.0.0.1:11434/v1/models` 验证服务通不通
- **浏览器打不开 3000** → 防火墙没放行，或服务器只监听了 localhost（默认全接口监听，一般不会）
- **better-sqlite3 报 ABI/平台错误** → 部署包不是在 linux-x64 环境里制作的，回到第二节重新打包
