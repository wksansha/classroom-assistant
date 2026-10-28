# 事件降噪（diag 存活窗口 + edit/debug 移除 + 归档停传）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展端事件降噪——diag 改错误存活窗口（瞬态打字中间态误报清零）、edit/debug 事件彻底移除（不采集）、归档补传停用。服务端零代码改动，内网/公网共用同一份扩展代码，环境差异全部收敛到服务端 `.env`。

**Architecture:** 三处客户端裁剪——① `diagnosticsListener` 重写为「错误指纹存活窗口」（指纹首次出现 30s 后仍在才上报，同一指纹不重复报，消失即清除）；② edit/debug 在**信号源**移除（不注册 editListener、runListener 删除 debug 追踪块），L1Writer/归档代码零改动；③ archiver `isEnabled` 加 `ARCHIVE_UPLOAD_DISABLED` 停用条件。大屏保留：在线矩阵（心跳）、运行次数、失败变黄、急需帮助告警。

**Tech Stack:** TypeScript / VS Code Extension API / vitest（fake timers）

**Spec:** `docs/superpowers/specs/2026-10-28-event-noise-reduction-design.md`（本计划从该 spec 论证，执行者需同时阅读）

## Global Constraints

- diag 存活窗口常量 `PERSIST_MS = 30_000`（用户拍板 30s；后续调参改常量即可，不做配置项）
- **不上报「错误清零」事件**：diag success 仅为活动信号，状态机无清零语义（`stateManager.apply` 已核实），消失的错误直接丢弃
- 错误指纹 = `起始行:起始列:message`；指纹变化（措辞随打字变化）视为新错误重新计时——同一问题可能报多条不同消息，接受
- edit/debug 在**信号源移除**（不注册 editListener / 删除 runListener debug 块），L1Writer 与归档代码零改动——`l1Writer-identity.test`、`l1Writer-report-all.test` 等既有测试不受影响
- 归档停传用常量 `ARCHIVE_UPLOAD_DISABLED = true`（未来恢复改 false 即可幂等全量回补）
- behavior 与 run 实时上报保留（behavior 含登录态信号 `identity_confirmed`/`session_end`，是在线模型骨架）
- 内网/公网**同一份代码**：仅 `constants.ts` 的 `DEFAULT_TEACHER_URL` 与 `package.json` version 差异（内网 2.0.2 = `http://192.168.1.254:3000`，公网 1.0.3 = `http://120.48.112.26:3002`）
- 服务端零改动：`.env` 清空 LLM 三行走既有 mock 静默降级（评审 unreviewed、聊天代理不启用），无需 LITE_MODE/public-lite 分支

## 现状说明

Task 1-4 的代码改动**已在工作区实施**（实施中文档补写）；Task 5 起为剩余工作。执行者从 Task 5 开始即可，Task 1-4 的复选框已按实际完成状态标记。

---

### Task 1: runListener 移除 debug 追踪 [x]（已实施）

**Files:**
- Modify: `src/events/runListener.ts:316-322`（原 ~316-372）

- [x] 删除三个 debug 采集块（`onDidStartDebugSession` / `onDidTerminateDebugSession` / `onDidChangeBreakpoints`）与 `pyLocation` 辅助函数，保留注释说明。`isRunEnabled` 在 run 终端执行链路仍有使用，不删
- [x] debug 事件在信号源消失（runListener 是唯一产生方）

### Task 2: editListener 注册移除 [x]（已实施）

**Files:**
- Modify: `src/extension.ts:38,786-793`（import 与注册块）

- [x] 移除 `createEditListener` import 与注册块。editListener.ts 文件保留（未引用，esbuild 自动摇树；未来恢复采集重新注册即可）
- [x] edit 事件在信号源消失

### Task 3: 归档停传 [x]（已实施）

**Files:**
- Modify: `src/constants.ts:43-45`（新增 `ARCHIVE_UPLOAD_DISABLED = true`）
- Modify: `src/extension.ts:476-488`（archiver `isEnabled` 闭包加 `!ARCHIVE_UPLOAD_DISABLED &&`）

- [x] `runOnce` 自检 `isEnabled()` 直接返回（archiver.ts:103 已核实），激活自检与「同步历史练习记录」命令中的上传全部 no-op
- [x] 本地 jsonl 写入与归档位点不推进，未来恢复改 false 即幂等全量回补

### Task 4: diagnosticsListener 重写为存活窗口 [x]（已实施，测试见 Task 5）

**Files:**
- Modify: `src/events/diagnosticsListener.ts`（整体重写）

- [x] 状态结构：`snaps`（每文件最新快照：uri/file/errors/warnings/samples/fps）、`firstSeen`（指纹→首见时刻）、`reported`（已上报指纹集）
- [x] `onDidChangeDiagnostics` → SETTLE_MS(500ms) 收敛去抖 → `updateSnapshot`：取快照、维护指纹生命周期（消失清除 firstSeen/reported、新现记录 now）、`scheduleCheck`
- [x] 对账（每文件单 timer，时点 = 最早未报首见 + PERSIST_MS）：存活满窗口且未报 → `writer.append("diag", diagnosticsChange, {file, errors, warnings, samples})` 一次；仍有未满窗口指纹则继续排程
- [x] 不报「清零」事件；`monitorEdit` 开关门控沿用
- [x] dispose 清理全部 timer 与 Map

---

### Task 5: vscode-mock 扩展 + diagnosticsListener 存活窗口测试 [ ]

**Files:**
- Modify: `src/test/vscode-mock.ts`（增量扩展：languages / DiagnosticSeverity / getConfiguration / getWorkspaceFolder / asRelativePath）
- Test: `src/test/events/diagnosticsListener.test.ts`（新建）

**Interfaces:**
- Produces: mock `vscode.languages.onDidChangeDiagnostics` 可捕获注册的 handler（测试手动触发诊断变化事件）
- Produces: mock `vscode.languages.getDiagnostics` 可按 uri 注入诊断列表

- [ ] **Step 1: 扩展 vscode-mock（增量，不影响既有测试）**

`src/test/vscode-mock.ts` 的工厂对象增加：

```ts
  languages: {
    onDidChangeDiagnostics: vi.fn(),
    getDiagnostics: vi.fn(),
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
```

`workspace` 对象增加：

```ts
    getConfiguration: vi.fn(() => ({ get: () => true })),
    getWorkspaceFolder: vi.fn(() => undefined),
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath.replace(/^\//, "")),
```

- [ ] **Step 2: 写测试**

新建 `src/test/events/diagnosticsListener.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { createDiagnosticsListener } from "../../events/diagnosticsListener";

// 存活窗口（PERSIST_MS=30s）：瞬态打字中间态（窗口内消失）永不报；
// 持续存在的真错误在满窗口对账时上报一次；消失后再现视为新错误可再报。

const uri = {
  scheme: "file", fsPath: "/w/a.py",
  toString: () => "file:///w/a.py",
} as never as vscode.Uri;

const errDiag = (message: string, line = 0) => ({
  message, severity: vscode.DiagnosticSeverity.Error,
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

function makeListener() {
  const writer = { append: vi.fn().mockResolvedValue(undefined) };
  const listener = createDiagnosticsListener(writer as never);
  const handler = (vscode.languages.onDidChangeDiagnostics as ReturnType<typeof vi.fn>)
    .mock.calls[0][0] as (e: { uris: vscode.Uri[] }) => void;
  return { writer, listener, handler };
}

describe("diagnosticsListener 存活窗口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("观察期：错误 5s 内消失（打字噪音）→ 永不上报", async () => {
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("Expected name after 'def'")] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);            // 收敛去抖
    vi.advanceTimersByTime(5_000);                    // 停顿 5s（窗口未满）
    // 错误消失：诊断清空
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(60_000);                   // 越过窗口也不会补报
    expect(writer.append).not.toHaveBeenCalled();
    listener.dispose();
  });

  it("持久上报：错误存活满 30s → 上报一次；持续存在不重复报", async () => {
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);           // 收敛，指纹首见
    vi.advanceTimersByTime(30_000);                   // 存活满窗口 → 对账上报
    expect(writer.append).toHaveBeenCalledTimes(1);
    const payload = (writer.append as ReturnType<typeof vi.fn>).mock.calls[0][2] as { errors: number; samples: string[] };
    expect(payload.errors).toBe(1);
    expect(payload.samples[0]).toContain("unresolved reference");
    vi.advanceTimersByTime(120_000);                  // 错误仍在 → 不重复报
    expect(writer.append).toHaveBeenCalledTimes(1);
    listener.dispose();
  });

  it("消失后再现 → 视为新错误，重新计时后可再次上报", async () => {
    const { writer, listener, handler } = makeListener();
    const mockGet = vi.mocked(vscode.languages.getDiagnostics);
    mockGet.mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(30_000);                   // 第一次上报
    expect(writer.append).toHaveBeenCalledTimes(1);
    // 消失
    mockGet.mockReturnValue([] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    // 再现（同指纹）
    mockGet.mockReturnValue([errDiag("unresolved reference 'foo'", 3)] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(10_000);                   // 新窗口未满
    expect(writer.append).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25_000);                   // 满 30s → 再报
    expect(writer.append).toHaveBeenCalledTimes(2);
    listener.dispose();
  });

  it("monitorEdit 关闭 → 完全不采集", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    const { writer, listener, handler } = makeListener();
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([errDiag("some error")] as never);
    handler({ uris: [uri] });
    await vi.advanceTimersByTimeAsync(500);
    vi.advanceTimersByTime(60_000);
    expect(writer.append).not.toHaveBeenCalled();
    listener.dispose();
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run src/test/events/diagnosticsListener.test.ts`
Expected: 4 passed

- [ ] **Step 4: 跑扩展全量测试**

Run: `npx vitest run`
Expected: 全部通过（`l1Writer-report-all.test` 等既有测试不受影响——edit 裁剪在信号源，L1Writer 对直连 append 仍全量处理）

---

### Task 6: 打包内网 2.0.2 [ ]

**Files:**
- Modify: `package.json:5`（version 2.0.0 → 2.0.2）

- [ ] `package.json` version 改 `2.0.2`（`DEFAULT_TEACHER_URL = http://192.168.1.254:3000` 保持不变）
- [ ] `npx @vscode/vsce package` → 产出 `vscode-pylearner-2.0.2.vsix`（prepublish 自动同步地址 + 构建 webview + 编译）
- [ ] 复制带机房标识副本 `pylearner-2.0.2-机房192.168.1.254.vsix`

### Task 7: 打包公网 1.0.3 [ ]

**Files:**
- Modify: `src/constants.ts:41`（`DEFAULT_TEACHER_URL` → `http://120.48.112.26:3002`，注释同步改公网版）
- Modify: `package.json:5`（version 2.0.2 → 1.0.3）

- [ ] 地址与版本切换后 `npx @vscode/vsce package` → 产出 `vscode-pylearner-1.0.3.vsix`
- [ ] 复制带机房标识副本 `pylearner-1.0.3-公网120.48.112.26.vsix`；**注意**：最终提交状态停留在公网 1.0.3（与既有发版惯例一致）

### Task 8: 提交推送 [ ]

- [ ] `git add` 全部改动（constants/l1Writer 无改动、extension.ts/runListener.ts/diagnosticsListener.ts/vscode-mock/新测试/package.json）
- [ ] 两个 commit：`feat: 事件降噪——diag 存活窗口 + edit/debug 信号源移除 + 归档停传（bump 2.0.2 内网版）` 与 `chore: bump 1.0.3 公网版`
- [ ] `git push origin master`

### Task 9: 部署运维（非代码，按序执行）[ ]

- [ ] 公网服务器 `.env` 清空 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 三行
- [ ] 公网服务器 `docker compose -f deploy/docker-compose.yml up -d --force-recreate server`（清空 LLM 走 mock 静默，聊天代理自动不启用）
- [ ] 学生机重装对应 vsix（内网机房装 2.0.2，公网装 1.0.3），完全重启 VS Code
- [ ] 真机验证：`def` 场景不再上屏；真错误 30s 后上报一次；归档不触发（无 batch_received）；大屏在线/运行计数正常

---

## 验收标准

1. 扩展 vitest 全量通过（含新增存活窗口 4 用例）
2. 学生机写代码过程：服务端日志无 edit/diag 洪峰（对照复盘报告基线 8,692 条/5h → 预期数百条以内）
3. 真卡住学生（错误持续 30s+）出现在大屏告警
4. 归档批量上传归零（无 batch_received 日志）
5. 公网 GLM 外呼归零（无 llm_http_error / llm.api_error 日志）
