# 插件云分发：服务端版本清单 + 学生端一键更新（待实施）

> 状态：**方案已定稿，未实施**（2026-11-02 定稿）。
> 背景：插件（vscode-pylearner）每次更新需教师手动把 `.vsix` 发给学生、学生手动「从 VSIX 安装」，沟通与操作成本高。利用已有的课堂服务器（公网 `120.48.112.26:3002` / 内网 `192.168.1.254:3000`，即 `pylearner.teacher.url`）托管插件安装包，学生在插件内一键更新。
> 内网与公网**代码保持一致**，环境差异仅收敛到服务器上放置的文件与 `pylearner.teacher.url` 配置（延续事件降噪方案的既定原则）。

## 目标

1. 教师更新插件 = 替换服务器上两个文件（`.vsix` + `manifest.json`），无需再手动分发
2. 学生更新插件 = 收到通知点一下「立即更新」，全自动下载安装，无需学习成本
3. 更新检查失败静默（服务器不可达/无清单一律不打扰上课）
4. 内网与公网同一份插件代码：插件只认 `pylearner.teacher.url`，两环境各自在自己服务器上放对应版本线的包

## 方案一：服务端版本清单 + 静态托管（classroom-assistant）

### 内容

服务端新增两条路由（`packages/server/src/index.ts`，无新依赖）：

| 路由 | 行为 |
|---|---|
| `GET /api/pylearner/latest` | 读 `public/downloads/pylearner/manifest.json` 原样返回 JSON；文件缺失/非法 → 404 |
| `GET /downloads/pylearner/*` | `express.static` 托管同目录（`.vsix` 安装包） |

`manifest.json` 结构（教师更新插件时手写/复制模板）：

```json
{
  "version": "1.0.9",
  "file": "vscode-pylearner-1.0.9.vsix",
  "notes": "修复 xxx"
}
```

- 插件端自行拼下载地址：`<teacher.url>/downloads/pylearner/<file>`；`file` 仅允许 `[A-Za-z0-9._-]+`（防路径穿越），插件端校验
- 目录缺省解析为 `packages/server/public/downloads/pylearner`（Docker 运行时 cwd 语义与 SQLite `data/` 一致）；Docker 经卷挂载 `./data/server/downloads`，**教师更新插件不重建镜像**
- 路由恒注册（不因目录不存在而跳过）：目录缺失时请求 404，插件端静默忽略——服务器未放包时行为与今天完全一致
- 测试注入：`createApp` 新增 `downloadsDir` 可选参数（与 `staticDir` 同风格）

### 安全

- `manifest.json` 与静态目录均**只读**用途，无写接口；包文件只能由教师登服务器放置
- 插件端硬校验：下载地址必须与 `pylearner.teacher.url` 同源（manifest 只下发文件名，不存在跨域跳转面）
- `file` 字段白名单字符校验，杜绝 `../` 路径穿越

## 方案二：插件端启动检查 + 一键更新（vscode-pylearner）

### 触发时机

- 激活后延迟 **30 秒**检查一次（避开启动高峰与首启身份引导弹窗）；每窗口会话至多一次，不轮询、失败不重试
- 教师在课间/课前更新服务器包，学生下次启动 VS Code 即收到提示——无需实时推送

### 检查逻辑（`src/update/updateChecker.ts`，不 import vscode，可单测）

```
GET {teacher.url}/api/pylearner/latest   （10s 超时）
  ├─ 非 200 / 解析失败 / 字段缺失 → 返回 null（静默）
  ├─ file 不匹配白名单正则 → 返回 null（静默）
  ├─ 版本比较：candidate ≤ 当前版本 → 返回 null（无需更新）
  └─ 返回 { version, downloadUrl, notes }
```

- 当前版本取 `vscode.extensions.getExtension("deeptutor.vscode-pylearner").packageJSON.version`（单一事实来源，无硬编码）
- 版本比较：按 `.` 分段逐段数值比较（`1.10.0 > 1.9.0`）；段数不齐短侧补 0；非数字段视为不等长字符串比较的兜底

### 一键更新流程

```
通知「Python Learner 有新版本 x.x.x：notes」+ 按钮「立即更新」
  └─ 点击 → withProgress 下载 vsix 到系统临时目录（~240KB，内存缓冲）
           → executeCommand("workbench.extensions.action.installVSIX", fileUri)
           → 提示「已安装新版本，重新加载窗口后生效」+ 按钮「重新加载」
              └─ 点击 → executeCommand("workbench.action.reloadWindow")
```

- 下载/安装失败 → 错误通知一次（含原因），不再重试
- 不点「立即更新」→ 本次会话不再打扰，下次启动再检查
- 学生文案不出现专业术语（延续用户偏好）："更新"而非 "VSIX/installVSIX"

## 发布流程（教师操作，两环境相同）

1. 本地打包：`npm run vscode:prepublish && vsce package`（产出 `vscode-pylearner-x.y.z.vsix`）
2. 上传 `.vsix` 到服务器 `deploy/data/server/downloads/pylearner/`
3. 同目录更新 `manifest.json`（version/file/notes 三个字段）
4. 完成——学生下次启动自动收到更新提示

公网版本线 `1.0.x`（DEFAULT_TEACHER_URL = 公网地址），内网版本线 `2.0.x`（DEFAULT_TEACHER_URL = 内网地址），各自服务器只放自己版本线的包，互不干扰。

## 行为对照

| 场景 | 现状 | 改后 |
|---|---|---|
| 教师发新版 | 逐个传文件给学生 | 上传 2 个文件到服务器，完成 |
| 学生装新版 | 等文件 + 手动 VSIX 安装 | 通知点一下，自动装好 |
| 学生上课中（不重启） | — | 不打扰；下次启动才提示 |
| 服务器没放包 / 内网未启用 | — | 检查 404，完全静默，零影响 |
| 插件 teacher.url 指向不可达 | — | 静默，不影响任何既有功能 |

## 实施清单

1. [ ] 服务端：`index.ts` 新增 `/api/pylearner/latest` 与 `/downloads/pylearner` 静态托管 + `downloadsDir` 依赖注入
2. [ ] 服务端：`__tests__/pylearnerDownload.test.ts`（清单返回/404/静态文件三用例）
3. [ ] 部署：`deploy/docker-compose.yml` 与 `docker-compose.intranet.yml` 增加 downloads 卷挂载
4. [ ] 插件端：`src/update/updateChecker.ts`（版本比较 + 清单校验 + 下载安装编排）
5. [ ] 插件端：`src/test/update/updateChecker.test.ts`（版本比较边界/白名单/静默降级用例）
6. [ ] 插件端：`extension.ts` 激活 30s 后接线（失败静默、会话内一次）
7. [ ] 打包验证：本地 vitest 全量（两仓库）；真机验证一键更新闭环
8. [ ] 首发：公网打包 `1.0.9`、内网打包 `2.0.9`，两服务器分别放包 + manifest
