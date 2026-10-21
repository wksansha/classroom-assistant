# 实时助教大屏 V2 重设计

> 日期：2026-10-21 | 状态：待评审 | 前置：2026-09-17 课堂仪表盘设计（V1）、2026-10-16 L1 统一入库设计

---

## 1. 背景与目标

现有实时助教页面（`packages/dashboard`，默认视图）自 V1 上线后未经整体重设计。本次重设计的驱动：

- **演示场景**：页面在教室 75 寸电视大屏投屏，领导听课时要一眼体现系统价值，且美观、远距离可读
- **时效修正**：页面混入历史数据（学生抽屉按天翻全部历史、聚合无课堂锚点），教师明确要求**只反映当前课**
- **内容升级**：借鉴 Cadence（cadence-edu，Jupyter 教学实时进度系统）验证过的核心价值——「每题解题进度」，补齐「看题」维度（现有页面只「看人」）

**非目标**：不改学生插件（vscode-pylearner 零改动）、不动 `#/admin` 花名册管理功能、不动归档/评审链路的既有协议。

## 2. 决策记录（2026-10-20 用户逐项拍板）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 布局方向 | 方案 D：左右两栏为主 + 底部图表行（75 寸电视、用户明确「左右两块够了」「下方加柱状/饼/折线图」） |
| 2 | 课堂窗口 | 管理页 `#/admin` 加「开始上课」按钮；未点开始/服务端重启回退 `CLASS_WINDOW_MIN`（默认 120 分钟）滚动窗口 |
| 3 | 题目进度 | 借鉴 Cadence：每题通过 N 人 / 卡 M 人 / 平均试错 K 次 |
| 4 | edit 事件 | 用于修正灰色「未开始」判定（默认采纳，用户无异议） |
| 5 | chat 上屏 | 不做（仅维持入库） |
| 6 | debug 🐞 角标 | 不做（领导非计算机专业，看不懂反成噪音） |
| 7 | behavior 上屏 | 不做（会话级聚合、结算延迟 3~8 分钟、敏感信号不宜公开，定位为 L2 画像证据） |
| 8 | 抽屉编辑会话摘要 | 不做（behavior 维持现状） |
| 9 | 课前自检 / 学生渐进提示 | 不做（Cadence 借鉴中判缓） |
| 10 | 隐私尺度 | 真名全展示（姓名+错误类型直接上大屏） |

## 3. 页面信息架构（方案 D）

```
┌─────────────────────────────────────────────────────────────┐
│ ① 统计条（深色顶栏）                                          │
│    标题 · 在线 N/总 · 已通过评审 N · 急需帮助 N · 运行 N 次      │
│    · 上课中 MM:SS（紫底，来自 classStartedAt）· 当前时钟        │
├──────────────────────────────┬──────────────────────────────┤
│ ② 全班状态矩阵（主，约 60%）    │ ③ AI 建议卡（紫色 AI 标识）     │
│    每人一瓦片，四色 + 图例行     │   全班讲评 / 小组讨论 / 单独辅导 │
│    点击瓦片 → 学生抽屉          │   （吸收原「优先帮助 Top5」的    │
│                              │    辅导对象信息，AlertPanel 移除）│
│                              │ ④ 题目进度：每题一行             │
│                              │   通过 N · 卡 M · 均试错 K 次    │
│                              │   + 迷你比例条                  │
├──────────────────────────────┴──────────────────────────────┤
│ ⑤ 图表行（等高三卡）                                           │
│    柱状图：错误类型 × 涉及人数（替代原聚合列表+chart）             │
│    饼图：四色状态占比（含图例）                                  │
│    折线图：每 5 分钟运行次数/错误次数双曲线（课堂节奏）             │
└─────────────────────────────────────────────────────────────┘
⑥ 学生抽屉（点击瓦片弹出，教师私密视图）：本节课事件流（不再按天分组）
⑦ 管理页 #/admin：新增「课堂控制」卡——开始上课按钮 + 当前状态
```

**视觉规范**：远距离可读第一——字号基线较 V1 放大（瓦片姓名 ≥16px、卡片标题 ≥18px、统计数字 ≥28px）、高对比深色顶栏、单屏无滚动、SSE 连接状态保留在顶栏。

## 4. 课堂窗口机制

### 4.1 双模式

| 模式 | 触发 | 窗口定义 | 用途 |
|------|------|----------|------|
| 手动课堂模式 | 教师在 `#/admin` 点击「开始上课」 | `[classStartedAt, now]`，重复点击 = 重置起点（适配连堂） | 正常上课 |
| 滚动窗口兜底 | 未点开始 / 服务端重启后 | `[now − CLASS_WINDOW_MIN*60_000, now]` | 忘点开始、课堂中途重启 |

实现：服务端内存单例 `classSession { startedAt: number | null }`，不落库（重启丢失即自然回退兜底，两者语义一致，无不一致风险）。

### 4.2 接入点

- **aggregator**：`isWithinClassWindow(ts, now)`（[aggregator.ts](/packages/server/src/aggregator.ts) 中唯一窗口函数，现有 5 处调用自动生效）改为优先判 `classStartedAt`
- **stateManager**：`getStudentDetail` 事件列表按同一窗口过滤（抽屉只显示本节课）
- **快照**：`TeacherSnapshot` 新增 `classSession: { startedAt: number | null; fallback: boolean }`，前端据此显示「上课中 MM:SS」或「未开始（自动窗口）」

## 5. 服务端改动

### 5.1 课堂会话路由

- `POST /api/class/start` → 设置/重置 `classStartedAt = Date.now()`，同时重置题目进度与节奏分桶的内存聚合（重新计数），返回 `{ ok: true, startedAt }`
- 依赖注入走现有 `App` 组装模式（[index.ts](/packages/server/src/index.ts)），无鉴权（与 `#/admin` 同级，内网部署维持现状）

### 5.2 评审结果持久化与新表 review_results

现状：评审结果只进内存 stateManager（fail 注入合成事件、pass 清零），服务端重启即丢，无法支撑「题目进度」跨重启一致。

```sql
CREATE TABLE IF NOT EXISTS review_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  class_id TEXT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail')),
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_results_path_ts ON review_results(file_path, ts);
```

- 写入点：[reviewController.ts](/packages/server/src/controllers/reviewController.ts) `requestReview` 中 `review.status` 为 pass/fail 时落一行（`unreviewed` 不写，与缓存三态约束一致）；`class_id` 取名册条目（缺省 null）
- 写入失败不阻塞评审响应（try/catch + `review.result_persist_failed` 日志）
- 与「服务端运行中外部工具不可改库」约束兼容：本表仅服务端自身写入

### 5.3 题目进度聚合（ExerciseProgress，新模块）

借鉴 Cadence 的 solve-counts + attempts-to-first-correct：

- 内存结构 `Map<filePath, Map<studentId, { latest: 'pass'|'fail', failRuns }>>`，由两类事件增量驱动：
  - 评审结果（§5.2 写入处同步喂给 tracker）：pass → `latest='pass'` 并**冻结**当前 `failRuns` 为该生该题的试错数（冻结后归零重新累计，供下一轮 pass/fail 循环）；fail → `latest='fail'`（`failRuns` 继续累计，待后续 pass 冻结）
  - run 失败事件（事件路由处：`surface=run && kind=execution_error`，payload 含 `file`）：对应学生-文件的 `failRuns++`
- 快照输出 `exerciseProgress[]`：`{ filePath, displayName(basename), passed, stuck, avgAttempts|null }`
  - `passed` = 最新为 pass 的人数；`stuck` = 最新为 fail 的人数；`avgAttempts` = 最新为 pass 的学生其冻结试错数的均值（无已通过者 → null）
- 「开始上课」重置内存；重启后预热：从 `review_results` 按**当前生效窗口起点**（手动起点或滚动窗口起点）过滤恢复 passed/stuck（`avgAttempts` 因 run 失败计数不可回放而置 null，可接受降级）；trend/失败计数预热见 §5.4
- 展示上限：按 passed+stuck 排序取前 8 题，避免长列表溢出

### 5.4 课堂节奏时序（trend，新）

- 内存分桶 `[{ tStart, runs, errors }]`，桶宽 5 分钟；事件路由处 `surface=run`：`execution_success → runs++`、`execution_error → errors++`（幂等命中跳过）
- 快照输出窗口内全部桶 `trend[]`
- 重启预热：从 `trace_events` 按 `surface='run' AND ts >= 窗口起点` 扫描重建（`kind` 列区分成败）；预热失败降级为空数组 + 日志

### 5.5 edit 活动信号（灰色「未开始」判定修正）

- 现状：`lastActivityAt` 仅由 diag/run 更新 → 学生写了半天代码没运行会被误判「未开始」
- 改动：事件路由对 `surface=edit`（幂等检查通过后）调用 stateManager 新增轻量方法 `touchActivity(studentId, studentName, classId, ts)`——仅更新 `lastActivityAt`（取更大值），不入事件列表、不解释
- 推送节流：edit 事件本身**不触发**快照推送；仅当本次活动使该生状态跨越「无活动 ↔ 有活动」边界（`idle ↔ 非 idle` 翻转，边沿触发）时才 `publishSnapshot`，避免打字流量刷爆 SSE；矩阵其余刷新仍由 diag/run/评审事件驱动
- `computeStatus` 扩展第四态：窗口内无任何活动（`lastActivityAt` 为空或超窗）→ `"idle"`（灰色）；有活动且无未解决错误 → `"green"`
- `StatusColor` 类型扩为 `"green" | "yellow" | "red" | "idle"`（shared 包，影响 computeStatus/aggregator 测试与前端瓦片样式）

### 5.6 快照协议（TeacherSnapshot V2，向后兼容追加字段）

```ts
interface ClassSessionInfo { startedAt: number | null; fallback: boolean }
interface ExerciseProgressItem { filePath: string; displayName: string; passed: number; stuck: number; avgAttempts: number | null }
interface TrendBucket { tStart: number; runs: number; errors: number }
// TeacherSnapshot 追加：
classSession: ClassSessionInfo;
exerciseProgress: ExerciseProgressItem[];   // ≤8
trend: TrendBucket[];                        // 窗口内全量桶
// StudentState.status 扩为含 "idle" 的四值
```

server 与 dashboard 同仓同部署、一起上线，无新旧版本配对问题（区别于 content 端点的跨端兼容场景）。

## 6. 前端改动（packages/dashboard）

| 组件 | 改动 |
|------|------|
| `StatusBar.vue`（新） | 顶栏：标题、统计大数字（在线/已通过/急需帮助/运行次数）、上课计时（`classSession.startedAt` 本地每秒刷新）、时钟、SSE 状态 |
| `StudentMatrix.vue` | 新增图例行；新增 `.idle` 灰色虚线瓦片样式；字号放大；点击开抽屉不变 |
| `AIPanel.vue`（替代 SuggestionBar） | 建议卡竖排大卡样式 + AI 紫色标识；三类 kind 配色沿用；ack 交互保留 |
| `AlertPanel.vue` | **移除**（辅导对象由 individual 建议承担；其测试文件一并删除，顺带消除既有基线失败） |
| `ExerciseProgress.vue`（新） | 题目进度列表（名/通过/卡/均试错 + 迷你比例条），点击题目行展开涉及学生名（复用 AggItem.students 同款交互） |
| `ErrorAggPanel.vue` → `ChartsRow.vue` 重构 | 拆为三卡：柱状图（chart.js Bar，去掉展开列表）、饼图（chart.js Pie + 图例）、折线图（chart.js Line，双数据集） |
| `StudentDrawer.vue` | 移除按天分组（单日自然呈现）；标题加「本节课」措辞；其余保留 |
| `AdminView.vue` | 新增「课堂控制」卡：当前状态（未开始/上课中 MM:SS）+「开始上课」按钮（上课中点击文案变「重新开始（重置计时与进度）」） |
| `api/` | `classApi.start()`；store 增加 classSession/exerciseProgress/trend 透传 |
| 全局样式 | CSS 变量字号体系放大；深色顶栏配色 |

## 7. 边界与错误处理

| 场景 | 行为 |
|------|------|
| 忘点「开始上课」 | 滚动窗口兜底，页面显示「自动窗口」标识，功能完整 |
| 课堂中途服务端重启 | classStartedAt 丢失 → 回退滚动窗口；题目进度 passed/stuck 从 review_results 预热；avgAttempts 置 null；trend 重建 |
| 连堂课第二节 | 管理页再点一次 → 计时/进度/分桶全部重置 |
| 无花名册/无学生 | 各模块空态文案（沿用 V1 风格） |
| 45+ 学生矩阵 | 网格 auto-fill 自适应，瓦片最小宽度随行数收缩（现有机制保留） |
| review_results 写失败 | log warn，评审响应不受影响 |
| trend 预热失败 | 空数组降级 |

## 8. 明确不做（2026-10-20 拍板）

- chat 上屏（统计或提问流）——chat 事件维持只入库不进看板
- debug「调试中」角标
- behavior 上屏与抽屉「编辑会话摘要」——behavior 维持入库定位，待第二阶段画像消费
- 课前自检（教师端）、学生卡住渐进提示（学生插件）
- 折线图「错误上升」红区标注（mockup 点缀，首版不做）

## 9. 附录：后续迭代候选清单

**学生插件 behavior 优化（本次审查发现，均小改动）**：
1. 格式化器污染粘贴计数：单次插入 ≈ 全文件长度识别为 rewrite，不计 `paste_like_inserts`
2. 粘贴阈值 `PASTE_LIKE_MIN_CHARS` 5 → 12+（中文 IME 一次上屏误报）
3. wiring `resetIdleTimer` 写死 `DEFAULTS.idleMs`，未用构造注入值
4. 多光标/批量替换同 t 批量变更把 gap 压成 0：相同 t 的 gap 跳过

**Cadence 借鉴判缓**：课前自检（用参考答案预演评审链路）、学生卡住渐进提示（连续报错 N 次自动给小提示，复用 knowledge 字段）。

## 10. 测试要点

- **aggregator**：idle 四态判定；classStartedAt 模式下窗口边界（恰好等于起点的事件计入）；滚动窗口回退
- **classSession**：start 重置语义；重启丢失回退
- **review_results**：pass/fail 落行、unreviewed 不落、写入失败不阻塞
- **ExerciseProgress**：latest 翻转（fail→pass）、failRuns 累计与 pass 后清零语义、avgAttempts 计算、重置与预热
- **trend**：跨桶落桶、预热重建、重置
- **edit touchActivity**：幂等命中不触发、lastActivityAt 单调
- **前端**：StatusBar 计时、ExerciseProgress 渲染与展开、三图表空态、矩阵 idle 样式、抽屉单日、AdminView 课堂控制卡；删除 AlertPanel.test.ts
- **既有套件**：stateManager/aggregator/routes 快照断言随 V2 字段更新
