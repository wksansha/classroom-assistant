# 单文件多任务完成度实施计划

- 日期：2026-11-09
- 设计：`docs/superpowers/specs/2026-11-09-multi-task-completion-design.md`
- 改动面：`packages/shared`、`packages/server`、`packages/dashboard`；扩展端零改动
- 验证：`pnpm --filter @classroom/server test`、`pnpm --filter @classroom/dashboard test`、`pnpm --filter @classroom/dashboard build`

## T1 shared DTO 扩展

- `dto.ts`：新增 `TaskBucket { taskId, name, passed, stuck, unreviewed, firstTs, latestTs }`；`ExerciseProgressItem` 加 `tasks?: TaskBucket[]`（单任务题缺省）；`ReviewResultRow` 加 `taskId?: string | null`
- 无独立测试（类型层），以 T4/T5 测试编译通过为准

## T2 题面头解析 parseExerciseHeader

- `reviewController.ts`：现有 `extractExerciseTitle` 扩展为 `parseExerciseHeader(code)` → `{ title, tasks: string[] }`
- 规则（spec §3）：分隔线前 `#` 注释逐行扫描；首行非空 = 标题（沿用现有清洗）；`[...]` 前缀行 = 任务声明按序成清单；**≥2 个声明才返回 tasks**，否则 `tasks: []`
- TDD：新增 `__tests__/exerciseHeader.test.ts`（多任务/单任务声明/无声明/宽容匹配/学生删头）

## T3 持久化：review_results 加 task_id

- `persistence.ts`：建表语句加列 + 存量库 `PRAGMA table_info` 检测后 `ALTER TABLE ADD COLUMN task_id TEXT`（幂等迁移）；`saveReviewResult` / `getReviewResultsSince` 带 taskId
- 测试：persistence.test 补多任务行写入/读出/旧库迁移用例

## T4 评审协议：逐任务结论

- `reviewService`：多任务题（tasks ≥2）prompt 注入任务清单 + 逐任务判定规则（spec §4）；LLM 输出解析 `tasks[]`，任务名宽松匹配，解析失败回退全体同结论
- `reviewController.requestReview`：
  - 多任务题 → 每任务一行 review_results（带 taskId）；学生回执 status/reason 按汇总规则拼接（任一 fail=fail / 全 pass=pass / 否则 unreviewed；reason 逐任务 ✅❌⬜ 拼接）
  - 状态注入沿用文件级：有 fail 任务 → injectReviewFail（rawMessage = 失败任务原因汇总）；全 pass → injectReviewPass；否则 unreviewed 路径
- TDD：reviewRequest.test 补多任务用例（逐任务落行/回退/回执拼接/注入）

## T5 进度桶多任务化

- `exerciseProgress.ts`：
  - 桶 key 内部 `filePath::任务名`；新增 `fileTasks` 注册表（文件 → 任务名数组，评审到达时建立）
  - `applyReview/applyUnreviewed` 增加 taskName 参数：多任务题逐任务落桶，单任务题走原桶
  - **run 语义修正**：run 失败到达时该文件为多任务 → 仅推进 lastTs 不判 fail；单任务 → 现状 fail；runOk/degraded → 应用到文件全部任务桶
  - `warmUpFromReviews` 带 taskId 回放；`list()` 多任务题输出 `tasks[]`（每桶 passed/stuck/unreviewed）+ 文件级 top-level 按学生聚合（全 pass=passed / 任一 fail=stuck / 其余 unreviewed）
- TDD：exerciseProgress.test 补多任务互不影响/run 语义/聚合/回放用例

## T6 大屏完成度卡：文件下拉 + 任务 tab

- `ChartsRow.vue`：
  - 新增 `selectedFileId` 状态：下拉选项 = 涌现题（firstTs 排序），默认"自动跟随"（现有涌现优先规则生效）；点选 = 锁定该文件；切"自动" = 恢复跟随
  - `displayItem.tasks?.length >= 2` → 任务 tab（任务名取 bucket.name），默认选中第一个 passed < total 的桶；桶数据驱动水桶液面/已通过/编码中
  - 单任务/无声明题：无 tab，展示 top-level（现状）
- TDD：拆出选择逻辑纯函数（`pickFocusFile` / `pickDefaultTask`）补单测；组件测试视现有 ChartsRow 测试基建决定深度

## T7 回归与核对

- 全量：server + dashboard 测试套件通过；确认"全班状态/课堂动态/建议卡"零影响
- 兼容手工核对项：旧题目（无任务头）评审与水桶表现与改造前一致；重启回放含新旧混合行

## T8 发布

- 服务端镜像重建 + `docker compose up -d --force-recreate server`；dashboard 随镜像（`pnpm --filter @classroom/dashboard build` 已在镜像构建内）
- 扩展端无发版；内网/公网同构发布

## 明确不做

- 多文件作业聚合（预留 filePath 目录维度扩展位）
- Gitea 文件树接口 / 管理页选择器（被大屏卡内下拉取代）
- 学生端回执 UI 改版（reason 服务端拼接即可）
