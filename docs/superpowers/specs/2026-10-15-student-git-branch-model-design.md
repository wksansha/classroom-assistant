# 设计：学生分支直连模型（提交/拉取/恢复/切换 Git 原语化）

- 日期：2026-10-15
- 状态：待实现（设计已与教师逐节确认通过）
- 涉及仓库：classroom-assistant（服务端瘦身）、vscode-pylearner（扩展端 git 模块）

## 1. 背景与动机

当前实现为「快照同步模型」：学生端经 HTTP 传输代码快照 → 服务端入库（SQLite 全文）→ 服务端在单一工作树（`data/exercises-repo`）中代写学生分支。该模型为「题目可变」设计了三套复杂机制：

1. 发布状态机（`isPublished`、发布清单、发布/取消按钮）
2. versionHash 版本对比层（本地未改但服务端变更 → 通知不覆盖）
3. DB 代码全文快照双保险 + `git_synced` 补推队列（单工作树串行队列的配套）

实际运行中，单工作树衍生出 checkout 竞态、index.lock、nothing-to-commit 死循环等真实故障面（2026-10-14 修复的补推死循环即为例证）。

**已确认的前提**：教师题目一经布置不再修改。该前提下，上述三套机制失去服务对象，可整体退役，系统收敛为「分支即状态模型」：学生分支是学生工作区状态的唯一事实源，四个学生操作全部映射为 git 原语。

**不考虑迁移成本**（用户明确确认）。

## 2. 前提与约束

| 前提 | 说明 | 破坏时的兜底 |
|---|---|---|
| 题目不可变 | main 分支对已有题面文件只有新增（新 week 目录/新文件），无修改 | 「只新增」拉取策略使修改天然不生效，学生端零事故 |
| 学生零 Git 认知 | git 全部由扩展代执行（child_process 调本机 git CLI），学生只见按钮 | — |
| 门禁强度不变 | 身份仍经服务端花名册校验（`/api/identity/validate`），分支名由 globalState 学号派生；冒充难度与现状实质等价 | — |
| 评审/L1/监控不动 | F5 评审触发（请求自带代码文本）、L1 归档、SSE 监控链路保持原样 | — |

## 3. 总体架构

```
教师 ──push──▶ Gitea main（题目不可变，只增不改）
                  ▲                    │
                  │ fetch + 只新增同步   │ clone / push（扩展代执行，学生零认知）
学生机 ◀──────────┴────────────────────┘
   │
   └─push 成功后 ──▶ POST /api/submissions/notify（学号 + 练习列表 + commit hash）──▶ 服务端
                                                                              │
服务端（旁路化）：轻量索引 + SSE 监控 + 评审（F5 触发）+ L1 归档 + 管理页 + 题目同步
```

服务端退出作业内容通道：不再向学生下发题目内容，不再代写学生分支。

## 4. 学生机 Git 模型（vscode-pylearner）

### 4.1 workspace 即克隆

- 扩展检测 workspace 根目录非 git 仓库时，引导首次 `git clone`（repo URL 与通用学生 token 由扩展配置统一下发：`pylearner.gitRepoUrl`、`pylearner.gitToken`）
- 克隆后 workspace 自带全量历史；写入 `.gitignore`（`__pycache__/`、`*.pyc`、`.venv/` 等）

### 4.2 分支规则

- 工作分支：`student-<学号>`，本地跟踪 `origin/student-<学号>`；不存在时自 `origin/main` 创建
- 分支创建/切换仅发生在身份通过花名册校验之后（沿用现有身份页流程）

### 4.3 拉取（只新增策略）

不使用裸 `git merge origin/main`（教师误改已有题面时会冲突/覆盖）。改为：

1. `git fetch origin`
2. `git diff --name-only HEAD origin/main` 取 main 相对本分支的新增文件路径
3. 仅对这些路径执行 `git checkout origin/main -- <paths>` 后 commit

效果：main 的新题（新 week 目录/新文件）进入学生分支与工作区；main 对已有文件的任何修改**天然不生效**——前提被破坏时系统静默降级为「学生看不到勘误」，无数据事故。

### 4.4 提交

1. `git add week-*`（限定作业目录，学生自建文件不入库）
2. `git commit`（author 由扩展按 globalState 身份写入：`学号 姓名 <学号@classroom>`；时间戳由本机 git 落，服务端 notify 时间以 DB `submitted_at` 为准）
3. `git push origin student-<学号>`

断网场景：commit 本地成功、push 失败 → 提示「已本地保存，联网后可补推」（新增的离线提交能力）。

幂等：内容无变化 → nothing to commit → 提示无变更，天然幂等（无需 codeHash 双端机制）。

### 4.5 恢复

`git checkout student-<学号> -- week-*`：本地克隆即全量，断网可恢复可翻历史。原「查 DB → 写回 → 拉取补缺」三段式退役。

### 4.6 切换学号（一键换机）

保留 switchFlow 四段编排，各段替换为 git 原语：

1. 旧身份归档 = `add week-* + commit + push`（失败中止切换，不变）
2. 清空/重建 = `git checkout student-<新学号>`（分支不存在则自 origin/main 创建）
3. 同步 = `git pull origin student-<新学号>`
4. untracked 自建文件天然跟随（优于现状的「只删 week-*」规则）

### 4.7 会话确认门禁

不变（`sessionConfirm`：设置身份 = 已确认；重启后首次点作业按钮确认）。

## 5. 提交通知（替代 webhook）

扩展 push 成功后向服务端发轻量通知：

```
POST /api/submissions/notify
{ studentId, studentName, items: [{ exerciseId, commitHash, path }], pushedAt }
```

**选扩展主动 notify 而非 Gitea webhook 的理由**：扩展是唯一知道「本次提交覆盖哪些练习」的地方（collectTargets 语义）；webhook 需服务端反向解析 commit diff，复杂且易错。通知失败由扩展端重试。

服务端收到通知后：写入轻量索引 + SSE 广播 `submission_received`（监控面板数据源不变）。

## 6. 服务端瘦身（classroom-assistant）

### 6.1 删除

| 模块 | 内容 |
|---|---|
| 发布机制 | `publishAssignment`、`buildPublishedList`、`/api/assignments/published`、`/api/assignments/:id/publish`、管理页发布/取消按钮与状态列 |
| 内容下发 | `/api/exercises/:id/content`（学生直接从 git 获取题目） |
| 代写分支 | `writeToStudentBranch`、`createStudentBranches`、`retryFailedPushes`、`git_synced` 字段及单工作树串行队列全部配套 |
| 快照入库 | `POST /api/submissions` 的快照校验/入库链（`validateFiles`、codeHash 双端幂等） |

### 6.2 改造

- `submissions` 表 → 轻量索引：`id / student_id / student_name / exercise_id / commit_hash / submitted_at / review_json`（不存 code/files 全文）
- 评审回填：按 `(exercise_id, student_id, commit_hash)` 定位记录（F5 评审请求需增加 commitHash 字段）

### 6.3 保留不动

- L1 归档全链路（`/api/trace/archive`、位点续传）
- F5 评审触发、review_cache（key = exerciseId + versionHash + code，请求自带代码文本）
- SSE 监控、roster/身份校验
- 题目同步（syncNow 对账 + exercise-id 注入：exercises 表继续由其维护，评审读题面依赖它）；gitService 仅保留 main 侧操作
- 管理页（作业列表、学生名册、立即同步）

## 7. 部署前提（一次性）

1. 机房批量安装 Git
2. Gitea 建通用学生账号：只读 `main` + 只写 `student-*`（一条分支保护规则）；token 经扩展配置下发
3. 扩展新增配置项：`pylearner.gitRepoUrl`、`pylearner.gitToken`

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 教师误改 main 已有题面 | 只新增策略使修改不生效；学生看不到勘误为最坏结果，无数据事故 |
| 学生机 git 缺失/版本过旧 | 扩展启动时探测 `git --version`，缺失时给出安装引导提示 |
| push 时网络中断 | commit 已本地保存，提示补推；notify 失败扩展端重试 |
| 学生删本地克隆 | 重新 clone + checkout 自己分支即全量恢复（本地丢失不再依赖服务端 DB） |
| 通用 token 泄露 | token 仅能写 student-* 分支，破坏面限于分支内容；分支可从 notify 索引 + git 历史审计修复 |

## 9. 测试策略

- 扩展端：git 模块单元测试（fake child_process）；拉取只新增/提交幂等/切换归档中止等场景沿用现有 switchFlow 测试骨架改造
- 服务端：notify 接口校验链（花名册/练习存在性）+ 轻量索引往返 + SSE 广播
- 集成：本地 bare 仓库模拟 Gitea，走通 拉取→提交→notify→评审→监控 全链
