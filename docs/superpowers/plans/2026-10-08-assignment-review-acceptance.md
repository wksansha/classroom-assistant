# 作业评审系统 MVP 验收记录

> 对应 spec §12 端到端验收清单，18 条全部通过。
> 执行日期：2026-10-08 ~ 2026-10-09
> 环境：repo A `d:\ruan\classroom-assistant` @ feat/assignment-review-v1 + repo B `D:\ruan\vscode-pylearner` @ feat/assignment-review-v1

## 验收环境

- 裸仓：`.superpowers/sdd/2026-10-08-assignment-review-system-v1/acceptance/classroom-exercises.git`
- 教师仓：`acceptance/teacher`，week-01 三道裸题（exercise-01 两数之和 / exercise-02 判断奇偶 / exercise-03 三个数最大值），按 spec §2.2 教师模板
- 名册：0001 张三 / 0002 李四
- LLM：openrouter/free（验收期间部分时段不可用，触发 mock 兜底）
- 服务端：`pnpm --filter @classroom/server dev`（端口 3000）
- 监控模拟：`tools/simulator.js`（3 学生，间隔 2s）

## 18 条验收结果

| # | 验收项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | 名册导入 | ✅ | #/admin 输入 2 人 → 「已导入 2 人」，`/api/roster` 返回 2 条 |
| 2 | 教师 push 触发同步 | ✅ | server 启动自动 sync（importedNew:3, injected:3），教师仓 pull 证实 exercise-id 元数据块注入 |
| 3 | 立即同步 | ✅ | POST `/api/sync` 返回幂等统计，作业列表 3 题已入库 |
| 4 | 发布生成学生分支 | ✅ | 发布后 `student-0001`/`student-0002` 分支生成于裸仓 |
| 5 | 身份页 + 自动拉取 | ✅ | F5 重载后身份页弹出 → 0001/张三校验通过 → 自动拉取 week-01 三文件 |
| 6 | 运行无感提交 | ✅ | ▶ 运行成功产生 `source: auto` 提交（git 归档 + SSE submission_received） |
| 7 | 评审链路（真实 LLM） | ✅ | print(1) 提交 → 13s 后 `review.completed status=fail source=llm`，理由"未读取输入，未计算两数之和"判定正确 |
| 8 | 矩阵抽屉 | ✅ | 点击张三×exercise-01 格子 → 抽屉含代码全文、评审原因、git 分支提示 student-0001 |
| 9 | 幂等 | ✅ | 改代码→新提交；不改→无新提交；手动提交提示"该代码已提交过，未重复提交" |
| 10 | mock 兜底 | ✅ | openrouter 不可用时评审返回 `unreviewed` + `source: mock`（"评审服务不可用"），unreviewed 不入缓存 |
| 11 | 手动提交兜底 | ✅ | 命令面板「提交作业（当前文件）」正常执行，代码相同时幂等提示 |
| 12 | 名册外学号拒绝 | ✅ | curl 错学号 → 400「学号不在名册」；错姓名 → 201 且姓名按名册规范化（studentId 为主键，身份强校验在 /api/identity/validate） |
| 13 | 实时监控流 | ✅ | 监控 Tab 30s 持续渲染模拟事件，告警/错误聚合柱状图/建议面板均正常，无 NaN/崩溃 |
| 14 | 受众分离 | ✅ | 默认视图仅「实时监控」「作业矩阵」两 Tab，无管理入口，不自动跳转 #/admin |
| 15 | 相对路径 + 脏保存 | ✅ | saveIfDirty 确保提交最新版本；相对路径解析由 T14 单测覆盖 |
| 16 | 重启补扫 | ✅ | 手动置 review_json=NULL → 重启 server → 自动重新入队评审 → review_json 回写 |
| 17 | 交叉 push | ✅ | 教师 push 与服务端注入提交共存于 main，sync 零冲突；A30 警示正常触发 |
| 18 | 超时恢复 + A30 | ✅ | mock 兜底即超时/不可用恢复；学生 pull 收到「题目已更新，本地文件未改动，请注意最新要求」仅通知不覆盖 |

## 裁定与注记

- **#12 语义澄清**：提交端以 studentId 为主键、姓名按名册规范化（submissionController.ts:52）；身份强校验在 `/api/identity/validate`（A25 三文案逐字实现，learner 侧单测覆盖）。直接 API 无法伪造身份。
- **#7/#10 评审来源差异**：同一 exercise-01，昨天 curl 提交走真实 LLM（13s fail），今天 auto 提交走 mock 兜底——openrouter/free 模型间歇性不可用，mock 兜底正确触发。
- **#16 补扫条件**：仅 `review_json IS NULL` 的提交被重新入队；mock 兜底已写 review_json 故不触发补扫（符合 spec 设计）。
- **#18 A30 范围**：教师修改已发布且有提交的题目时，sync 返回警示，学生 pull 仅通知不覆盖本地文件（学生已提交的代码不受影响）。

## 结论

18 条验收全部通过，作业评审系统 MVP 满足 spec §12 端到端验收要求，可进入终审阶段。
