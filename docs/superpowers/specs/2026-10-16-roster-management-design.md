# 花名册管理与名册感知身份切换设计

日期：2026-10-16
状态：已评审（用户确认）
前置：spec 2026-10-15-student-git-branch-model-design.md（学生分支模型）

## 0. 背景与动机

**实测死锁**：学期更替重新导入花名册后，旧电脑上残留的旧学期身份导致一键换机死锁——
输入新学号触发 beforeSwitch → 归档需要旧身份 gitSecret → 旧学号已被新名册覆盖、无法通过校验补领凭证 → 归档必然失败 → 身份永远切不过去（提示"已取消或归档未完成，身份未切换"）。

**管理短板**：花名册仅有整体覆盖导入（`replaceRoster` 事务 DELETE+INSERT），单条录错需整表重导；无单条增删改。

**取代关系**：本设计完成后，2026-10-13 的"学期重置 AdminView 按钮"决策不再需要（见 §6）。

## 1. 服务端：名册 CRUD + 两级删除

### 1.1 新增接口

| 接口 | 语义 | Gitea 联动 |
|---|---|---|
| `POST /api/roster/entry` | 单条新增（补录转学生），body: `{studentId, studentName}` | provision：建号→协作者→分支保护（复用现有 `ensureStudentAccount` 链路，失败仅告警不回滚，重试幂等） |
| `PATCH /api/roster/entry/:studentId` | 仅改姓名，body: `{studentName}` | 无（Gitea 账户名=学号，full_name 不同步） |
| `DELETE /api/roster/entry/:studentId` | **软删除**：仅移出名册 | 无。`student_tokens` 保留 → 该生重新导入时 F4 幂等跳过建号，凭证无缝复用 |
| `POST /api/roster/entry/:studentId/purge` | **硬删除**：移出名册 + 彻底清除 | 删分支保护规则 → 删 `student-<id>` 分支 → 删 Gitea 账户 → 清 `student_tokens`（顺序敏感；危险操作，前端二次确认） |

现有 `POST /api/roster`（整体导入）、`GET /api/roster` 不变。学号是主键不可改（改学号=删+加，UI 不提供编辑）。

### 1.2 改动点

- [roster.ts](../../packages/server/src/routes/roster.ts)：新增 4 条路由；新增/导入路径复用现有 provision 异步循环逻辑（抽为共用函数）
- [persistence.ts](../../packages/server/src/persistence.ts)：新增 `upsertRosterEntry` / `updateRosterEntry` / `deleteRosterEntry`（软）/ `purgeRosterEntry`（硬，含 token 清理）
- [adminApi.ts](../../packages/server/src/gitea/adminApi.ts)：新增 `purgeStudent(studentId)`（删分支保护→删分支→删账户；任一步 404 视为已完成继续）

### 1.3 关键裁决

- **学号全周期唯一**（用户裁决，跨届不重复）：旧学生分支作为提交档案永久保留，硬删除仅用于学期中退学/隐私清理的零星场景。不存在同名分支污染新学生的问题。
- 软删除是默认删除动作；硬删除入口在 UI 上弱化 + 模态二次确认（文案明确：删 Gitea 账户与学生分支，提交历史不可恢复）。

## 2. validate 接口扩展（名册裁决源）

```ts
// POST /api/identity/validate
// 请求：{ studentId, studentName, previousStudentId? }   ← 扩展端从 globalState 带旧学号
// 响应：{ ok, studentName, gitSecret, previousIdInRoster?: boolean }
```

- `previousIdInRoster` 仅在 `previousStudentId` 存在且 ≠ 新学号时返回；服务端实现为一次 roster 查询，零新增接口。
- 服务端只返回 boolean，不暴露名册其他信息。

## 3. 扩展端：名册感知三分叉切换

[identityPage.ts](../../../vscode-pylearner/src/identity/identityPage.ts) 保存流程（在线校验通过后）：

```
oldId 为空（首次设置）        → F1 全新初始化（现状不变）
oldId 在名册                 → 现有一键换机（beforeSwitch 归档 → 切换，防丢代码，现状不变）
oldId 不在名册（学期更替/注销）→ 学期更替弹窗（模态确认）：
    确认 → ① git reset --hard origin/main + git clean -fdx（排除 .vscode）
          ② 保存新身份 + gitSecret
          ③ ensureStudentBranch（新学号：远端无分支 → 基于 origin/main 建）+ pullNewOnly
    取消 → 中止，身份与工作区均不变
服务器不可达                  → 现有离线保存路径（不变，不触发任何切换/清空）
```

### 3.1 清空工作区实现

- 全部 git 原语，封装于 git 层（如 `resetToMainBaseline`）：`reset --hard origin/main` + `clean -fdx -e .vscode`
- `clean -fdx` 含 ignored 缓存（比换机路径的 `-fdX` 更彻底，学期更替语义=全新电脑）；`.vscode` 排除，保留运行配置
- 未跟踪的学生自建文件将被清除——学期更替场景下旧代码已在服务器分支归档，此语义已在确认弹窗中向学生明示
- 失败处理：清空失败（reset/clean 报错）→ 中止且不保存新身份，提示"重置失败可重试"；工作区处于 main 基线或原状态，均可重跑

### 3.2 死锁修复验证

原死锁场景（旧学号不在名册 + 无凭证）正向化为：validate 成功（新学号在名册）→ previousIdInRoster=false → 确认弹窗 → 清空 → 初始化成功。不再触碰 beforeSwitch 归档链路。

## 4. 教师端 RosterPanel 升级

- 表格行内：姓名可编辑（保存走 PATCH）、"移出"按钮（软删除）
- 顶部："新增学生"（学号+姓名，走 POST entry）
- 每行"彻底清除"入口（purge）+ 模态二次确认
- 导入文本框保留原样
- [admin.ts](../../packages/dashboard/src/api/admin.ts) 扩展对应 4 个调用

## 5. 测试

- 服务端单测：4 条新路由（含软删后 token 保留、硬删的 Gitea 调用顺序与 404 容错）、validate 扩展字段（带/不带 previousStudentId、同学号）
- 扩展端 vitest：identityPage 三分叉（沿用现有 mock fetch 模式）、清空原语单测（reset/clean 参数断言、失败中止不保存身份）
- 手动回归：本次实测的死锁场景 → 应走学期更替弹窗一次通过；正常换机（旧学号在名册）→ 归档流程不受影响

## 6. 范围外

- **学期重置 AdminView 按钮：不再需要**。学期更替 = 教师导入新名册（一键）+ 学生端名册感知自愈，本设计取代 2026-10-13 决策。旧分支/账户作为档案保留，无需批量清理。
- 批量导入 `purgeRemoved` 参数：不做（学号不重复，无分支污染问题）。
- 改学号：不支持（=删+加）。
- Gitea full_name 同步：不做（账户名=学号，姓名仅监控显示用）。
- events/trace 历史数据的学期维度：第二阶段画像时处理。
