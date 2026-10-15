# 设计：学生分支直连模型（拉取/提交/同步/切换 Git 原语化）

- 日期：2026-10-15
- 状态：待实现（设计已与教师逐节确认通过）
- 涉及仓库：classroom-assistant（服务端瘦身）、vscode-pylearner（扩展端 git 模块）

## 1. 背景与动机

当前实现为「快照同步模型」：学生端经 HTTP 传输代码快照 → 服务端入库（SQLite 全文）→ 服务端在单一工作树（`data/exercises-repo`）中代写学生分支。该模型为「题目可变」设计了三套复杂机制：

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
| 目录命名自由 | 作业不再强制 `week-数字` 命名；任意名一级子目录均可（识别规则见 2.1） | — |
| 学生零 Git 认知 | git 全部由扩展代执行（child_process 调本机 git CLI），学生只见按钮 | — |
| 门禁 | 防冒充与现状等价（花名册级：学号 + 姓名可冒领，无密码体系）；**防越权升级为凭证级**（每生 Gitea 账户 + 分支保护，详见 2.2） | — |
| 评审/L1/监控不动 | F5 评审触发（请求自带代码文本）、L1 归档、SSE 监控链路保持原样 | — |

### 2.1 作业识别：学生端零识别

**学生提交的全部内容均视为归档对象**（`git add -A`），学生端不做任何作业识别：

- 提交/同步/切换操作对象 = 整个工作区（.gitignore 挡 `__pycache__`、`*.pyc`、`.venv/` 等垃圾）
- 学生自建文件（笔记、草稿）一并进入个人分支——分支语义从「作业归档」升级为「学生工作区归档」，丢机恢复更完整；教师浏览以 `submit:` commit 记录为准，无干扰
- **练习定位靠文件路径**：路径不可变前提下，(路径 → 题目) 为稳定映射——F5 评审请求直接带文件路径 + commitHash，服务端按路径查 exercises 表。**文件头 exercise-id 注入机制整体退役**（教师 push main 即布置，服务端对仓库只读不回写，「教师写新作业前需先 pull」的注入回推陷阱随之消失）
- 教师仓库目录命名自由（`week-数字` 约定退役，任意一级子目录均可）

**服务端侧识别保留**（与学生提交无关）：syncNow 扫描教师仓库维护 exercises 表（评审需读题面 + 测试用例锚点），扫描规则放宽为内容特征（目录内 `.py` = 单文件练习；含 `exercise.json` 的子目录 = 项目练习；下划线开头或无特征 = 排除）。作业标题默认 = 目录名（管理页可改）。exerciseId 退化为 exercises 表内部主键；review_cache key 改为 `sha256(路径 + versionHash + code)`。

### 2.2 账户模型：每生一 Gitea 账户（凭证级防越权）

- **建号**：花名册导入时服务端联动 Gitea 管理员 API 批量建号（用户名 = 学号）+ 生成 token 存 DB；逐分支配保护规则（`student-XXXX` 分支仅允许对应用户 push，脚本循环）
- **token 下发**：学生身份页输入学号姓名 → 花名册校验通过 → 服务端在响应中返回**该生专属 token** → 扩展用于本机 git 操作，学生零感知
- **效果**：任何学生的 token 物理上无法 push 他人分支（Gitea 403）；push 日志记录真实账号（审计可查）；单生 token 泄露仅影响本人，可单独重置
- **边界（诚实声明）**：防冒充未升级——知道他人学号 + 姓名仍可冒领 token（姓名非秘密），如需更强须引入密码体系，课堂场景不建议

## 3. 总体架构

```
教师 ──push（放好即布置）──▶ Gitea main（题目不可变，只增不改）
                  ▲                    │
                  │ fetch + 只新增同步   │ clone / push（扩展代执行，学生零认知）
学生机 ◀──────────┴────────────────────┘
   │
   └─push 成功后 ──▶ POST /api/submissions/notify（学号 + 文件清单 + commit hash）──▶ 服务端
                                                                              │
服务端（旁路化）：轻量索引 + SSE 监控 + 评审（F5 触发）+ L1 归档 + 管理页 + 题目同步（对账 main）
```

服务端退出作业内容通道：不再向学生下发题目内容，不再代写学生分支。

## 4. 学生机 Git 模型（vscode-pylearner）

### 4.1 workspace 即克隆

- 扩展检测 workspace 根目录非 git 仓库时，引导首次 `git clone`（repo URL 由扩展配置 `pylearner.gitRepoUrl` 下发；认证用**该生专属 token**——身份校验通过后由服务端返回，见 2.2，不落扩展配置）
- 克隆后 workspace 自带全量历史；写入 `.gitignore`（`__pycache__/`、`*.pyc`、`.venv/` 等）

### 4.2 分支规则

- 工作分支：`student-<学号>`，本地跟踪 `origin/student-<学号>`；不存在时自 `origin/main` 创建
- 分支创建/切换仅发生在身份通过花名册校验之后（沿用现有身份页流程）

### 4.3 拉取（先同步自己 + 只新增）

多电脑场景必须先收敛本地分支与远端（否则落后的工作区会把旧文件/原始题面 rebase 上去，覆盖其他电脑提交的学生代码）。拉取两步走：

1. **同步自己**：`git fetch origin` + `git rebase origin/student-<学号>`（本地无未推送提交时退化为 fast-forward pull；rebase 冲突走 4.4 的冲突提示）
2. **只新增**：`git diff --diff-filter=A --name-only HEAD origin/main` 取 main 相对本分支的新增文件 → `git checkout origin/main -- <paths>` → commit

效果：main 的新作业（新目录/新文件）进入学生分支与工作区；main 对已有文件的任何修改**天然不生效**——前提被破坏时系统静默降级为「学生看不到勘误」，无数据事故。

### 4.4 提交

1. **分支断言**：校验当前分支 == `student-<globalState 学号>`，不一致直接拒绝（防手动 `git checkout` 绕过身份绑定；凭证级防护由 Gitea 分支保护兜底）
2. `git add -A`（整个工作区，.gitignore 挡垃圾文件；学生自建文件一并归档）
3. `git commit`（author 由扩展按 globalState 身份写入：`学号 姓名 <学号@classroom>`；时间戳由本机 git 落，服务端 notify 时间以 DB `submitted_at` 为准）
4. push 前自动 `fetch + rebase`（同一学生多台电脑都有离线提交时收敛分叉）；rebase 冲突 → 提示「与你在其他电脑的提交冲突，需选择保留版本」
5. `git push origin student-<学号>`

断网场景：commit 本地成功、push 失败 → 提示「已本地保存，联网后可补推」（新增的离线提交能力）。

幂等：内容无变化 → nothing to commit → 提示无变更，天然幂等（无需 codeHash 双端机制）。

### 4.5 同步作业（按钮文案；旧名「恢复我的提交」）

先 `fetch + rebase origin/student-<学号>`（同 4.3 第 1 步，防从落后分支同步出旧状态），再 `git checkout student-<学号> -- .`（整个工作区，含学生自建文件）：让本地工作区与远端自己分支的最新状态一致，覆盖三个场景——删了文件找回、改乱还原、换电脑拿下来。**会丢弃未提交的修改，执行前弹确认框**（沿用现有恢复按钮的确认交互）。本地克隆即全量，断网可翻历史。原「查 DB → 写回 → 拉取补缺」三段式退役。

与拉取的分工：两按钮共享收敛步骤（4.3 第 1 步），差异在对未提交修改的态度——拉取只添加新题目文件、保留工作区已有内容（日常高频、温和）；同步强制重置为已提交状态（刻意恢复、暴力+确认）。

### 4.6 切换学号（一键换机）

保留 switchFlow 四段编排，各段替换为 git 原语：

1. 旧身份归档 = `add -A + commit + push`（失败中止切换，不变）
2. 清空/重建 = `git checkout student-<新学号>`（分支不存在则自 origin/main 创建）+ `git clean -fdX`（清除前一位学生残留的 ignored 缓存垃圾；A 的自建文件已在归档步骤随 add -A 进入 A 的分支，checkout 时自动从工作区清除——共用机隐私优于现状）
3. 同步 = `git pull origin student-<新学号>`（远端分支尚不存在 = 新学生首次使用 → 忽略 pull 失败，工作区即刚创建的 main 基线）
4. untracked 自建文件天然跟随

### 4.7 会话确认门禁

不变（`sessionConfirm`：设置身份 = 已确认；重启后首次点作业按钮确认）。

## 5. 提交通知（替代 webhook）

扩展 push 成功后向服务端发轻量通知：

```
POST /api/submissions/notify
{ studentId, studentName, commitHash, files: string[], pushedAt }
```

- `files` 为本次 push 涉及的文件清单（`git diff --name-only <push 前远端分支指针> HEAD`；离线补推时一次 push 可能含多个积压 commit，故按 push 范围而非单 commit 取清单；学生端零识别）
- 服务端拿文件清单对照 exercises 表得出练习明细，写入轻量索引 + SSE 广播 `submission_received`（监控面板数据源不变）

**选扩展主动 notify 而非 Gitea webhook 的理由**：扩展是唯一知道本次推送语义的地方；webhook 需服务端反向解析 commit diff，复杂且易错。通知失败由扩展端重试。

## 6. 服务端瘦身（classroom-assistant）

### 6.1 删除

| 模块 | 内容 |
|---|---|
| 发布机制 | `publishAssignment`、`buildPublishedList`、`/api/assignments/published`、`/api/assignments/:id/publish`、管理页发布/取消按钮与状态列 |
| 内容下发 | `/api/exercises/:id/content`（学生直接从 git 获取题目） |
| 代写分支 | `writeToStudentBranch`、`createStudentBranches`、`retryFailedPushes`、`git_synced` 字段及单工作树串行队列全部配套 |
| 快照入库 | `POST /api/submissions` 的快照校验/入库链（`validateFiles`、codeHash 双端幂等） |

### 6.2 改造

- `submissions` 表 → 轻量索引：`id / student_id / student_name / exercise_id（服务端按路径对照 exercises 表得出）/ commit_hash / files_json（路径清单）/ submitted_at / review_json`（不存代码全文）
- 评审回填：按 `(exercise_id, student_id, commit_hash)` 定位记录；F5 评审请求改带**文件路径 + commitHash**（服务端按路径解析练习）

### 6.3 保留不动

- L1 归档全链路（`/api/trace/archive`、位点续传）
- F5 评审触发、review_cache（key 改为 路径 + versionHash + code，请求自带代码文本与文件路径）
- 题目同步（syncNow 对账维护 exercises 表：题面 + 测试用例锚点，评审依赖它；注入回写退役，服务端对教师仓库只读）；gitService 仅保留 main 侧操作；对账扫描正则从 `^week-(\d+)$` 放宽为 2.1 的内容特征识别
- 管理页（作业列表、学生名册、立即同步）

## 7. 部署前提（一次性）

1. 机房批量安装 Git
2. **每生一 Gitea 账户**：花名册导入时服务端联动 Gitea 管理员 API 批量建号（用户名 = 学号）+ token 存 DB；逐分支配保护规则（`student-XXXX` 仅允许对应用户 push，脚本循环）；学生 token 经身份校验响应下发，不落扩展配置
3. 扩展新增配置项：`pylearner.gitRepoUrl`

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 教师误改 main 已有题面 | 只新增策略使修改不生效；学生看不到勘误为最坏结果，无数据事故 |
| 学生机 git 缺失/版本过旧 | 扩展启动时探测 `git --version`，缺失时给出安装引导提示 |
| push 时网络中断 | commit 已本地保存，提示补推；notify 失败扩展端重试 |
| 学生删本地克隆 | 重新 clone + checkout 自己分支即全量恢复（本地丢失不再依赖服务端 DB） |
| 单生 token 泄露 | 仅能写该生自己的分支（Gitea 分支保护拒绝越权 push），影响面限于本人；可单独重置该生 token，其他学生不受影响 |
| 同一学生多台电脑离线提交分叉 | push 前自动 fetch + rebase 收敛；rebase 冲突时提示选择保留版本（触发条件苛刻：两台机都离线提交且改同一文件） |

## 9. 发布能力的回归路径（本期不实现，备将来）

本期发布语义 =「教师放好文件 push main 即布置，学生拉取即发布闸门」。若将来需要严格发布控制（多人出题、统考等场景）：

- **prepare 分支 merge 即发布**——教师 push 到 `prepare`，发布 = 合并进 main（Gitea 网页或管理页按钮触发服务端 merge）。学生端/服务端零改动，纯增量引入
- 备选：服务端发布清单 + 扩展拉取过滤

## 10. 测试策略

- 扩展端：git 模块单元测试（fake child_process）；拉取只新增/提交幂等/切换归档中止等场景沿用现有 switchFlow 测试骨架改造
- 服务端：notify 接口校验链（花名册/练习存在性）+ 轻量索引往返 + SSE 广播
- 集成：本地 bare 仓库模拟 Gitea，走通 拉取→提交→notify→评审→监控 全链
