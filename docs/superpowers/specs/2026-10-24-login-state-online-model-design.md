# 登录态在线模型（多机计数 + 心跳下线）

## Context

大屏「在线」原为活动判定（`lastActivityAt ≥ 当天00:00`），存在：点亮延迟（纯打字不上报）、残留身份电脑误亮（事件上报只看身份不看确认态）、切换学号不下线、多机不可见、告警污染。

经评审收敛为**登录态模型**：大屏在线 = 右下角确认状态的镜像 + 机器存活。计数单位为**机器**（`vscode.env.machineId`，跨窗口跨重启稳定），同机多窗口计 1。

## 语义定义

- **机器会话** = `(学号, machineId)`，状态 `{ lastAliveAt, closed, closedBy }`（纯内存，服务端重启清空后心跳自愈）
- **online** = 存在 `!closed` 的机器会话
- **machineCount** = `!closed` 会话数；≥2 时矩阵瓦片右上角 ×N 徽标
- **closedBy 两类**：`logout`（切换登出，同键心跳不复活，仅显式 identity_confirmed 重开）；`timeout`（心跳超时，心跳恢复即重开）
- 服务端记账一律用**接收时刻** `Date.now()`，不信任客户端 ts（时钟错乱免疫）

## 三信号

| 信号 | 通道 | 触发点 | 携带 |
|---|---|---|---|
| `behavior/identity_confirmed` | /api/events（入库，审计换机行为） | 每窗口首次确认：拉取/提交/同步/F5 弹窗「是我本人」、身份页保存成功 | payload.machine_id + window session_id |
| heartbeat | **专用 POST /api/heartbeat**（只更新内存会话表，不落 trace_events / L1 / 画像） | 已确认窗口每 60s | 学号 + machine_id |
| `behavior/session_end` | /api/events（入库） | 切换学号成功（归档/学期重置后、保存新身份前） | payload.machine_id，旧身份上报 |

- 未确认窗口（右下角 `?`）：事件照常上报入库，不发登录信号、不发心跳、不点亮
- 心跳天然兜底登录信号丢失（断网确认 → 联网第一拍点亮）；session_end 丢失 → 3min 超时下线，最终一致

## 时间参数（常量，服务端）

- 心跳间隔 60s（客户端）；超时 3min；扫描 30s（仅翻转推快照，边沿触发）
- 下线延迟：切换=零延迟；关机/闪退/断网=≤3min（物理下限）；日终 00:00 清零（随 dayStart）

## 服务端改动（packages/server + shared）

1. **shared dto.ts**（已完成）：StudentState.machineCount、NormalizedEvent.sessionId
2. **stateManager.ts**：StudentRecord 加 `machines: Map<machineId, { lastAliveAt; closed; closedBy }>`；新增 `confirmLogin / heartbeat / logout / sweep`（均返回是否在线翻转）；`touchActivity` 保留（lastActivityAt 仅展示用途，与在线解耦）
3. **index.ts**：/api/events 非 diag/run 分支识别 identity_confirmed（surface+kind 双条件）/session_end → confirmLogin/logout；新增 `POST /api/heartbeat`（学号/machineId 白名单校验，不落库）；30s 扫描器（sweep 有翻转才 hub.publish）
4. **aggregator.ts**：online/machineCount 改读机器会话；alerts 排除 `!online`
5. **dashboard StudentMatrix.vue**：×N 徽标（machineCount ≥ 2，右上角绝对定位）

## 扩展端改动（vscode-pylearner）

1. **F5 纳入确认门禁**：run 链路入口 `ensureConfirmed()`（每窗口一次；拦截点尽量在运行前，若 run 由 Python 扩展触发则事件后确认，在线点亮效果不受影响——实施时验证）
2. **确认信号收口**：`onConfirmed` 回调（gate 所有确认路径的统一出口）发 identity_confirmed；markConfirmed 重复调用幂等无害
3. **心跳定时器**：extension.ts 创建 setInterval 60s，仅 `gate.isConfirmed()` 时发；machineId 取 `vscode.env.machineId`（空降级 ulid→窗口级）；裸 fetch `/api/heartbeat` 10s 超时失败静默；dispose 清理
4. **切换登出**：identityPage isSwitch 分支（归档/学期重置成功后、storeGitSecret 前）调 `deps.reportSessionEnd(machineId)` → l1Writer.append("behavior","session_end",{machine_id},...)

## 测试

- 服务端：confirmLogin/heartbeat/logout/sweep 翻转语义、logout 心跳不复活、timeout 心跳重开、identity_confirmed 重开 logout、/api/heartbeat 400 校验、alerts 排除
- 扩展端：F5 门禁、onConfirmed 发信号、心跳仅在确认后发、切换发 session_end
- dashboard：徽标显隐

## 兼容与部署

- 服务端+扩展**同批发布**（旧扩展无心跳/登录信号，新服务端下永不在线；升级窗口期大屏全灰）；反向（新扩展→旧服务端）信号当普通事件入库，无害
- 服务端重启 → 全班瞬时离线 → 心跳 60s 内自动恢复
- 切换瞬间在途心跳竞态：closedBy=logout 忽略同键心跳，无闪现
- 出包：扩展按目标环境选版本段（1.x 公网/2.x 内网/3.x 本地调试）

## 验证

1. `cd packages/server && npm test`；`cd packages/dashboard && npm test`（dev server 运行时勿并行跑 server 测试）
2. `cd d:\ruan\vscode-pylearner && npm test`
3. 端到端：确认即亮；关机 ≤3min 变暗；双机同登 ×2；切换立即下线+告警移除
