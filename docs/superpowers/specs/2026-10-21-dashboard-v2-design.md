# 实时助教大屏 V2 重设计

> 日期：2026-10-21（2026-10-22 修订） | 状态：待评审 | 前置：2026-09-17 课堂仪表盘设计（V1）、2026-10-16 L1 统一入库设计

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
| 11 | 课堂窗口简化（2026-10-22 拍板） | **砍掉「开始上课」按钮与滚动窗口兜底**：课堂实时数据（状态/告警/聚合/趋势/抽屉/统计条）只看**当天**（服务器本地时区 00:00 起）；题目进度为**累计态**（截止当前，跨天不清）——「谁没做/没通过」天然是作业完成情况，不随下课消失 |
| 12 | 题目全集矩阵化（2026-10-22 拍板）→ **已被 #18 取代** | 原方案：题目全集来自 Gitea 文件树 × 花名册（支撑"谁没做"）。2026-10-23 用户复审后改为当天涌现口径（见 #18）——题目是持续累加的，全集会无限膨胀，大屏只看当天 |
| 13 | 完成度图表与课后查看（2026-10-22 拍板）→ 2026-10-23 修订 | 完成度堆叠柱等四图表归入二期（#17）；**课后作业完成情况查看暂缓**——大屏定位为当天课堂工具（#18），课后查看待二期结合图表模块一并定稿 |
| 14 | 评审缺失兜底（2026-10-22 拍板） | 题目矩阵加第四态 **unreviewed「待评审」**（否决"默认算通过"：run 失败算通过会虚高通过率，且与「评审失败等同报错」裁决冲突）——学生发起评审但无有效结论（LLM 未配置/挂/mock 兜底/不确定）→ 该题置待评审；pass/fail 强信号不覆盖；run 失败翻 fail；`review_results` 落库扩三态（缓存表「unreviewed 不缓存」约束不动），保证重启回放后待评审态不丢失 |
| 15 | 矩阵显示全班 + 未开始并入正常（2026-10-22 拍板）→ 2026-10-23 细化为 #19 | 学生矩阵显示**花名册全班**；「未开始」在统计口径（图例/状态饼）**并入「正常」**，不做独立第四类目 |
| 16 | 完成度卡收敛（2026-10-23 拍板）→ 完成度卡部分**待二期按 #18 重设计** | 砍右栏题目进度列表（与堆叠柱信息重复）；右栏由 AI 建议卡独占。原"关注集/全班通过率"设计基于题目全集与累计口径，#18 改当天涌现后**完成度卡需重新设计**（二期）；错误分布/状态饼/节奏三卡不受影响 |
| 17 | 分两期实现（2026-10-23 拍板） | **第一期**：服务端全部管道（dayStart/矩阵追踪/落库/回放/装配）+ StatusBar/状态矩阵/AI 建议/抽屉；App 图表区暂不渲染，旧 ErrorAggPanel 第一期下线（快照数据完整，UI 二期补）。**第二期**：四图表（作业完成度卡/错误类型分布/状态占比/课堂节奏折线）——其中完成度卡受 #18 口径变化影响需重新设计，其余三卡设计不变；实现前与用户复审 |
| 18 | 题目面板当天涌现（2026-10-23 拍板，取代 #12/#13 的大屏部分） | 题目是教师持续累加的——大屏只展示**当天有学生运行/评审记录的题**（事件涌现），**不做题目全集矩阵**（Gitea 题目目录服务取消，无 Gitea 依赖）；每题统计为**当天人数**（通过/未通过/待评审），重启仅回放当天 `review_results`；顶栏**去掉「已通过评审」统计**，运行次数确认为当天口径（其余顶栏统计本就是当天） |
| 19 | 未在线=独立标识不占状态（2026-10-23 拍板，细化 #15） | `StatusColor` **回三值** `green|yellow|red`（删除 idle）；未在线（当天无活动）学生**不参与状态**——status 按无未解决错误=green；`StudentState` 新增独立字段 `online: boolean`（lastActivityAt >= 当天起点）；矩阵瓦片对 offline 学生**变暗 + 灰点**标识（能看出谁不在线即可，不是状态类目）；花名册无事件学生 online=false |
| 20 | 每题通过率（2026-10-23 拍板） | 通过率 = **当天评审通过人数 / 班级总人数**（花名册人数，涌现题目共用同一分母）；`ExerciseProgressItem` 加回 `total` + `passRate`（装配层注入——tracker 保持纯涌现计数，花名册人数由 buildSnapshot 查询）；未导入花名册时 total=0、passRate=0 |

## 3. 页面信息架构（方案 D）

```
┌─────────────────────────────────────────────────────────────┐
│ ① 统计条（深色顶栏）                                          │
│    标题 · 在线 N/总 · 急需帮助 N · 运行 N 次（均当天口径）        │
│    · 日期 · 当前时钟                                          │
├──────────────────────────────┬──────────────────────────────┤
│ ② 全班状态矩阵（主，约 60%）    │ ③ AI 建议卡（紫色 AI 标识，     │
│    花名册全班每人一瓦片；       │   独占右栏，竖排大卡）           │
│    未在线学生变暗+灰点标识      │   全班讲评 / 小组讨论 / 单独辅导 │
│    （不占状态，独立字段）；     │   （吸收原「优先帮助 Top5」的    │
│    三项图例 + 未在线计数        │    辅导对象信息，AlertPanel 移除）│
│    点击瓦片 → 学生抽屉          │                                 │
├──────────────────────────────┴──────────────────────────────┤
│ ⑤ 图表行【二期实现——首版不渲染；完成度卡待按 #18 重设计】        │
│    堆叠柱：作业完成度（数据源已改当天涌现三态，设计二期定稿）       │
│    柱状图：错误类型 × 涉及人数（替代原聚合列表+chart）             │
│    饼图：状态占比三色（卡住/有错误/正常，未开始并入正常）          │
│    折线图：每 5 分钟运行次数/错误次数双曲线（当天课堂节奏）         │
└─────────────────────────────────────────────────────────────┘
⑥ 学生抽屉（点击瓦片弹出，教师私密视图）：本节课事件流（仅当天，不再按天分组）
⑦ 管理页 #/admin：维持花名册管理现状（课后查看直接看大屏完成度卡，不重复建视图）
```

**视觉规范**：远距离可读第一——字号基线较 V1 放大（瓦片姓名 ≥16px、卡片标题 ≥18px、统计数字 ≥28px）、高对比深色顶栏、单屏无滚动、SSE 连接状态保留在顶栏。

## 4. 数据窗口机制（2026-10-22 简化后）

### 4.1 双窗口口径

| 数据域 | 窗口 | 用途 |
|--------|------|------|
| 全部大屏数据（状态/告警/聚合/趋势/抽屉/统计条/题目涌现） | `[当天本地 00:00, now]` | 只反映今天这堂课，跨午夜自然切换（决策 #18：无累计域） |

无手动课堂模式、无滚动兜底分支——按天切分天然免疫「忘点开始」与「课堂中途重启」。

实现：`dayStart(now)` 纯函数（服务器本地时区 `setHours(0,0,0,0)`），**部署要求 `TZ=Asia/Shanghai`**（docker compose 显式设置，避免 UTC 服务器上北京时间 16-24 点的课被算到"昨天"）。

### 4.2 接入点

- **aggregator**：`isWithinClassWindow(ts, now, windowStart)`（aggregator.ts 中唯一窗口函数，现有调用自动生效），`windowStart = dayStart(now)`
- **stateManager**：`getStudentDetail` 事件列表按同一窗口过滤（抽屉只显示今天）
- **trend**：快照输出仅当天桶；重启预热按当天起点扫描 trace_events
- **stats**：`passedReview`（今天评审通过过的学生数）按当天过滤；题目进度不在此列（累计域）
- 快照**不再有** `classSession` 字段（无课堂会话概念）

## 5. 服务端改动

### 5.1 题目口径：当天事件涌现（决策 #18，题目目录服务已取消）

~~原设计：Gitea 只读列树提供题目全集 × 花名册矩阵~~（决策 #12 已被 #18 取代）。

- 题目 = **当天有 run/评审事件的 filePath**（涌现）；无 Gitea 列树依赖、无花名册骨架、无 sync
- 项目题归并（同目录多文件归一题）暂不做，filePath 直出——二期结合完成度卡定稿时再审
- 跨天后题目自动消失（窗口过滤），昨天活跃的题今天无事件则不显示

### 5.2 评审结果持久化与新表 review_results

现状：评审结果只进内存 stateManager（fail 注入合成事件、pass 清零），服务端重启即丢，无法支撑「题目进度」跨重启一致。

```sql
CREATE TABLE IF NOT EXISTS review_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  class_id TEXT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','unreviewed')),
  reason TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_results_path_ts ON review_results(file_path, ts);
```

- 写入点：[reviewController.ts](/packages/server/src/controllers/reviewController.ts) `requestReview` 中 pass/fail/**unreviewed 均落一行**（本表是题目进度的事实源，unreviewed 落行才能支撑重启回放后「待评审」态不丢失；**缓存表「unreviewed 不缓存」约束不变**——那是缓存幂等设计，与本进度表职责不同）；`class_id` 取名册条目（缺省 null）
- 写入失败不阻塞评审响应（try/catch + `review.result_persist_failed` 日志）
- 回放窗口 = **当天**（`getReviewResultsSince(dayStart(now))`，决策 #18）
- 与「服务端运行中外部工具不可改库」约束兼容：本表仅服务端自身写入

### 5.3 题目进度聚合（ExerciseProgress，当天涌现口径，决策 #18）

- 内存结构 `Map<题id=filePath, Map<学生id, { studentName, latest: 'pass'|'fail'|'unreviewed', lastTs }>>`——格子因事件而生（无 none 预置）
- 事件驱动（全部记录 lastTs，供当天过滤）：
  - 评审 pass → `latest='pass'`；fail → `latest='fail'`；**unreviewed（评审请求无有效结论：LLM 未配置/挂/mock 兜底/不确定）→ `latest='unreviewed'`（待评审），pass/fail 已有则不覆盖（强信号）**
  - run 失败事件（`surface=run`，payload 含 `file`）→ `latest='fail'`（强负面信号）
  - edit 不改题目进度（仅用于学生状态 idle 判定）
- 快照输出 `list(dayStartMs)`：仅输出**当天有格子的题**（任一格 `lastTs >= dayStartMs`）；每题只统计当天格子 → `{ id, displayName, isProject, passed, stuck, unreviewed }`（当天人数）；按三态总和降序（最活跃在前）
  - **total / passRate 由装配层注入**（决策 #20）：total = 花名册人数，passRate = passed/total——tracker 保持纯涌现计数
  - **只输出人数统计，不输出学生名单**（2026-10-22 拍板）
- 重启回放：从 `review_results` 仅回放**当天**行（按 ts 升序；unreviewed 行不覆盖 pass/fail，与实时语义一致）；`getReviewResultsSince(dayStart(now))`
- 跨天：昨日格子被 `list(dayStartMs)` 过滤，题目自动消失；内存不清理（学期级格子数无碍）

### 5.4 课堂节奏时序（trend，新）

- 内存分桶 `[{ tStart, runs, errors }]`，桶宽 5 分钟；事件路由处 `surface=run`：`execution_success → runs++`、`execution_error → errors++`（幂等命中跳过）
- 快照输出**当天**桶 `trend[]`（`tStart >= dayStart(now)`）
- 重启预热：从 `trace_events` 按 `surface='run' AND ts >= 当天起点` 扫描重建（`kind` 列区分成败）；预热失败降级为空数组 + 日志

### 5.5 edit 活动信号（灰色「未开始」判定修正）

- 现状：`lastActivityAt` 仅由 diag/run 更新 → 学生写了半天代码没运行会被误判「未开始」
- 改动：事件路由对 `surface=edit`（幂等检查通过后）调用 stateManager 新增轻量方法 `touchActivity(studentId, studentName, classId, ts)`——仅更新 `lastActivityAt`（取更大值），不入事件列表、不解释
- 推送节流：edit 事件本身**不触发**快照推送；仅当本次活动使学生**从未在线变为在线**（online 翻转，边沿触发）时才 `publishSnapshot`，避免打字流量刷爆 SSE；矩阵其余刷新仍由 diag/run/评审事件驱动
- `computeStatus` **保持三值**（green/yellow/red，决策 #19 删除 idle）：未在线学生不参与状态——按无未解决错误=green；未在线由 recompute 输出独立字段 `online: boolean`（`lastActivityAt >= 当天起点`），矩阵瓦片据此变暗+灰点标识
- `StatusColor` 保持三值不变；`StudentState` 新增 `online: boolean`（决策 #19）

### 5.6 快照协议（TeacherSnapshot V2，向后兼容追加字段）

```ts
interface ExerciseProgressItem {
  id: string;                // 文件路径（涌现，决策 #18）
  displayName: string;       // basename，兼容 Windows 反斜杠
  isProject: boolean;
  passed: number; stuck: number; unreviewed: number;   // 均为当天人数
  total: number;             // 班级总人数（花名册，决策 #20）
  passRate: number;          // passed/total（决策 #20）
}
interface TrendBucket { tStart: number; runs: number; errors: number }
interface ClassStats { online: number; total: number; needHelp: number; runs: number }
// TeacherSnapshot 追加：
exerciseProgress: ExerciseProgressItem[];   // 当天涌现题，三态总和降序（决策 #18）
trend: TrendBucket[];                        // 当天全量桶
stats: ClassStats;                           // 顶栏统计条预聚合（已通过评审统计移除，决策 #18）
// StudentState.status 保持三值 green|yellow|red；新增 online: boolean（当天无活动=false，矩阵变暗+灰点标识，决策 #19）
// students = 花名册全集 ∪ 当天事件学生；花名册无事件学生补空记录（lastActivityAt=0 → online=false）
// 无 classSession 字段（§4）
```

server 与 dashboard 同仓同部署、一起上线，无新旧版本配对问题（区别于 content 端点的跨端兼容场景）。

## 6. 前端改动（packages/dashboard）

| 组件 | 改动 |
|------|------|
| `StatusBar.vue`（新） | 顶栏：标题、统计大数字（在线/急需帮助/运行次数——均当天口径，无「已通过评审」，决策 #18）、日期 + 时钟（本地每秒刷新）、SSE 状态 |
| `StudentMatrix.vue` | 数据源 = **花名册全班**；未在线学生（`online: false`）瓦片**变暗 + 灰点**独立标识（不占状态，status 仍 green）；图例三项（卡住/有错误/正常）+ 未在线计数；字号放大；点击开抽屉不变 |
| `AIPanel.vue`（替代 SuggestionBar） | 建议卡竖排大卡样式 + AI 紫色标识；三类 kind 配色沿用；ack 交互保留 |
| `AlertPanel.vue` | **移除**（辅导对象由 individual 建议承担；其测试文件一并删除，顺带消除既有基线失败） |
| `ExerciseProgress.vue` | **不做**（与完成度堆叠柱信息重复，决策 #16/#18） |
| `ErrorAggPanel.vue` → `ChartsRow.vue` 重构【二期】 | 拆为四卡：**作业完成度堆叠柱状图**（数据源 = exerciseProgress 当天涌现三态；原"关注集/通过率"设计基于全集累计口径已失效，**待按 #18 重新设计**）+ 柱状图（chart.js Bar，去掉展开列表）+ 饼图（chart.js Pie，三色：卡住/有错误/正常，未开始并入正常）+ 折线图（chart.js Line，双数据集，当天节奏）。一期：ErrorAggPanel 下线、App 图表区不渲染 |
| `StudentDrawer.vue` | 移除按天分组（仅当天事件）；标题加「本节课」措辞；其余保留 |
| `AdminView.vue` | **无改动**（维持花名册管理现状；课后查看直接看大屏题目进度） |
| `api/`、store | 无新增课堂路由；exerciseProgress/trend/stats 随快照透传（组件直接读快照字段，无需新 action） |
| 全局样式 | CSS 变量字号体系放大；深色顶栏配色 |

## 7. 边界与错误处理

| 场景 | 行为 |
|------|------|
| 服务端重启 | 题目进度从 review_results 仅回放**当天**行（avgAttempts 概念已随涌现口径移除）；trend 按当天起点重建；实时域按天过滤天然恢复 |
| 跨午夜 | 当天窗口自动切换（凌晨课场景罕见，接受）；题目涌现面板自动清空（昨天活跃的题不再显示） |
| 无 Gitea 依赖 | 题目目录服务已取消（决策 #18）——涌现口径不需要 Gitea，Gitea 仅服务既有 git 提交链路 |
| 学生自习时间在机房写课后作业 | 全内网同一链路：登录自己学号（换机走既有身份切换）→ F5 评审 → review_results 落库；**当天的课后完成情况大屏可见**，跨天回看暂缓（#18，待二期定稿） |
| LLM 未配置 / 评审不可用 / 评审不确定 | 评审请求无有效结论 → 该生该题置「待评审」（unreviewed）并落 review_results，不虚标「卡住/未开始」；后续评审出有效结论自动翻转 |
| 平板等无扩展设备经 Gitea 网页提交 | 先不考虑（无扩展即无事件无评审请求，系统无痕迹，无法计入完成状态） |
| 矩阵全班显示 | students = 花名册全集 ∪ 事件学生；花名册无事件学生补空记录（online=false 变暗标识，status=green 不占状态）；已删学生（有事件无名册）仍显示；图例三项 |
| 无花名册/无学生 | 各模块空态文案（沿用 V1 风格） |
| 花名册导入/变更 | 触发快照重推（矩阵全班来源刷新） |
| UTC 服务器（未设 TZ） | dayStart 按服务器本地时区计算；部署清单强制 TZ=Asia/Shanghai，避免北京时间 16-24 点的课被归到"昨天" |
| 45+ 学生矩阵 | 网格 auto-fill 自适应，瓦片最小宽度随行数收缩（现有机制保留） |
| review_results 写失败 | log warn，评审响应不受影响 |
| trend 预热失败 | 空数组降级 |

## 8. 明确不做

- 课堂会话机制（「开始上课」按钮、连堂重置、滚动窗口兜底）——2026-10-22 拍板砍掉，被按天窗口取代（决策 #11）
- 题目×学生全格子矩阵视图、题目行展开学生点名——只输出人数统计不上名单（2026-10-22 拍板，决策 #12 修订）
- chat 上屏（统计或提问流）——chat 事件维持只入库不进看板
- debug「调试中」角标
- behavior 上屏与抽屉「编辑会话摘要」——behavior 维持入库定位，待第二阶段画像消费
- 课前自检（教师端）、学生卡住渐进提示（学生插件）
- 折线图「错误上升」红区标注（mockup 点缀，首版不做）
- 截止当前/课后的历史作业报告——数据地基本次已埋（review_results + trace_events），消费端查询留待第二阶段画像
- 作业完成情况按**历史时点回溯**（"截止某时刻"视图）——review_results 已留存 ts，随时可做，记入附录候选

## 9. 附录：后续迭代候选清单

**学生插件 behavior 优化（本次审查发现，均小改动）**：
1. 格式化器污染粘贴计数：单次插入 ≈ 全文件长度识别为 rewrite，不计 `paste_like_inserts`
2. 粘贴阈值 `PASTE_LIKE_MIN_CHARS` 5 → 12+（中文 IME 一次上屏误报）
3. wiring `resetIdleTimer` 写死 `DEFAULTS.idleMs`，未用构造注入值
4. 多光标/批量替换同 t 批量变更把 gap 压成 0：相同 t 的 gap 跳过

**Cadence 借鉴判缓**：课前自检（用参考答案预演评审链路）、学生卡住渐进提示（连续报错 N 次自动给小提示，复用 knowledge 字段）。

**作业完成情况增强候选**：
1. 历史时点回溯（"截止某时刻"的完成情况视图，review_results.ts 已支持）
2. 时间段增量视图（"昨晚之后新增完成 N 人"）
3. 按顶层目录（week-N）分组展示，对应"第 N 次作业"

## 10. 测试要点

- **aggregator**：status 三值判定；未在线 `online` 独立字段（当天无活动=false）；窗口边界（恰好等于当天起点的事件计入）
- **dayStart**：当天 00:00 计算；跨午夜归属
- **review_results**：pass/fail/unreviewed 均落行、写入失败不阻塞、缓存表 unreviewed 不缓存的约束不受影响
- ~~**ExerciseCatalog**~~：已取消（决策 #18）
- **ExerciseProgress（当天涌现）**：事件生格（无预置）、latest 翻转、unreviewed 不覆盖 pass/fail、run 失败置 fail、`list(dayStartMs)` 当天题目/格子过滤、三态计数、回放仅当天行、**输出不含学生名单**
- **trend**：跨桶落桶、当天预热重建
- **edit touchActivity**：幂等命中不触发、lastActivityAt 单调
- **快照**：抽屉事件列表按当天窗口过滤；stats 预聚合各口径
- **前端**：StatusBar 统计与时钟（三项统计）、矩阵全班显示+未在线变暗标识+三项图例、抽屉单日；删除 AlertPanel.test.ts；四图表【二期，完成度卡待按 #18 重设计】
- **既有套件**：stateManager/aggregator/routes 快照断言随 V2 字段更新
