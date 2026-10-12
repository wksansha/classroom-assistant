# 作业流 V2.0 设计（多文件项目 + 评审时机分离）

> 版本：V2.0 | 日期：2026-10-12 | 状态：待评审
> 范围：classroom-assistant（服务端）+ vscode-pylearner（学生端扩展）
> 决策历史：V1.x 曾设计「学生机安装 git + 双仓库 + 每生 Gitea 账号」方案，经完整重评（见 §11）后废弃；V2.0 回归「学生机不装 Git，服务端代管」的既有架构，仅做多文件扩展与评审时机分离。

---

## 1. 背景与目标

当前作业流以「单文件」为原子单位：服务端只扫描 `week-N/` 一级目录的 `.py` 文件，学生经 HTTP 逐文件拉取与提交。这无法支持**多文件项目型作业**（入口脚本 + 工具模块 + 数据文件）。

V2.0 在不动搬运通道（HTTP + 服务端代管 git）的前提下实现：

- **多文件项目作业**：一个项目 = 一个 exercise，含 manifest 的子目录整体下发、整体提交、整体归档
- **评审时机分离**：提交按钮 = 纯归档（不评审）；F5 运行成功 = 触发 LLM 评审（静态审查逻辑错误：结果不对、死循环、边界遗漏等运行不报错的问题）
- **评审 fail 进监控**：逻辑错误注入实时聚合面板，教师看到「哪些知识点普遍没掌握」（此前仅统计运行报错，评审 fail 只躺在提交矩阵里——探索实证：评审结果从不调 `stateManager.apply`，`index.ts:116` 的 `/api/events` 是聚合唯一写入口）
- **交互全面手动化**：取消自动拉取与运行后自动提交；「运行和调试」侧边栏新增三按钮面板
- **共享电脑身份安全**：会话身份确认弹窗 + 按学号分工作子目录

## 2. 架构总览（不变的部分）

```
学生机（无 git，无凭据）                服务端（唯一 git 持有者）
┌──────────────────────┐   HTTP    ┌───────────────────────────────┐
│ 扩展三按钮：            │ ────────► │ /api/assignments/published    │
│  拉取 ← files 数组写入   │           │ /api/submissions  (+files)    │
│  提交 → files 快照上报   │ ◄──────── │ /api/reviews/request（新）     │
│  恢复 ← 最新提交写回     │           │ gitService 代写 student-<学号>  │
└──────────────────────┘   SSE/回执  │ reviewService（缓存三态）       │
                                   └───────────────────────────────┘
```

- git 拓扑零变动：单一 Gitea 账号（classroom-server）走 127.0.0.1；学生分支惰性创建（现状）
- 未发布内容隔离：现有 published 过滤已保证，无泄漏面
- L1 监控链路（diag/run → 聚合/告警）零变动

## 3. 题目组织与扫描（服务端）

### 3.1 目录约定

```
仓库根/
├── week-3/                    ← 保留：分组 + 发布单位（现有语义不变）
│   ├── 01-hello.py            ← 一级 .py = 单文件练习（规则完全不变）
│   ├── weather-app/           ← 一级含 manifest 子目录 = 项目练习（新）
│   │   ├── exercise.json      ← manifest：服务端注入 exerciseId/week，教师只写 title/entry
│   │   ├── main.py            ← 题面写在入口文件头部注释（与单文件同一约定）
│   │   ├── utils.py
│   │   └── data/city.txt
│   └── notes/                 ← 无 manifest 子目录 = 忽略 + 扫描警告
└── 其他根目录                  ← 不扫描（现状不变）
```

manifest（教师版，只需两个可选字段）：

```jsonc
{ "title": "天气查询小项目", "entry": "main.py" }
// entry 缺省 "main.py"，文件不存在则扫描警告；exerciseId/week 由服务端首次扫描注入
```

### 3.2 扫描与对账（syncService 扩展）

- 身份识别：manifest exerciseId 优先，回退 `(week, 目录名)`——与单文件 `(week, filename)` 双轨同构
- 项目 versionHash：项目内**全部文件**（按路径排序）哈希，忽略 `__pycache__/`、`*.pyc`、`.venv/`、`venv/`、`.git/`、`.DS_Store`；变更触发评审基准切换警告（A30 语义）
- 注入：项目题注入 manifest JSON，**不改写学生可见的 .py 文件**；单文件题维持头部注入（现状）
- 无 manifest 子目录：忽略 + 扫描警告（防教师误放杂物目录）
- **exercise-id 保留**：提交定位、跨改名历史连续、评审缓存 key、对账锚点均依赖；教师学生无感（现状语义）

### 3.3 DB 迁移

| 表 | 变更 |
|---|---|
| `exercises` | 加 `kind`（'file'\|'project'，默认 file）、`dir`（项目目录名，可空）、`entry`（入口文件，可空） |
| `submissions` | 加 `files_json`（全量快照，可空）；`source` 枚举实际值加 'git' 无必要，维持 'manual'/'auto' |

### 3.4 发布冻结（产品规则，温和版）

发布后允许修改题面（错字/勘误），走现有「versionHash 变更 → 学生端提示不覆盖」链路（A30）；不做技术强制冻结。建议教师课堂纪律遵守「发布后不改结构」，仅修文字。

## 4. 服务端接口

### 4.1 提交 = 纯归档：`POST /api/submissions` 扩展

payload 在现有基础上加可选 `files` 数组（项目题必填，单文件题可省略维持旧行为）：

```jsonc
{
  "exerciseId": "...", "studentId": "2025001", "studentName": "张三",
  "source": "manual",
  "code": "入口文件内容",          // 兼容字段：单文件=code，项目=入口文件内容
  "filePath": "week-03/weather-app/main.py",
  "files": [                      // 新增可选：项目题全量快照
    { "path": "main.py", "content": "..." },
    { "path": "utils.py", "content": "..." },
    { "path": "data/city.txt", "content": "..." }
  ]
}
```

- **纯归档语义**：入库 + `submission_received` SSE + 服务端代写学生分支；**`review=NULL`，不触发评审**（现有 createSubmission 里的 `runReviewAndPublish` 异步调用移除）
- 校验链（现有基础上加）：`files` 非空时 `code` 必须等于入口文件内容；路径安全（拒绝 `..`/绝对路径）；文件数 ≤ 50、单文件 ≤ 100KB、总量 ≤ 500KB
- 幂等：项目题幂等键 = `(exerciseId, studentId, sha256(files 按 path 排序序列化))`；单文件题维持 `(exerciseId, studentId, sha256(code))`——统一为「内容哈希」，实现上 files 缺省时取 code
- 归档：`writeToStudentBranch` 扩展为写项目目录（`week-XX/<dir>/` 下写全部 files，删除式对齐教师端新增文件），单文件题行为不变；commit message 带项目目录名

### 4.2 运行触发评审（新）：`POST /api/reviews/request`

学生 F5 运行**成功**后，扩展发送工作区当前代码快照：

```jsonc
{ "studentId": "...", "exerciseId": "...", "code": "入口文件内容",
  "files": [ { "path": "...", "content": "..." }, ... ] }   // 与提交同构
```

- **评审语义**：LLM 静态审查逻辑错误（pass 标准 = 逻辑正确 + 处理边界 + 符合题目，而非「运行没报错」）；不实际执行学生代码；无法确定归 `unreviewed` 不猜测（现有 prompt 规则，[reviewPrompts.ts](file:///d:/ruan/classroom-assistant/packages/shared/src/reviewPrompts.ts) 不变）
- 校验链：花名册 → exercise 存在且 active 且已发布 → 尺寸限制同 §4.1
- **缓存**：key = `sha256(exerciseId + versionHash + 代码哈希)`（现有）；仅终态入缓存、unreviewed 不缓存 → 同一代码反复 F5 命中缓存不重复烧 LLM，内容变更自动重评（现有机制原样）
- **写回规则**：存在该 `(exerciseId, studentId)` 的提交记录 → 更新**最新一条**的 review + SSE `review_complete` + **注入聚合**（见 §5）；尚无提交记录 → 结果仅回传学生（扩展内展示评审回执），不落库
- 评审输入：项目题 = 入口文件 + 其余 `.py` 按路径拼接（带文件名分隔头）；单文件题 = code（现状）
- 响应：`{ review }` 同步返回（评审 2 秒级，GLM 实测），扩展直接展示回执

### 4.3 评审 fail 注入聚合（补「没对也上报」缺口）

评审结果为 **fail** 时，服务端构造一个合成事件写入 `stateManager.apply`：

```
{ studentId, studentName, ts: reviewedAt,
  eventType: "review_fail",        // 新事件类型，进 StudentRecord
  errorType: `review:${exercise.kind}`,   // 或复用 diag subtype 命名空间
  knowledge: review.reason }       // LLM 指出的逻辑错误即知识点线索
```

- 效果：fail 立即进入告警面板（学生变黄/红）与错误聚合（按 reason 聚合出「全班普遍卡在哪」）
- 复用现有 aggregator 全链路（computeScore/聚合/建议），`/api/events` 不动（它是 diag/run 的入口，评审走内部直调）
- shared 类型（StudentRecord/errorCategories）扩展 `review_fail` 枚举
- pass/unreviewed 不注入（不制造噪声）

### 4.4 拉取接口：`GET /api/exercises/:id/content` 扩展

项目题响应在现有单文件基础上扩展：

```jsonc
{ "kind": "project", "dir": "weather-app", "entry": "main.py",
  "problemStatement": "...", "starterCode": "...",
  "files": [ { "path": "main.py", "content": "..." }, ... ] }  // 经 git show main:week-XX/<dir>/ 递归读取
{ "kind": "file", ... "content": "..." }                        // 单文件响应不变（加 kind 字段）
```

发布校验（isPublished/isActive）沿用现有逻辑。

### 4.5 恢复接口：现有 `GET /api/submissions/student/:id` 扩展

响应行加 `files`（files_json 反序列化）；单文件题响应不变。

## 5. 学生端扩展（vscode-pylearner）

### 5.1 拉取作业（扩展 pullCommand）

- 项目题：content 响应的 `files` 数组按 `path`（相对项目目录）写入 `week-XX/<dir>/` 下，目录递归创建；沿用「已存在跳过 + versionHash 变更提示」（A30 语义，逐文件判定）
- 单文件题：现有行为不变
- 本地路径模型：`week-XX/` 不变；共享电脑按「工作子目录 = `基目录/<学号>/`」约定（新增可配置基目录 `pylearner.classroom.baseDir`，缺省 workspace root）

### 5.2 提交作业 = 纯归档（扩展 submissionReporter）

```
身份确认 → 保存脏文件 → 定位 exercise
→ 项目题：读项目目录全部文件（忽略清单同服务端）组 files 快照；单文件题：读当前文件
→ POST /api/submissions（files + code）→ 提示「已归档」（不评审）
```

- exercise 定位：`week-N` 相对路径 → 一级 .py 读头部 id（现状）；项目题读同目录 exercise.json 的 exerciseId（新）
- 幂等：客户端 lastHashes 键从 codeHash 改为内容哈希（与服务端同构：files 排序哈希 / 单文件 code 哈希）
- 运行成功自动提交链整体移除；`pylearner.submission.autoSubmit` 配置退役

### 5.3 运行成功 → 评审请求（改造 handleRunSuccess）

```
F5 运行成功（现有 runListener 检测不变）
→ L1 run 事件上报（监控，现状不变）
→ 定位当前文件所属 exercise（定位失败静默跳过——非作业文件）
→ 组装工作区快照（同提交口径）→ POST /api/reviews/request
→ 同步展示评审回执（pass ✅ / fail ❌ reason / unreviewed ⚪）
```

- F5 运行失败：仅 L1 run 错误事件进监控（现状），**不评审**
- 评审请求与提交互不触发：运行不归档、提交不评审
- 同一内容反复运行：服务端缓存命中直接返回，回执照常展示

### 5.4 恢复我的提交（扩展 restoreSubmissions）

- 项目题：读响应 `files` 数组按路径写回 `week-XX/<dir>/`；单文件题现状不变
- 换机恢复 = 拉取（模板）+ 恢复（我的最新代码），两命令组合（无需 git）
- 保留现有确认弹窗 + 「本地相同跳过」逻辑（扩展到逐文件判定）

### 5.5 交互手动化 + 三按钮面板

| 项 | 处置 |
|---|---|
| 打开文件夹自动拉取 | **取消**（extension.ts L449 `void runPull()` 移除），仅按钮 |
| 运行成功自动提交 | **取消**（见 §5.2），仅按钮；`autoSubmit` 配置退役 |
| 身份确认弹窗 | 点任一作业按钮时弹（每窗口会话一次）：「本机存储的身份是 2025001·张三，这是你本人吗？」`[是我本人]` `[切换身份]`；未确认则拦截该次操作 |
| 运行和调试侧边栏 | 新增「课堂作业」树形面板（TreeItem 三行：拉取/提交/恢复，图标+文字），点击执行对应命令；复用命令 id；右上角图标入口保留 |

### 5.6 共享电脑

- 工作子目录按学号隔离（§5.1 基目录约定）：张三的作业在 `<base>/2025001/`，李四在 `<base>/2025002/`，纯文件夹约定无隐藏状态
- 身份确认弹窗（§5.5）防「无意识用错身份」：弹窗+状态栏警告色 `$(warning) 学号 姓名?`，让错误无法静默发生
- 防护边界：蓄意冒用属教学管理问题，技术上限为三重校验留痕（会话确认 + 花名册 + 提交记录归属）

## 6. 测试策略

- **服务端单测（vitest）**：manifest 扫描对账（识别/忽略清单/无 manifest 警告/注入回写）、提交 files 校验链与项目哈希幂等、reviews/request（缓存去重/无提交记录不落库/写回最新记录）、评审 fail 注入聚合（stateManager 收到合成事件/告警出现）、content 端点 files 下发、writeToStudentBranch 写目录
- **扩展单测（vitest）**：exercise 定位（单文件/项目 manifest）、files 快照组装（忽略清单/路径安全）、拉取多文件写入与跳过、恢复多文件写回、身份确认状态机、lastHashes 新键
- **演示环境实测**：全流程（教师推项目题 → 发布 → 拉取 → 改代码 → 提交归档 → F5 评审 → fail 进聚合面板 → 删文件 → 恢复 → 换机场景模拟）
- **回归重点**：评审三态、学生分支归档（项目目录提交后分支文件完整）、现有单文件题全链路不回归；**注意**：启动补扫（`review_json IS NULL` 重扫）随纯归档语义退役——NULL 在 V2.0 是合法态（已归档未运行），保留补扫会在每次重启时自动评审全部归档提交

## 7. 迁移步骤（演示环境顺序）

1. 服务端：DB 迁移（exercises/submissions 新列）→ syncService 扫描扩展 → 接口扩展（submissions/reviews/content/恢复）→ 评审 fail 注入
2. 教师仓库：**零迁移**（现有单文件题不变；项目题按新格式新增即可）
3. 扩展：files 拉取/提交/恢复 + 评审请求 + 手动化 + 身份确认 + 三按钮面板；旧自动拉取/自动提交代码删除
4. 存量数据：submissions 历史与评审缓存原样保留；服务端重启补扫逻辑不变（对旧记录仍有效）
5. Gitea/部署环境：**零变动**

## 8. 风险清单

| 风险 | 缓解 |
|---|---|
| 项目题文件量大（学生放超多文件） | 提交尺寸限制（50 文件/100KB/500KB）+ 扫描端忽略清单 |
| 评审与归档错位（运行评审后又改代码才提交） | 接受：回执即时报学生，归档不可变；再次运行自动重评新代码 |
| LLM 静态审查非硬保证 | 三态设计（不确定归 unreviewed 不误判）；后续可加 manifest 测试用例增强（prompt 已兼容） |
| fail 注入聚合的噪声（反复 fail 刷屏） | 复用现有去重（5 分钟同 subtype 窗口/连续计数）；评审缓存使同代码不重复评审 |
| 共享电脑未提交草稿被覆盖 | 恢复有确认弹窗+相同跳过；按学号分目录隔离 |
| content 端点项目递归读文件数失控 | 与提交同一尺寸限制；扫描端忽略清单兜底 |
| 现有单文件题回归 | 单文件路径全部保持旧逻辑（files 缺省=旧行为），测试覆盖 |

## 9. 明确不做

- 学生机安装 git、Gitea 账号体系、token、双仓库、分支白名单（V1.x 方案废弃，理由见 §11）
- 未发布内容可见性（现有 published 过滤已覆盖，无泄漏面）
- 评审执行学生代码（纯静态审查；执行式判题属另一量级工程）
- manifest 测试用例（后续增强项，prompt 已预留格式）
- 防蓄意冒用身份的技术手段（弹窗+校验链已让错误无法静默发生）
- 提交强制截止拦截（截止日期仅展示提醒，现有语义不变）

## 10. V1.x → V2.0 决策对照

| V1.x（已废弃） | V2.0 |
|---|---|
| 学生机装 git，clone/push | 学生机零 git 零凭据，HTTP + 服务端代管（现状通道） |
| 双仓库镜像剔除未发布周 | 不需要（无 clone 泄漏面） |
| 每生 Gitea 账号 + token + 分支白名单 | 不需要（单一服务端账号，现状） |
| git-notify + git-token 接口 | 扩展现有 submissions 接口 + 新增 reviews/request |
| merge 冲突 abort 兜底 | 无冲突概念（跳过+提示，现状语义） |
| 学生分支 = 学生真实工作分支 | 学生分支 = 服务端代写的归档凭证（现状语义，写目录扩展） |

## 11. 废弃 V1.x 的评审依据（决策记录）

- 领域逻辑（manifest/评审/幂等/身份/UI）两方案等价，git 方案额外引入三个全新子系统（Gitea 账号自动化、双仓库镜像、扩展 gitClient）
- git 唯一实质优势（本地中间历史）受益场景与「不熟悉 git 的初学者」用户画像相反；VS Code Timeline 兜底常见误删
- Gitea 从归档旁路升级为作业流单点主路，可用性降级；故障面从 1 台服务器扩散到 40 台无人管理学生机
- 学生持可写 token 引入历史重写风险（归档可被本人 force-push 伪造）
- HTTP 的 files 数据模型（path+content 数组）与 git tree 一一对应，未来若需教 git 课程，迁移是平移非重写——选 V2.0 不封路
