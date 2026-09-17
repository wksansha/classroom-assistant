# 课堂教学实时助教系统 · 总体设计

日期：2026-09-17
状态：已经用户确认（分期按用户要求调整：下行通道/匿名投屏/顶部栏后置）

## 1. 背景与目标

面向 20 人班级的 Python 课堂。学生端 learner（VS Code 扩展，已存在）把练习中的报错实时上报；教师端仪表盘帮老师在一句内回答四个问题：

1. 全局感知 —— 全班现在什么状态？
2. 优先级决策 —— 先帮谁？
3. 教学洞察 —— 大家卡在哪（共性还是个例）？
4. 行动指引 —— 我该干什么？

设计原则：减少认知负担而非增加信息量；异常优先（该关注的推到眼前）；技术错误翻译成教学语言（ZeroDivisionError →「边界条件处理」）；服务端算、前端画。

## 2. 系统组成

```
┌──────────────────┐   POST /api/events       ┌─────────────────────┐
│ 学生端 learner    │ ───────────────────────▶ │  服务端 server       │
│ (VS Code 扩展)    │                          │  Node.js + Express  │
│  上报错误(V1已有)  │                          │  + TypeScript       │
│  接收提示/任务(V2) │ ◀─────────────────────── │  · 状态管理(内存)     │
└──────────────────┘  GET /api/stream/student  │  · 聚合计算          │
                       (SSE per-student, V2)   │  · LLM 解释+缓存     │
                                               │  · SQLite 持久化     │
┌──────────────────┐   GET /api/stream/teacher │                     │
│ 教师端 dashboard  │ ◀─────────────────────── │                     │
│  Vue3+Vite+TS    │   REST /api/summary 等    │                     │
└──────────────────┘ ────────────────────────▶ └─────────────────────┘
```

三端通过 `packages/shared` 共享同一套 L1 事件类型与 DTO 定义，契约只有一份。

## 3. 技术决策（已确认）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 后端语言 | Node.js/Express + TypeScript | 三端同构共享类型；SSE+内存状态是 Node 主场；20 人规模无性能压力 |
| 教师端架构 | 前后端分离，Vue3 + Vite | 五模块 + 抽屉/交互，预计 1500+ 行，单文件不可维护；后端纯 API，构建产物由后端静态托管 |
| 下行通道 | learner 连 SSE（V2 实现） | 在线状态天然准确，提示/任务实时触达 |
| 实时推送 | SSE（不用 WebSocket） | 单向推送足够，实现简单 |
| 存储 | 内存为课堂状态主存储，SQLite 持久化事件/缓存 | 一节课数据量小，重启清零课堂状态可接受 |

## 4. 工程结构（monorepo）

```
classroom-assistant/
├── packages/
│   ├── shared/        # L1 事件类型、API DTO、错误分类映射、知识点提示词模板
│   ├── server/        # Express + TS（现 demo 的 cache/llm/db 逻辑迁入）
│   └── dashboard/     # Vue3 + Vite + TS，构建产物由 server 静态托管
└── learner/           # 已有 VS Code 扩展（可保留独立仓库，引入 shared 包）
```

包管理：pnpm。开发期 Vite dev server 将 `/api` 代理到 server；生产由 server 托管 `dashboard/dist`。

## 5. 服务端模块

| 模块 | 职责 | 来源 |
|------|------|------|
| eventIngress | 接收上报、校验、标准化（L1 与 flat 两种格式） | 迁移现有 normalizeEvent |
| explainService | LLM 解释 + 内存/SQLite 缓存 + 并发去重 + mock 兜底 | 迁移现有 cache.js/llm.js |
| stateManager | 课堂状态唯一事实源：学生表、每生错误序列、错误聚合、当前任务(V2) | 新建 |
| aggregator | 事件触发重算：状态色、优先级分、错误聚合、教学建议 | 新建 |
| teacherHub | SSE 推送聚合结果给仪表盘（快照 + 增量） | 改造现有 SSE |
| studentHub | per-student SSE，推提示/任务，连接即在线（V2） | 新建 |
| taskService | 设置/广播当前任务并打任务标签（V2） | 新建 |
| persistence | SQLite：events、error_cache、hints_log(V2) | 迁移现有 db.js |

**状态判定（V1，仅基于上行事件估算）：**
- 绿色（顺利）：最近 5 分钟无错误事件（若 learner 已放开 runSuccess 上报：最近有成功运行事件同样视为绿色）
- 黄色（自查中）：最近 2 分钟内有错误事件，且未达到红色条件
- 红色（需帮助）：同一错误 5 分钟内重复 ≥3 次，或连续错误 ≥5 次
- 离线：V1 不展示离线状态（从未上报或超过 5 分钟无事件的学生一律按绿色「顺利」处理；V2 有 learner 连接后再引入真实离线判定）

**优先级分（V1 基础版）：**
```
score = 重复次数×10 + 距上次报错分钟数×5
      + 20（距上次事件 >3 分钟且有未解决错误）
      + 30（连续错误 ≥5）
```
告警条取 score 前 5 名，其余一句话概括（"其余 N 人正常"）。

**教学建议生成规则（V1）：**
- 某错误涉及人数占比 ≥40% →「⚠️ N 人卡在「知识点」，建议全班讲评」
- 占比 ≥20% 且 <40% →「💡 N 人遇到「知识点」，可小组讨论」
- 连续报错 ≥3 的学生 →「🙋 张三、李四 连续报错，建议单独辅导」
- 点击建议可"标记已处理"，避免重复提醒

**错误解释：由大模型生成（不维护静态映射表）**

真实课堂中学生会接触各种文件与样本，种类远超任何枚举（演示 trace 中的 Pylance 中文消息如 `应为 ":"`、`意外缩进`、`未定义"x"` 仅是格式示例）。因此分类、细分类型、知识点句全部由大模型在收到上报后输出，不写死映射。

提示词模板（shared 包内，run 与 diag 共用，diag 把样本原文作为"错误信息"传入）：

```
你是一位 Python 教学助手。请分析学生的错误，输出 JSON：
{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}

分类 category 必须从以下 8 类中选择：
语法错误 / 名称错误 / 类型错误 / 运算错误 / 容器访问错误 / 属性导入错误 / 文件权限错误 / 其他

要求：
- knowledge 面向初学者，说清 (1) 是什么知识点的问题 (2) 学生最可能哪里没懂，20 字左右，不要堆术语
- subtype 是这个错误的具体类型标签，例如"缺少冒号""意外缩进""除数为0""未定义变量"
- 只输出 JSON，不要解释

错误类型：{error_type}
错误信息：{error_message}
出错代码行：{code_line}
完整代码：
{full_code}
```

输出示例：

| 输入 | 大模型输出 |
|------|-----------|
| ZeroDivisionError + print(a/b) | {"category":"运算错误","subtype":"除数为0","knowledge":"除法边界条件：除数为 0 时会报错"} |
| NameError: 'totl' + print(totl) | {"category":"名称错误","subtype":"未定义变量","knowledge":"变量名拼写：totl 应该是 total"} |
| diag 样本「意外缩进」 | {"category":"语法错误","subtype":"意外缩进","knowledge":"缩进规则：Python 靠缩进划分代码块"} |
| diag 样本「未定义"x"」 | {"category":"名称错误","subtype":"未定义变量","knowledge":"变量要先赋值再使用，检查拼写"} |

**分类标签的取用规则：**
- run 事件：category 以 error_type 静态映射为准（ZeroDivisionError→运算错误等，确定性更高），subtype 与 knowledge 采纳 LLM 输出
- diag 事件：category / subtype / knowledge 全部采纳 LLM 输出（learner 上报的 error_type 是写死的 "DiagnosticError"，仅作占位）

**缓存设计（沿用 demo 三层结构）：**
- 缓存 key：run = error_type + error_message；diag = 样本文本。**均不含代码**——同一错误全班共享同一条结果，错误聚合才能按细分类型分组；代码内容只影响缓存未命中时的首次生成
- 缓存值 = {category, subtype, knowledge}
- 三层：内存 Map（热点）→ SQLite error_cache（重启不丢）→ pendingRequests 并发去重（同一错误并发只调一次 LLM）
- code_line / full_code：learner 当前不上报，字段预留为空，prompt 自动降级为仅错误类型+错误信息；learner 后续加报代码快照时服务端零改动
- LLM 失败或输出无法解析 → mock 兜底，按关键词输出同结构三字段（如 {"category":"运算错误","subtype":"除数为0","knowledge":"除法运算：除数不能为 0"}）

聚合面板按 subtype 分组展示（"缺少冒号 8 人 / 意外缩进 5 人"），比笼统的"语法错误 N 人"更利于教学定位。

## 6. 接口契约

**V1 实现：**

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/events` | POST | learner 上报（现有 L1/flat 格式不变，零改造） |
| `/api/stream/teacher` | GET SSE | 连接即推全量快照，此后推增量事件 |
| `/api/summary` | GET | 全量快照（首载/断线重连后补齐） |
| `/api/student/:id` | GET | 单生错误历史（抽屉详情） |
| `/api/suggestions/ack` | POST | 标记教学建议已处理（V1 仅存内存） |

**V2 增加：** `/api/stream/student?sid=`（SSE）、`/api/task`、`/api/hints`、hints_log 持久化。

## 7. 前端架构（Vue3）

```
dashboard/src/
├── api/sse.ts            # SSE 客户端：断线重连、快照合并
├── stores/classroom.ts   # Pinia：课堂状态（服务端推送结果的镜像）
├── components/
│   ├── AlertPanel.vue    # ② 告警条：≤5 条，优先级排序，[查看][发提示(V2)]
│   ├── StudentMatrix.vue # ③ 学生矩阵：响应式列数，点击→抽屉，悬停→最近3条
│   ├── ErrorAggPanel.vue # ④ 错误聚合：柱状+人数+展开名单+知识点翻译
│   ├── SuggestionBar.vue # ⑤ 教学建议：可标记已处理
│   └── StudentDrawer.vue # 学生详情：错误历史、停留时长、发提示(V2 禁用)
└── composables/
```

V1 顶部仅保留系统标题；当前任务/在线人数/计时/匿名投屏为 V2/V3 内容。

**时间显示**：一律 `new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })` 本地时区渲染（已踩过 UTC 差 8 小时的坑）。

## 8. 错误处理与降级

- LLM 调用失败 → mock 兜底（保留现有逻辑）
- LLM 返回无法解析 → mock 兜底
- 教师端 SSE 断线 → 5 秒重连，重连成功先拉 `/api/summary` 对齐快照
- 服务重启 → 课堂状态清零（一节课内可接受），历史事件在 SQLite 可查
- 学生离线 → V1 不展示（视为绿色「顺利」），V2 连接表上线后矩阵灰色「离线」
- 上报缺学生/班级字段 → 服务端填默认值（unknown/default），前端兜底显示「未知学生/未知班级」

## 9. 分期计划

**V1 上行闭环（本期目标）**
1. monorepo 搭建：pnpm + shared/server/dashboard 三包
2. shared 包：L1 事件类型、DTO、错误分类映射（error_type→分类）、知识点提示词模板
3. server 迁移 TS：eventIngress、explainService（缓存+去重+mock 兜底）、persistence
4. 新建 stateManager + aggregator：状态色、优先级、聚合、建议
5. teacherHub：快照+增量 SSE
6. dashboard：AlertPanel / StudentMatrix / ErrorAggPanel / SuggestionBar / StudentDrawer（发提示按钮禁用占位）
7. learner 零改造接入验证（现 simulator 亦可压测）；**强烈建议附带小改：reporter 放开 runSuccess 上报（约 5 行），否则状态色"绿色"分不清"没在用"和"用得顺"**
8. 部署配置清单：每台学生机配置 `pylearner.student.name/classId` 与 `pylearner.teacher.url`（指向教师机 IP）

**V2 下行闭环**：studentHub、learner 加 SSE + 通知 UI、发提示、任务广播、顶部栏（当前任务/在线 N/计时）、离线判定改连接表
**V2 同步**：learner 补 code_line/full_code 代码上下文上报（服务端 prompt 已预留，加字段零改动）

**V3 打磨**：匿名投屏、优先级算法调优、预期错误判断（结合当前任务）、错误趋势图、CSV 导出

## 10. 明确不做（YAGNI）

- 不做用户认证/多班级管理（课堂内网单班场景）
- 不做 WebSocket（SSE 够用）
- 不做前端算业务逻辑（全部服务端算）
- V1 不做发提示/任务/匿名投屏（后置到 V2/V3）

## 11. 学生端上报现状评估与差距（已核实 vscode-pylearner 源码）

**现状：**
- 上报走 flat 格式 POST `/api/events`（`src/teacher/reporter.ts`），student_id 取 SecretStorage（`pylearner.student.id`）兜底 `machineId`（稳定唯一），student_name 兜底 "Unknown"，class_id 兜底 "default"
- run 事件仅上报 execution_error：error_type/error_message 由 traceback 解析（500 字截断），含 file/line/exit_code/command/source
- diag 事件上报 samples 文本，error_type 写死 "DiagnosticError"
- **runSuccess（exit_code=0）在 L1 中已产生（runListener.ts），但 reporter 只放行 execution_error，成功运行被过滤未上报**
- 不上报任何代码内容；teacherUrl 默认 localhost
- **2026-09-17 补充核查（同日已修复）：教师上报管道曾编译不通过**（`reporter.ts` 的 `buildPayload` 引用不在作用域内的变量；`extension.ts` 的 `secrets.get` 未 `await`）——已由用户修复：`buildPayload` 显式接收 deps 传参、`applyTeacherReporter` 改 async 并支持配置变化动态开关、移除 profile 视图，`npx tsc --noEmit` 通过。差距 #2（runSuccess）仍待改，纳入实现计划 Task 21

**差距与修改方案：**

| # | 差距 | 影响 | 修改方案 | 改动侧 | 建议时点 |
|---|------|------|---------|--------|---------|
| 1 | student_name 兜底 Unknown、class_id 兜底 default | 矩阵 20 格全是 Unknown/默认班 | **暂缓定案（2026-09-17 用户决定）**：取值来源为扩展内 SecretStorage（settings.json 不生效），批量配置方案后续决定；未配置时服务端兜底显示 Unknown/默认班 | 待定 | 后续决定 |
| 2 | 成功运行不上报（reporter 过滤 runSuccess） | 绿色分不清"没在用"和"用得顺" | reporter 放开 runSuccess（约 5 行），服务器记为活动信号 | learner 小改 | V1 强烈建议 |
| 3 | 无代码上下文（code_line/full_code） | 知识点解释做不了个性化（"totl 应该是 total"） | run 事件补 code_line（按 file+line 读行）与 full_code（截断）；服务端 prompt 已预留字段，learner 加字段零服务端改动 | learner | V2 |
| 4 | diag 无真实 error_type（写死 DiagnosticError，仅占位） | 静态映射无法覆盖课堂中无限种样本 | diag 样本交 LLM 输出 category/subtype/knowledge（JSON），不维护样本映射表；真实 trace 样本仅作 prompt 格式参考 | 服务端 | V1 做（learner 零改） |
| 5 | teacherUrl 默认 localhost | 课堂学生机连不上教师机 | 部署时配置教师机 IP | 部署配置 | V1 必须 |
