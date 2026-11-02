# 插件云分发（服务端清单 + 学生端一键更新）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 教师更新插件 = 替换服务器上 `.vsix` + `manifest.json` 两个文件；学生更新插件 = 通知点一下「立即更新」自动下载安装。服务端（classroom-assistant）加两条只读路由，插件端（vscode-pylearner）加启动检查与一键安装，内网/公网同一份代码。

**Architecture:** 服务端在 `createApp` 末尾（静态目录段旁）恒注册 `GET /api/pylearner/latest`（读 `public/downloads/pylearner/manifest.json`，缺失 404）与 `GET /downloads/pylearner`（express.static 同目录），`downloadsDir` 可注入供测试；Docker 卷挂载 `./data/server/downloads`，更新插件不重建镜像。插件端新建 `src/update/updateChecker.ts`（不 import vscode，全依赖注入可单测）：版本比较 → 清单校验 → 通知 → 下载临时文件 → `workbench.extensions.action.installVSIX` → 提示重载；`extension.ts` 激活 30s 后接线，失败静默。

**Tech Stack:** TypeScript / Express / VS Code Extension API / vitest + supertest

**Spec:** `docs/superpowers/specs/2026-11-02-plugin-auto-update-design.md`（本计划从该 spec 论证，执行者需同时阅读）

## Global Constraints

- 两仓库代码改动完全一致发布到内网与公网；环境差异仅 `manifest.json` 内容与 `pylearner.teacher.url`
- 版本线：公网 `1.0.x`、内网 `2.0.x`，各自服务器只放自己版本线的包；版本比较按段数值比较（`1.10.0 > 1.9.0`）
- `file` 字段白名单 `/^[A-Za-z0-9._-]+$/`，插件端与测试均覆盖路径穿越拒绝
- 更新检查失败（网络/404/解析/版本不高）一律返回 null 静默，**不弹任何提示、不重试**
- 每窗口会话至多检查一次（激活 30s 后），不轮询；学生不点「立即更新」本次会话不再打扰
- 插件文案不出现技术术语：「更新」「重新加载窗口」即可
- 服务端无新依赖、无写接口；`manifest.json` 缺失时与今天行为一致（404 静默）
- 当前版本来源：`vscode.extensions.getExtension("deeptutor.vscode-pylearner")!.packageJSON.version`，不硬编码

> **实施状态（2026-11-02）**：Task 1-4 与 Task 5 Step 1-2 已在工作区实施，两仓库 vitest 全量通过 + esbuild 编译通过；Task 5 Step 3-4（真机闭环验证 + 首发打包放包）待执行。

---

### Task 1: 服务端清单接口 + 静态托管 [x]（已实施）

**Files:**
- Modify: `packages/server/src/index.ts`（imports + `createApp` 静态段前插入路由 + `AppDeps`）
- Test: `packages/server/src/__tests__/pylearnerDownload.test.ts`（新建）

**Interfaces:**
- Produces: `AppDeps.downloadsDir?: string | null`（缺省 `path.resolve(__dirname, "..", "public", "downloads", "pylearner")`）
- Produces: `GET /api/pylearner/latest` → 200（manifest 原样 JSON）/ 404（缺失或 JSON 非法）
- Produces: `GET /downloads/pylearner/<file>` → 静态文件

- [x] **Step 1: index.ts 增加依赖与路由**

`AppDeps` 增加：

```ts
  /** 插件分发目录（含 manifest.json 与 .vsix）；缺省 packages/server/public/downloads/pylearner，目录不存在则请求 404 */
  downloadsDir?: string | null;
```

`createApp` 内（`// 生产：托管 dashboard 构建产物` 段之前）插入：

```ts
  // —— 插件云分发（学生端一键更新）：清单 + 安装包只读托管 ——
  // 目录缺省 packages/server/public/downloads/pylearner（Docker 卷挂载点，教师更新插件不重建镜像）；
  // manifest.json 缺失/非法 → 404，插件端静默忽略（服务器未放包时与今天行为一致）
  const downloadsDir = deps.downloadsDir !== undefined
    ? deps.downloadsDir
    : path.resolve(__dirname, "..", "public", "downloads", "pylearner");
  if (downloadsDir) {
    app.get("/api/pylearner/latest", (_req, res) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(downloadsDir, "manifest.json"), "utf-8"));
        res.json(manifest);
      } catch {
        res.status(404).json({ error: "manifest not found" });
      }
    });
    app.use("/downloads/pylearner", express.static(downloadsDir));
  }
```

顶部补 `import fs from "node:fs";`（当前 index.ts 只有 path）。

- [x] **Step 2: 写测试**

新建 `packages/server/src/__tests__/pylearnerDownload.test.ts`：`mkdtempSync` 造临时目录，写入 `manifest.json`（`{version:"1.0.9", file:"vscode-pylearner-1.0.9.vsix", notes:"…"}`）与假 vsix 文件，`createApp({ dbPath: ":memory:", staticDir: null, downloadsDir })` 三用例：

1. `GET /api/pylearner/latest` → 200 且 body 等于 manifest 内容
2. 空目录（无 manifest）→ 404
3. `GET /downloads/pylearner/vscode-pylearner-1.0.9.vsix` → 200 且内容等于写入字节

- [x] **Step 3: 验证** `pnpm --filter @classroom/server test`（或仓库既有测试命令）全量通过

### Task 2: Docker 卷挂载 [x]（已实施）

**Files:**
- Modify: `deploy/docker-compose.yml`（server.volumes）
- Modify: `deploy/docker-compose.intranet.yml`（server.volumes）

- [x] **Step 1: 两个 compose 的 server 服务 volumes 各增加一行**

```yaml
      - ./data/server/downloads:/app/packages/server/public/downloads   # 插件分发目录（vsix + manifest.json，更新插件不重建镜像）
```

- [x] **Step 2: 注释核对**——Dockerfile 的 WORKDIR/CMD 不变；运行时 `__dirname=/app/packages/server/src`，`..` 即 `/app/packages/server`，挂载点与缺省解析一致

### Task 3: 插件端更新检查模块 [x]（已实施；UpdateInfo 增补 `file` 字段供临时落盘命名，InstallUpdateDeps 回调用 PromiseLike 适配 Thenable）

**Files:**
- Modify: `src/update/updateChecker.ts`（新建）
- Test: `src/test/update/updateChecker.test.ts`（新建）

**Interfaces:**
- Produces: `compareVersions(a: string, b: string): number`（-1/0/1，按段数值，短侧补 0）
- Produces: `checkForUpdate(deps): Promise<UpdateInfo | null>`，`deps = { teacherUrl, currentVersion, fetchImpl?, timeoutMs? }`；`UpdateInfo = { version, downloadUrl, notes }`
- Produces: `installUpdate(deps): Promise<void>`，`deps = { info, showProgress, showMessage, showError, executeCommand, writeFile, tmpDir }`（全部注入，无 vscode import）

- [x] **Step 1: 版本比较**

```ts
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
```

- [x] **Step 2: checkForUpdate**

- `fetch(`${teacherUrl}/api/pylearner/latest`)`，`AbortController` 超时 10s；非 ok / JSON 解析失败 → null
- 校验 `version`（string）与 `file`（`/^[A-Za-z0-9._-]+$/`）→ 不合法返回 null
- `compareVersions(currentVersion, version) >= 0` → null
- 返回 `{ version, downloadUrl: `${teacherUrl}/downloads/pylearner/${file}`, notes: typeof notes === "string" ? notes : "" }`
- 整体 try/catch → null（网络异常静默）

- [x] **Step 3: installUpdate**

- `showProgress("正在下载更新…", () => fetch(info.downloadUrl))` → `res.ok` 校验 → `res.arrayBuffer()` → `writeFile(join(tmpDir, info.file), Buffer)` → `executeCommand("workbench.extensions.action.installVSIX", vscode.Uri.file(path))`（URI 构造由注入的回调完成，保持模块无 vscode import）→ `showMessage("更新已安装，重新加载窗口后生效", "重新加载")` → 点「重新加载」→ `executeCommand("workbench.action.reloadWindow")`
- 任一步抛错 → `showError("插件更新失败：" + message)`，不再重试

- [x] **Step 4: 写测试** `src/test/update/updateChecker.test.ts`：

1. `compareVersions`：`1.10.0 > 1.9.0`、`1.0.8 < 2.0.8`、相等、段数不齐补 0
2. 清单正常且版本更高 → 返回 UpdateInfo，downloadUrl 拼接正确
3. 清单 404 / 非 JSON / file 含 `../` 或非法字符 / 版本不高于当前 / fetch 抛错 → 全部 null 且不抛
4. `installUpdate`：happy path 断言写入临时文件与两次 executeCommand 调用序；fetch 失败 → showError 一次、不执行 installVSIX

### Task 4: extension.ts 接线 [x]（已实施）

**Files:**
- Modify: `src/extension.ts`（activateCore 末尾接线 + import）

- [x] **Step 1: 激活 30s 后检查一次**

`activateCore` 末尾（`gitRepoUrlReady` 之后）：

```ts
  // —— 插件自更新（云分发）：启动 30s 后检查一次；失败静默；不点更新本会话不再打扰 ——
  const updateTimer = setTimeout(() => {
    void (async () => {
      const info = await checkForUpdate({ teacherUrl: identityDeps.teacherUrl(), currentVersion: currentVersion() });
      if (!info) return;
      const pick = await vscode.window.showInformationMessage(
        `Python Learner 有新版本 ${info.version}${info.notes ? `：${info.notes}` : ""}`,
        "立即更新"
      );
      if (pick !== "立即更新") return;
      await installUpdate({
        info,
        showProgress: (title, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task),
        showMessage: (msg, btn) => vscode.window.showInformationMessage(msg, btn),
        showError: (msg) => void vscode.window.showErrorMessage(msg),
        executeCommand: (cmd, arg) => vscode.commands.executeCommand(cmd, arg),
        writeFile: (p, data) => fs.promises.writeFile(p, data),
        tmpDir: os.tmpdir(),
        joinPath: path.join,
        toUri: (p) => vscode.Uri.file(p),
      });
    })();
  }, 30_000);
  (updateTimer as unknown as { unref?: () => void }).unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });
```

`currentVersion()`：

```ts
  const currentVersion = () =>
    vscode.extensions.getExtension("deeptutor.vscode-pylearner")?.packageJSON?.version as string | undefined ?? "0.0.0";
```

- [x] **Step 2: 自检**——extension.ts 已 import fs/path/os，无需新增；`npm run compile` 通过

### Task 5: 全量验证 + 首发打包 [x]（Step 1-2 已实施；Step 3-4 待真机验证与首发）

- [x] **Step 1:** classroom-assistant `pnpm test`（server 包）全量通过
- [x] **Step 2:** vscode-pylearner `npm test` 全量通过 + `npm run compile` 通过
- [ ] **Step 3:** 真机闭环验证（公网服务器）：
  1. 服务器 `deploy/data/server/downloads/pylearner/` 放入 `vscode-pylearner-1.0.9.vsix` + `manifest.json`
  2. 学生机装 1.0.8 → 启动 30s 后收到「有新版本 1.0.9」→ 点「立即更新」→ 重载后 `package.json` 版本变为 1.0.9
  3. 删掉服务器 manifest.json → 学生机重启不再收到提示（静默）
- [ ] **Step 4:** 首发：公网打 `1.0.9` 包、内网打 `2.0.9` 包（`DEFAULT_TEACHER_URL` 与 package.json version 按版本线调整），两服务器分别放包 + manifest；此后学生更新不再手动传文件
