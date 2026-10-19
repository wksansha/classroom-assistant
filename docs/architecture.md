# Classroom Assistant 整体架构文档

> 版本：V1.0 | 更新日期：2026-09-23 | 分支：`feat/v1-upstream-loop`

---

## 1. 项目总览

Classroom Assistant 是一个**实时课堂编程错误监控与教学辅助系统**。它追踪学生的 Python 代码错误，通过 LLM 生成教学解释，并以 Server-Sent Events（SSE）方式实时推送给教师仪表盘。

**核心目标**：
- 实时收集学生编程错误
- 自动分类错误并生成教学知识点
- 为教师提供班级错误聚合视图和优先级建议
- 支持单学生错误历史追溯

**技术栈**：
- **后端**：Node.js + TypeScript + Express 5
- **前端**：Dashboard（构建产物托管于 server 静态目录）
- **数据库**：SQLite（better-sqlite3）
- **日志**：Winston（结构化 JSON 日志）
- **通信**：HTTP/JSON + SSE
- **LLM**：OpenAI 兼容接口（默认 OpenRouter，可选本地模型）

---

## 2. 项目结构

```
classroom-assistant/
├── packages/
│   ├── server/                # 后端服务
│   │   ├── src/
│   │   │   ├── main.ts        # 入口：加载环境、启动 Express
│   │   │   ├── index.ts       # 应用组装：路由 + 中间件 + 组件依赖注入
│   │   │   ├── logger.ts      # 结构化日志（Winston）
│   │   │   ├── eventIngress.ts # 事件归一化（L1 / Flat 双格式）
│   │   │   ├── stateManager.ts # 内存学生状态（LRU 200 条）
│   │   │   ├── persistence.ts  # SQLite 持久层
│   │   │   ├── aggregator.ts   # 实时聚合计算
│   │   │   ├── teacherHub.ts   # SSE 推送中心
│   │   │   ├── llmProxy.ts     # LLM 聊天代理
│   │   │   └── explainService/ # 解释服务
│   │   │       ├── index.ts    # ExplainService 接口
│   │   │       ├── llm.ts      # LLM 调用 + mock 兜底
│   │   │       └── cache.ts    # 三级缓存（内存/SQLite/LLM）
│   │   ├── package.json
│   │   └── .env.example
│   ├── shared/                # 共享 TypeScript 类型与常量
│   │   ├── src/
│   │   │   ├── index.ts        # 导出所有共享模块
│   │   │   ├── dto.ts          # 核心数据结构
│   │   │   ├── events.ts       # 学生上报事件格式
│   │   │   ├── prompts.ts      # LLM Prompt 模板
│   │   │   └── errorCategories.ts # Python 异常分类映射
│   │   └── package.json
│   └── dashboard/             # 教师前端（未在本上下文中展开）
├── docs/                        # 设计文档
├── pnpm-workspace.yaml
└── package.json
```

---

## 3. 核心模块详解

### 3.1 事件流入（Event Ingress）

**文件**：`packages/server/src/eventIngress.ts`

职责：将学生事件归一化为统一的 `NormalizedEvent`（内存链路用）与 `IngressEvent`（入库用，spec §4.1 单一格式）。

**单一格式（2026-10-16 起，Flat 双格式已退役）**：

客户端上报 TraceEvent 原样平铺 + 身份三字段：

```json
{
  "id": "run:01J0ARZ9V8B", "ts": "2026-10-16T06:31:14.754Z",
  "surface": "run", "kind": "execution_error",
  "payload": { "command": "python a.py", "exit_code": 1, "error_type": "ZeroDivisionError", "error_message": "division by zero", "code_snippet": "..." },
  "student_id": "2024001", "student_name": "张三", "class_id": "3A", "session_id": "s1"
}
```

**归一化逻辑**：
1. 校验 `id`（`^<surface>:[0-9A-Za-z-]{6,64}$`）、`surface`（6 枚举）、`kind` 非空，任一不符 → null（400）
2. 提取：`studentId`、`studentName`、`classId`、`eventType`（diag/run 才有值）、`ts`
3. 计算成功标志：`success = (surface === "run" && payload.exit_code === 0)`
4. 生成缓存键 `cacheKey`（仅 diag/run）：
   - run 成功 → null
   - run 失败 → `errorType: errorMessage`
   - diag → 首个样本（最短样本）
5. 记录 `event.normalized` 调试日志

**关键字段**：
- `rawMessage`：展示用原文（diag 取首样本，run 取 error_message）
- `codeSnippet`：错误代码片段（可选）
- `filePath`/`lineNo`：源码位置
- `command`/`exitCode`：运行命令与退出码

---

### 3.2 状态管理（State Manager）

**文件**：`packages/server/src/stateManager.ts`

职责：内存中维护每个学生的最新 200 条事件记录。

**数据结构**：
```typescript
StudentRecord {
  studentId, studentName, classId,
  events: StoredEvent[],       // 最多 200 条，超限移除最旧
  lastActivityAt, lastErrorAt, consecutiveErrors
}

StoredEvent {
  ts, eventType, success, subtype, category, knowledge, rawMessage, codeSnippet?
}
```

**处理流程**（`apply(ev, explanation)`）：
1. 新学生 → 创建空记录，打印 `state.new_record` 日志
2. 追加 `StoredEvent`（`explanation` 为 null 时，success=true 的记录 subtype/category/knowledge 均为 null）
3. LRU 淘汰：超过 200 条移除最旧
4. 更新时间戳与连续错误计数
5. 记录 `state.event_applied` 调试日志

**查询**（`getStudentDetail(id)`）：
- 返回学生事件列表（新在前，用于抽屉展示）
- 记录 `state.get_detail_success` 或 `state.get_detail_not_found`

---

### 3.3 持久层（Persistence）

**文件**：`packages/server/src/persistence.ts`

职责：SQLite 数据库操作，L1 事件流水两表 + 解释缓存表（roster/review_cache/student_tokens 见作业域）。

**数据库结构**：

| 表 | 用途 | 关键字段 |
|----|------|----------|
| trace_events | 事件原始事实表（全 surface，/api/events 与 /api/trace/archive 共用，按 event_id 幂等） | event_id, student_id, surface, kind, ts, session_id, payload, date |
| event_explanations | LLM 解释侧表（与 trace_events 一对一，仅 diag/run 失败事件） | event_id, category, subtype, knowledge, source |
| error_cache | 解释缓存 | raw_hash, raw_message, category, subtype, knowledge, source, hit_count |

**缓存机制**：
- `raw_hash` = SHA256(cacheKey)
- 读取时自动递增 `hit_count`
- `source` 字段区分来源：`llm`（真实 LLM）/ `mock`（兜底）

**WAL 模式**：`PRAGMA journal_mode = WAL`，支持并发读写。

---

### 3.4 解释服务（Explain Service）

**文件**：`packages/server/src/explainService/`

#### 3.4.1 缓存层（cache.ts）

职责：三级缓存 + 并发去重，避免重复 LLM 调用。

```
内存缓存 (Map) → SQLite 缓存 → LLM 调用
```

**缓存键**：`cacheKey`（NormalizedEvent 中的缓存键）

**处理流程**：
1. 内存命中 → 直接返回，记录 `cache.hit`（source: memory）
2. SQLite 命中 → 回填内存，记录 `cache.hit`（source: sqlite）
3. 并发去重 → 同 key 共享 Promise，记录 `cache.hit`（source: pending）
4. 缓存未命中 → 调用 LLM，记录 `cache.miss`
5. 结果写入内存 + SQLite，记录 `cache.save`
6. 内存上限 `CACHE_SIZE_LIMIT`（默认 1000），LRU 淘汰

#### 3.4.2 解释逻辑（llm.ts / index.ts）

**ExplainService.explain(ev)** 流程：
1. 成功事件 → 直接返回兜底解释（不调用 LLM）
2. 无 cacheKey → 返回兜底解释
3. 调用 `cache.getExplanation(cacheKey, llmCallFn)`
4. run 事件：`category` 由 `categoryFor(errorType)` 映射（不依赖 LLM 判断分类）
5. diag 事件：直接使用 LLM 返回的分类
6. 记录 `explain.completed` 日志

**LLM 调用（callRealLLM）**：
- 使用 `buildExplainPrompt(input)` 构造提示词
- 调用 OpenAI 兼容 `/chat/completions` 接口
- 解析返回文本中的 JSON（`parseLLMResponse`）
- 失败时回退到 mock 规则（`mockExplain`）

**Mock 规则**：基于错误关键词匹配 8 类常见错误（缩进、未定义变量、类型错误等）。

---

### 3.5 聚合器（Aggregator）

**文件**：`packages/server/src/aggregator.ts`

职责：根据学生记录实时计算教师仪表盘所需的所有聚合数据。

**课堂窗口**：默认 120 分钟（`CLASS_WINDOW_MIN` 环境变量），只统计窗口内事件。

#### 3.5.1 学生状态计算

```
状态判定（computeStatus）：
  score >= 40 → red
  score > 0   → yellow
  否则        → green

分数计算（computeScore）：
  无错误 → 0
  最后事件已解决 → 0
  超过课堂窗口 → 0
  基础分：10 + repeat * 10（5 分钟内同 subtype 重复次数）
  连续报错 ≥5 次：+30
```

#### 3.5.2 告警（Alerts）

取 `priorityScore > 0` 的学生，按分数降序取前 5 名。

告警原因：
- 连续报错 ≥5 次 → "连续报错 N 次"
- 同错误 5 分钟内 ≥3 次 → "同一错误 5 分钟内 N 次"
- 其他 → "报错后 X 分钟无进展"

#### 3.5.3 聚合（Aggregates）

按 `subtype` 分组，统计课堂窗口内涉及的学生数（去重）。

#### 3.5.4 建议（Suggestions）

| 条件 | 类型 | 文案 |
|------|------|------|
| subtype 涉及 ≥40% 报错学生 | class-review | "⚠️ N 人卡在「subtype」，建议全班讲评" |
| subtype 涉及 20%-40% | group-discuss | "💡 N 人遇到「subtype」，可小组讨论" |
| 连续报错 ≥3 次 | individual | "🙋 学生A、学生B 连续报错，建议单独辅导" |

建议支持 `ack` 标记已处理（内存中）。

---

### 3.6 教师中心（Teacher Hub）

**文件**：`packages/server/src/teacherHub.ts`

职责：管理 SSE 长连接，实时推送教师仪表盘快照。

**连接处理**（`handleStream`）：
1. 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`
2. 连接即推送全量快照（`type: "snapshot"`）
3. 每 25 秒发送心跳 `: ping\n\n`
4. 客户端断开自动清理

**推送**（`publish`）：
- 推送全量快照更新（`type: "update"`）
- 当前 V1 规模 <10KB，直接全量推送

---

### 3.7 主应用（Index / Main）

**文件**：`packages/server/src/index.ts`、`main.ts`

**应用启动流程**（`main.ts`）：
```
加载 dotenv → 创建 App（依赖注入）→ 启动心跳 → 监听端口
```

**路由表**：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/stream/teacher` | SSE 教师仪表盘连接 |
| POST | `/api/events` | 学生事件上报（核心入口） |
| GET | `/api/summary` | 全量快照 |
| GET | `/api/student/:id` | 单生错误历史 |
| POST | `/api/suggestions/ack` | 标记建议已处理 |
| GET | `/api/events` | 调试：最近事件 |
| GET | `/api/stats` | 调试：统计信息 |
| POST | `/api/llm/chat/completions` | LLM 聊天代理 |

**中间件**：
- CORS
- JSON 解析（限制 2MB，容纳聊天上下文）

---

## 4. 数据流（核心链路）

### 4.1 学生上报事件

```
学生 Reporter → POST /api/events → [Express]
  → eventIngress.normalize() → IngressEvent（400 兜底：非法格式/非法 student_id）
  → persistence.insertTraceEvent(row)                     ← 原始行必写（全 surface）
      → [diag/run 失败？] explainService.explain()
          → cache.getExplanation()
              → 内存命中？返回
              → SQLite 命中？回填内存后返回
              → 并发去重？等待共享 Promise
              → LLM 调用 → 解析 JSON → 缓存保存（source 如实标注 llm/mock）→ 返回
      → 解释与原始行同事务落库（event_explanations）
  → 幂等命中（duplicated=true）？不解释、不推看板，返回 {ok: true, duplicated: true}
  → [diag/run] stateManager.apply(ev, explanation)
  → hub.publish(buildSnapshot())
  → SSE 推送教师仪表盘
  → 返回 {ok: true, duplicated: false}
```

**归档通道**（`POST /api/trace/archive`）：扩展激活时批量上报（协议与客户端位点零改动），
批次头 `{student_id, class_id, surface, date}` + events 数组 → 单事务 `insertTraceEvents`
→ 只写 trace_events，不解释、不推看板 → 返回 `{ok, accepted, duplicated}`。

### 4.2 教师仪表盘

```
Dashboard → GET /api/stream/teacher → SSE 连接
  ← 全量 snapshot（连接时）
  ← update（每次事件处理后）

Dashboard → GET /api/summary → TeacherSnapshot（首载/断线重连兜底）
Dashboard → GET /api/student/:id → 学生事件详情（倒序）
```

---

## 5. 数据模型

### 5.1 共享类型（packages/shared/src/）

#### IngressEvent（上报事件，packages/shared/src/events.ts）
- 事件本体：`id`（`<surface>:<ULID>`）、`surface`（6 枚举）、`kind`、`payload`（原样 JSON）
- 身份：`studentId`、`studentName`、`classId`、`sessionId?`
- 派生（仅 diag/run）：`eventType`、`success`、`errorType`、`errorMessage`、`samples`、`rawMessage`、`codeSnippet`、`filePath`、`lineNo`、`command`、`exitCode`
- 缓存键：`cacheKey`（run: `errorType: errorMessage`，diag: 最短样本）

#### Explanation（解释结果）
```typescript
{ category, subtype, knowledge }
```
- `category`：8 大分类之一（语法错误、名称错误、...）
- `subtype`：具体错误类型标签（≤6 字）
- `knowledge`：面向初学者的知识点（~20 字）

#### TeacherSnapshot（仪表盘快照）
- `students[]`：所有学生状态（颜色、优先级、最近错误）
- `alerts[]`：前 5 名告警
- `alertSummary`：正常人数摘要
- `aggregates[]`：错误聚合（按 subtype 分组）
- `suggestions[]`：教学建议

### 5.2 数据库表

```sql
trace_events(event_id PK, student_id, student_name, class_id, surface CHECK(6 枚举),
             kind, ts, session_id, payload, date, ingested_at)
event_explanations(event_id PK/FK→trace_events, category, subtype, knowledge, source)
error_cache(raw_hash UNIQUE, raw_message, category, subtype, knowledge,
           source, hit_count)
roster(student_id PK, student_name, created_at)
review_cache(cache_key PK, status, reason, source, model, hit_count, created_at)
student_tokens(student_id PK, token)
```

---

## 6. LLM 交互细节

### 6.1 Prompt 构造

**文件**：`packages/shared/src/prompts.ts` → `buildExplainPrompt(input)`

固定模板 + 可变内容：
- 固定：角色定义、输出格式要求、分类列表
- 可变：`errorType`、`errorMessage`、`codeSnippet/fullCode/codeLine`

### 6.2 调用方式

- **协议**：OpenAI 兼容 `/chat/completions`
- **模型**：`LLM_MODEL`（默认 `openrouter/free`）
- **参数**：`temperature: 0.3`、`stream: false`
- **超时**：300 秒（`UPSTREAM_TIMEOUT_MS`）
- **日志**：`llm.request_started`（prompt 长度）、`llm.raw_response`（返回原文）、`llm.request_completed`

### 6.3 降级策略

| 条件 | 降级行为 |
|------|----------|
| 无 API Key | 直接 mock |
| API 错误 | mock + 记录 `llm.mock_fallback` |
| 返回不可解析 JSON | 抛错 + mock |
| 成功事件 | 不解释，直接兜底 |

---

## 7. 日志与可观测性

### 7.1 日志格式

统一单行 JSON：`level {"event":..., "field":..., "timestamp":..., "service":"classroom-server"}`

### 7.2 关键日志事件

| 事件 | 级别 | 含义 |
|------|------|------|
| `server.startup` | info | 服务启动 |
| `route.event_received` | debug | 收到学生事件 |
| `event.normalized` | debug | 事件归一化完成 |
| `llm.request_started` | debug | LLM 请求开始 |
| `llm.raw_response` | debug | LLM 原始返回 |
| `explain.completed` | debug | 解释完成 |
| `cache.hit` / `cache.miss` / `cache.save` | debug | 缓存命中/未命中/保存 |
| `aggregator.recompute` | debug | 聚合计算完成 |
| `sse.connect` / `sse.publish` | info/debug | SSE 连接/推送 |

### 7.3 日志级别

- `LOG_LEVEL` 环境变量控制，默认 `info`
- 调试 LLM/缓存/聚合详情需设 `LOG_LEVEL=debug`

---

## 8. 环境配置

### 8.1 环境变量（.env）

```bash
# LLM 配置（不填则使用 mock）
LLM_API_KEY=
LLM_BASE_URL=https://api.openrouter.ai/api/v1
LLM_MODEL=openrouter/free

# 日志
LOG_LEVEL=info

# 缓存
CACHE_SIZE_LIMIT=1000

# 课堂窗口（分钟）
CLASS_WINDOW_MIN=120

# 数据库
DB_PATH=

# 端口
PORT=3000
```

### 8.2 数据库路径

- 默认：`server 包/data/assistant.db`
- 可通过 `DB_PATH` 环境变量覆盖

---

## 9. 接口列表

### 9.1 核心接口

| 方法 | 路径 | 请求体 | 响应 |
|------|------|--------|------|
| POST | `/api/events` | IngressEvent（单格式） | `{ok: true, duplicated: boolean}`；幂等命中 duplicated=true 且不推看板 |
| POST | `/api/trace/archive` | `{student_id, class_id, surface, date, events[]}` | `{ok, accepted, duplicated}`；只写原始表不解释不推看板 |
| GET | `/api/stream/teacher` | - | SSE (TeacherSnapshot) |
| GET | `/api/summary` | - | TeacherSnapshot |
| GET | `/api/student/:id` | - | StudentDetail |
| POST | `/api/suggestions/ack` | `{id: string}` | `{ok: true}` |

### 9.2 调试接口

| 方法 | 路径 | 响应 |
|------|------|------|
| GET | `/api/events?limit=N` | 最近 N 条事件 |
| GET | `/api/stats` | {events, cache, runtime, onlineClients} |

### 9.3 LLM 代理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/llm/chat/completions` | OpenAI 兼容代理到 LLM |

---

## 10. 扩展点

1. **多班级支持**：当前 V1 单班级，`buildSnapshot` 取 `records[0]?.classId`
2. **增量 SSE**：当前全量推送，字段级增量留待性能需要
3. **缓存持久化**：ack 记录当前仅内存，重启后丢失
4. **日志落盘**：当前仅控制台，可扩展 Winston File transport
5. **LLM 提供商**：修改 `llm.ts`/`llmProxy.ts` 即可切换
6. **前端 Dashboard**：`packages/dashboard`，通过 `app.use(express.static(staticDir))` 托管

---

## 11. 依赖关系

```
@package/classroom/shared ← @package/classroom/server
                            ↓
Express 5 + better-sqlite3 + cors + dotenv + tsx + winston
```

**Server 依赖**：
- `@classroom/shared`：类型、Prompt、错误分类
- `better-sqlite3`：数据库
- `cors`：跨域
- `express`：Web 框架
- `dotenv`：环境变量
- `tsx`：TypeScript 直接执行（开发）
- `winston`：日志

---

## 附录

### A. 错误分类映射（errorCategories.ts）

| Python 异常 | 中文分类 |
|-------------|----------|
| SyntaxError / IndentationError / TabError | 语法错误 |
| NameError | 名称错误 |
| TypeError / ValueError | 类型错误 |
| ZeroDivisionError / OverflowError | 运算错误 |
| IndexError / KeyError | 容器访问错误 |
| AttributeError / ImportError / ModuleNotFoundError | 属性导入错误 |
| FileNotFoundError / PermissionError | 文件权限错误 |
| 其他 | 其他 |

### B. Prompt 模板（prompts.ts）

要求 LLM 输出严格 JSON：
```json
{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}
```

### C. 关键设计决策

1. **成功事件不解释**：避免不必要的 LLM 调用
2. **分类由 run 事件代码映射**：diagnostic 不确定来源，run 错误类型明确
3. **缓存键去重**：同一错误不重复调用 LLM
4. **课堂窗口**：聚合统计只关注最近课堂时段
5. **内存状态 + SQLite 持久化**：内存保证性能，持久化保证可恢复
