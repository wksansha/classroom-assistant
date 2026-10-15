# 设计：学生分支直连模型（拉取/提交/同步/切换 Git 原语化）+ 作业域退役

- 日期：2026-10-15
- 状态：Task 1-11 已实现闭环（见 .superpowers/sdd/2026-10-15-student-git-branch-model/progress.md）；§0 作业域退役（Task 12）待实现
- 涉及仓库：classroom-assistant（服务端极致瘦身）、vscode-pylearner（Task 12 零改动）

## 0. 作业域退役（2026-10-15 补充裁决，Task 12）

Task 1-11 落地后，用户决定把作业域整个砍掉，比原设计更彻底。

**动机**：题目不可变 + 路径不可变前提下，「作业/练习」实体只剩三个服务对象——(a) syncNow 对账维护 exercises 表；(b) 给 LLM 提供题面/测试锚点；(c) 管理页作业列表。而：

- **题面本就在文件里**：题目文件中 `# ===== 代码区 =====` 分隔线之前的注释即题面，其后为学生代码。F5 评审请求自带的 code 全文就是完整评审素材，不需要 DB 题面锚点
- 练习定位纯路径化：notify/评审只需要 filePath，无需路径→练习实体对照
- 管理页作业列表非硬需求

**退役清单**（服务端）：

| 删除 | 说明 |
|---|---|
| `exercises` / `assignments` 表及全部 CRUD | 启动时对存量库 DROP，重建走新 DDL |
| `syncService`（syncNow 对账 + 定时同步 + `POST /api/sync`） | 服务端不再扫描任何仓库 |
| `gitService` | 服务端不再 clone 任何仓库；`data/exercises-repo` 工作目录本地删除 |
| `GIT_REPO_URL` / `GIT_REPO_DIR` / `GIT_SYNC_INTERVAL_MS` | `.env` / `.env.example` / 部署文档同步清理 |
| `exerciseResolver`（路径→练习对照） | notify 与评审均不再对照 |
| `GET /api/assignments`、`GET/PATCH /api/assignments/:id` | 作业域路由整体退役 |
| dashboard 作业列表 + 「立即同步」按钮 + assignments store/api | 管理页仅剩花名册面板 |

**保留**（全部路径化）：

- notify 轻量索引：**每次 push 一行**（`UNIQUE(student_id, commit_hash)`），`files` 原样入 `files_json` 不做对照；响应 `{ ok: true }`；不再广播 SSE
- 评审：`filePath + code（含题面注释全文）` 直达 LLM；无 404 not-exercise（所有文件皆可评审）；缓存 key = `sha256(filePath + 组装后评审输入)`
- 评审回填：`review_json = { [filePath]: ReviewResult }`，按 filePath upsert（同一次 push 多文件评审互不覆盖）
- `GET /api/submissions/student/:id` 保留（路径级明细查询）；`GET /api/submissions/exercise/:id` 删除
- 评审 fail 注入实时监控告警/知识点聚合（stateManager 链路）不动

**接受取舍**（用户已确认）：监控/索引只有路径级明细，无「作业→练习」聚合视图；题面锚点依赖教师把题面注释写进文件（无分隔线时全文视为代码）；LLM 无 DB 测试用例锚点。

**扩展端零改动**：F5 请求已携带 filePath + code（+ 项目 files 快照）；服务端 404 not-exercise 不复存在后，扩展的 404 分支自然死代码，保留作防御。

### 0.1 退役后数据模型

```
submissions(id PK, student_id, student_name, commit_hash, files_json, submitted_at, review_json)
  UNIQUE(student_id, commit_hash)                  -- 每次 push 一行
  review_json = { [filePath]: ReviewResult }       -- 评审回填按 filePath upsert
review_cache(cache_key PK, status, reason, source, model, hit_count, created_at)
  cache_key = sha256(filePath + 组装后评审输入)[:32]   -- 纯内容寻址，无 versionHash
events / error_cache / roster / student_tokens 不动
```

存量库迁移（启动时自动，不考虑迁移成本）：`assignments`/`exercises` 直接 DROP；`submissions`/`review_cache` 含 `exercise_id` 列则 DROP 重建（旧缓存 key 公式已失效，丢弃无损）。

### 0.2 评审输入组装（取代题面锚点）

- 无 `files`：评审输入 = `code` 原文（单文件题，题面注释在前）
- 有 `files`（项目快照）：`validateFiles` 通过后，全部 `.py` 按路径排序拼接（`# ===== 文件: <path> =====` 头），非 .py 不入；`code` 与入口一致性校验删除（服务端无 manifest 无法核对，扩展为可信内部客户端）
- LLM prompt：告知「`# ===== 代码区 =====` 分隔线之前注释为题目描述、之后为学生代码；无分隔线则全文为学生代码」

## 1. 背景与动机

原实现为「快照同步模型」：学生端经 HTTP 传输代码快照 → 服务端入库（SQLite 全文）→ 服务端在单一工作树（`data/exercises-repo`）中代写学生分支。该模型为「题目可变」设计了三套复杂机制：

1. 发布状态机（`isPublished`、发布清单、发布/取消按钮）
2. versionHash 版本对比层（本地未改但服务端变更 → 通知不覆盖）
3. DB 代码全文快照双保险 + `git_synced` 补推队列（单工作树串行队列的配套）

实际运行中，单工作树衍生出 checkout 竞态、index.lock、nothing-to-commit 死循环等真实故障面（2026-10-14 修复的补推死循环即为例证）。

**已确认的前提**：教师题目一经 push 到 main 不再修改（教师放好文件再 push，**push 即布置**；「学生拉取」即课堂发布闸门）。该前提下，上述三套机制失去服务对象，可整体退役，系统收敛为「分支即状态模型」：学生分支是学生工作区状态的唯一事实源，四个学生操作全部映射为 git 原语。

**不考虑迁移成本**（用户明确确认）。

## 2. 前提与约束

| 前提 | 说明 | 破坏时的兜底 |
|---|---|---|
| 题目不可变 | main 分支对已有题面文件只有新增（新作业目录/新文件），无修改；教师放好文件再 push（push 即布置，学生拉取即发布闸门） | 「只新增」拉取策略使修改天然不生效，学生端零事故；半成品已拉场景以目录重发兜底 |
| 路径不可变 | 作业目录名、文件名、文件位置一经 push 到 main 不再改名/挪动 | 「只新增」策略使移动表现为「旧路径消失 + 新路径新增」，旧提交历史仍完整可溯 |
| 目录命名自由 | 作业不强制 `week-数字` 命名；任意名一级子目录均可 | — |
| 学生零 Git 认知 | git 全部由扩展代执行（child_process 调本机 git CLI），学生只见按钮 | — |
| 门禁 | 防冒充与现状等价（花名册级：学号 + 姓名可冒领，无密码体系）；**防越权为凭证级**（每生 Gitea 账户 + 分支保护，见 2.2） | — |
| 评审/L1/监控不动 | F5 评审触发（请求自带代码文本）、L1 归档、SSE 监控链路保持原样（§0 评审锚点变化除外） | — |

### 2.1 作业识别：两端零识别

**学生端零识别**（Task 1-11 已实现）：提交对象 = 整个工作区（`git add -A`），练习定位靠文件路径，exercise-id 注入机制退役。

**服务端零识别**（§0 Task 12 裁决）：服务端无 exercises/assignments 表、无对账扫描；notify 的文件清单原样入库，评审按 filePath 定位回填。题面锚点 = 文件内注释（§0.2）。

### 2.2 账户模型：每生一 Gitea 账户（凭证级防越权）

- **建号**：花名册导入时服务端联动 Gitea 管理员 API 批量建号（用户名 = 学号）+ 生成 gitSecret（base64url 随机）存 `student_tokens` 表；逐分支配保护规则（`student-XXXX` 仅允许对应用户 push）；自动加教师仓库协作者（write）
- **下发**：学生身份页输入学号姓名 → 花名册校验通过 → 响应返回该生 gitSecret → 扩展组装 `学号:gitSecret` Basic 凭证，学生零感知
- **效果**：任何学生的凭证物理上无法 push 他人分支（Gitea 403）；push 日志记录真实账号；单生泄露仅影响本人，可单独重置
- **边界（诚实声明）**：防冒充未升级——知道他人学号 + 姓名仍可冒领 gitSecret（姓名非秘密），如需更强须引入密码体系，课堂场景不建议

## 3. 总体架构

```
教师 ──push（放好即布置）──▶ Gitea main（题目不可变，只增不改）
                  ▲                    │
                  │ fetch + 只新增同步   │ clone / push（扩展代执行，学生零认知）
学生机 ◀──────────┴────────────────────┘
   │
   └─push 成功后 ──▶ POST /api/submissions/notify（学号 + 文件清单 + commit hash）──▶ 服务端
                                                                            │
服务端（极致旁路化）：轻量索引 + SSE 监控 + 评审（F5 触发）+ L1 归档 + 花名册/Gitea 联动
```

服务端退出作业内容通道与作业域：不下发题目内容、不代写学生分支、不 clone 任何仓库、无作业/练习实体。

## 4. 学生机 Git 模型（vscode-pylearner，Task 1-11 已实现）

### 4.1 workspace 即克隆

- 扩展检测 workspace 根目录非 git 仓库时，引导首次 `git clone`（repo URL 由扩展配置 `pylearner.gitRepoUrl` 下发；认证用该生专属 Basic 凭证——身份校验通过后由服务端返回，不落扩展配置）
- 克隆后 workspace 自带全量历史；写入 `.gitignore`（`__pycache__/`、`*.pyc`、`.venv/` 等）

### 4.2 分支规则

- 工作分支：`student-<学号>`，本地跟踪 `origin/student-<学号>`；不存在时自 `origin/main` 创建
- 分支创建/切换仅发生在身份通过花名册校验之后（沿用现有身份页流程）

### 4.3 拉取（先同步自己 + 只新增）

1. **同步自己**：`git fetch origin` + `git rebase origin/student-<学号>`（rebase 冲突走 4.4 的冲突提示）
2. **只新增**：`git diff --diff-filter=A --name-only HEAD origin/main` 取 main 相对本分支的新增文件 → `git checkout origin/main -- <paths>` → commit

效果：main 的新作业进入学生分支与工作区；main 对已有文件的任何修改**天然不生效**——前提被破坏时系统静默降级为「学生看不到勘误」，无数据事故。

### 4.4 提交

1. **分支断言**：校验当前分支 == `student-<globalState 学号>`，不一致直接拒绝
2. **删除检测**：`git status --porcelain` 含删除条目时弹确认，取消则中止提交
3. `git add -A`（整个工作区，.gitignore 挡垃圾文件）
4. `git commit`（author 按身份写入；服务端 notify 时间以 DB `submitted_at` 为准）
5. push 前自动 `fetch + rebase`；rebase 冲突 → 提示「与你在其他电脑的提交冲突，需选择保留版本」
6. `git push origin student-<学号>`

断网场景：commit 本地成功、push 失败 → 提示「已本地保存，联网后可补推」。幂等：内容无变化 → nothing to commit → 提示无变更。

### 4.5 同步作业

```
① 若有未提交修改 → git stash -u（自动备份，零丢失兜底）
② fetch + rebase origin/student-<学号>
③ git checkout student-<学号> -- .（整个工作区，含学生自建文件）
```

执行前弹告知性确认。与拉取的分工：拉取温和只增（日常高频），同步强制重置为已提交状态（刻意恢复、stash 兜底 + 确认）。

### 4.6 切换学号（一键换机）

保留 switchFlow 四段编排：旧身份归档（add -A + commit + push，失败中止）→ `git checkout student-<新学号>`（不存在则自 origin/main 创建）+ `git clean -fdX` → `git pull origin student-<新学号>`（远端分支不存在 = 新学生首用，忽略 pull 失败）→ untracked 自建文件天然跟随。

### 4.7 会话确认门禁

不变（`sessionConfirm`：设置身份 = 已确认；重启后首次点作业按钮确认）。

## 5. 提交通知（替代 webhook）

```
POST /api/submissions/notify
{ studentId, studentName, commitHash, files: string[], pushedAt }
```

- `files` 为本次 push 涉及的文件清单（按 push 范围取，离线补推一次 push 可能含多个积压 commit）
- 服务端：花名册校验 → **原样入库**（每次 push 一行，`UNIQUE(student_id, commit_hash)` 幂等）→ 200 `{ ok: true }`
- 通知失败由扩展端重试；幂等由 UNIQUE 约束保证

## 6. 服务端形态（classroom-assistant）

### 6.1 模块清单（退役后）

| 模块 | 状态 |
|---|---|
| `persistence.ts` | events/error_cache/roster/student_tokens 不动；submissions 轻量索引（§0.1）；review_cache 去 exercise_id/version_hash；assignments/exercises 全删 |
| `controllers/notifyController.ts` | 花名册校验 + 原样入库，无对照、无 SSE |
| `controllers/reviewController.ts` | 无练习解析/404；files 校验 + 评审输入组装（§0.2）；回填按 filePath；fail 注入保留 |
| `reviewService/` | key = sha256(filePath + 评审输入)；prompt 单 code 入参（§0.2） |
| `routes/submissions.ts` | notify + `GET /api/submissions/student/:id` |
| `routes/roster.ts` + `gitea/adminApi.ts` | 花名册 + 建号/gitSecret/分支保护/协作者联动（不动） |
| L1 归档、监控 SSE（snapshot/update）、LLM 聊天代理 | 不动 |
| `syncService` / `gitService` / `assignmentFiles` / `assignmentController` / `exerciseResolver` / `routes/assignments` | **删除** |

### 6.2 启动装配

`createApp` 不再有 git/sync 装配与启动钩子；`AppDeps.git`/`syncAutoStart` 字段删除。

## 7. 部署前提（一次性）

1. 机房批量安装 Git
2. 每生一 Gitea 账户：花名册导入联动建号 + 分支保护 + 协作者授权（自动）；gitSecret 经身份校验响应下发
3. 扩展配置项：`pylearner.gitRepoUrl`

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 教师误改 main 已有题面 | 只新增策略使修改不生效；学生看不到勘误为最坏结果，无数据事故 |
| 学生机 git 缺失/版本过旧 | 扩展启动时探测 `git --version`，缺失时给出安装引导提示 |
| push 时网络中断 | commit 已本地保存，提示补推；notify 失败扩展端重试 |
| 学生删本地克隆 | 重新 clone + checkout 自己分支即全量恢复 |
| 学生误删文件后提交 | 提交前删除检测确认；题目文件误删后下次拉取自动恢复；自己的代码历史 commit 可找回 |
| 单生 gitSecret 泄露 | 仅能写该生自己的分支（Gitea 分支保护拒绝越权 push）；可单独重置 |
| 同一学生多台电脑离线提交分叉 | push 前自动 fetch + rebase 收敛；冲突时提示选择保留版本 |
| 题面注释缺失/格式不符 | LLM 按纯代码评审，不确定时返回 unreviewed（不缓存，可重试）；无数据事故 |

## 9. 发布能力的回归路径（本期不实现，备将来）

本期发布语义 =「教师放好文件 push main 即布置，学生拉取即发布闸门」。若将来需要严格发布控制（多人出题、统考等场景）：

- **prepare 分支 merge 即发布**——教师 push 到 `prepare`，发布 = 合并进 main（Gitea 网页或管理页按钮触发服务端 merge）。学生端/服务端零改动，纯增量引入
- 备选：服务端发布清单 + 扩展拉取过滤

## 10. 测试策略

- shared：reviewPrompts 新 prompt 单测；assignment.ts 缩减后删除 scanExerciseId 测试
- 服务端：notify 直存/幂等/名册校验；评审（无锚点）输入组装 + 回填 filePath map + 缓存 key 内容寻址；存量库 DROP 迁移
- dashboard：管理页仅花名册面板；SSE 仅 snapshot/update
- 全量验证前停 dev server（3000 端口）；已知基线：AlertPanel 1 例 canvas 快照失败（与本变更无关）
