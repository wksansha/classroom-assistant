# L1 事件统一入库设计（trace_events 原始表 + 解释侧表）

- 日期：2026-10-16
- 状态：待评审
- 涉及仓库：classroom-assistant（服务端，主体）、vscode-pylearner（客户端）
- 前置设计：[2026-10-13-l1-trace-archive-design.md](../../../../vscode-pylearner/docs/superpowers/specs/2026-10-13-l1-trace-archive-design.md)（L1 文件归档，本设计取代其服务端存储部分）

## 1. 背景与目标

当前 L1 数据有两条通道：

1. **实时分析通道** `POST /api/events`：客户端 reporter 逐条上报，仅 diag/run 两类；服务端 LLM 解释后写入 `events` 表（结构化列），驱动内存 stateManager + SSE 看板。
2. **批量归档通道** `POST /api/trace/archive`：客户端激活时扫描本地 JSONL 批量补传，覆盖全部 6 个 surface；服务端只追加到文件系统 `L1-data/trace/...`，不入库、不分析。

问题：

- 全量原始事件（含 chat/edit/debug/behavior）只存在文件里，无法查询、无法作为第二阶段"服务端生成 L2/L3 画像"的数据源。
- diag/run 在两条通道各存一份（文件一份、events 表一份），口径不同、存储分裂。
- `events` 表无事件 id，实时上报失败重试会产生重复行，没有幂等能力。

目标：

1. 所有 L1 事件统一入 SQLite 一张**原始事实表** `trace_events`，事件 id 主键幂等，两条写入通道共用。
2. LLM 解释结果独立到**富化侧表** `event_explanations`，字段与原始表零重复，通过事件 id 主键关联。
3. 批量归档通道的落点从文件系统换成数据库；协议、客户端位点/断点续传机制不变。
4. 实时通道放开到全部 6 个 surface 并补传事件 id；看板逻辑（stateManager/aggregator/SSE）不变。
5. 旧 `events` 表退役。

### 分期边界

- **第一阶段（本设计）**：上述全部入库通道改造。画像生成仍在客户端读本地 JSONL，不变。
- **第二阶段（另行设计）**：服务端画像管线读 `trace_events` 生成 L2/L3；对"原始表有、解释表无"的历史 diag/run 补跑解释；聊天画像在代理层注入（见 §10）。本设计的表结构与索引按第二阶段的查询需求设计，避免二次返工。

明确不做：

- 不做课后定时脚本/计划任务（2026-10-16 决策）。实时上报保当天看板，激活补传保不丢，历史数据在学生首次打开 VS Code 时经位点机制（从 0 起）自然回填；"课前数据齐备"价值要到第二阶段定时预生成画像时才存在，届时再做 CLI，纯增量、不返工。
- 不做断网恢复后自动触发补传，也不做"立即同步归档"手动命令（2026-10-16 决策）。批量补传维持现状唯一触发点：扩展激活后自动跑一次。代价是 VS Code 长期不重启期间（含服务器宕机窗口）的积压要等下次重启/新开窗口才补齐，数据本身不丢；第二阶段若做定时画像再评估是否补触发手段。
- 不做数据保留期/自动清理（`date` 列已为学期清理预留，届时随学期重置功能一起做）。
- 不迁移 `events` 表历史数据（见 §5.4）。

## 2. 总体架构

```
                         全 6 surface 实时（主通道）POST /api/events
L1Writer.append ────────┤                     ├─ trace_events：INSERT OR IGNORE（按 event_id 幂等）
                         │                     └─ 仅 diag/run：LLM 解释 → event_explanations
                         │                                  → stateManager + SSE 看板（现状不动）
                         │
                         └─ 激活时批量补传（兜底通道）POST /api/trace/archive（协议不变）
                                               → 仅批量 INSERT OR IGNORE trace_events
                                                 不解释、不写侧表、不推 SSE
```

关键规则：

- **原始行必写，解释行按条件写**。任何通道写入都先落原始表；解释、看板推送只发生在实时通道的 diag/run 新事件上。
- **幂等命中即静默**：实时通道收到的 event_id 已存在（典型：归档补传先到），跳过解释/侧表/stateManager/SSE，返回 `{ ok: true, duplicated: true }`。历史补传事件因此不会污染当天实时看板。
- **兜底通道永远不解释**：归档批量入库即使包含 diag/run 也不调 LLM、不推看板。服务器宕机期间缺失的解释留待第二阶段按"原始表有、侧表无"差集补跑。

## 3. 数据模型

### 3.1 trace_events（原始事实表，只增不改）

```sql
CREATE TABLE trace_events (
  event_id     TEXT PRIMARY KEY,              -- 原样 '<surface>:<ulid>'，全局唯一、幂等依据
  student_id   TEXT NOT NULL,
  student_name TEXT NOT NULL,                 -- 上报时身份快照（名册可能尚未导入，不用 JOIN roster）
  class_id     TEXT NOT NULL DEFAULT 'default',
  surface      TEXT NOT NULL CHECK(surface IN ('edit','run','chat','debug','diag','behavior')),
  kind         TEXT NOT NULL,                 -- 如 code_change / execution_error / user_message
  ts           TEXT NOT NULL,                 -- 事件发生时间，ISO-8601 UTC（字典序即时间序）
  session_id   TEXT,                           -- debug/chat 等会话 id，可空
  payload      TEXT NOT NULL,                 -- 原样 payload JSON，画像管线输入
  date         TEXT NOT NULL,                 -- YYYY-MM-DD（UTC），学期清理/按日查询用
  ingested_at  TEXT NOT NULL DEFAULT (datetime('now'))  -- 入库水位，第二阶段画像增量游标
);
CREATE INDEX idx_trace_student_surface_ts ON trace_events(student_id, surface, ts);
CREATE INDEX idx_trace_class_ts           ON trace_events(class_id, ts);
CREATE INDEX idx_trace_date               ON trace_events(date);
```

设计说明：

- 不拆 payload 为列。看板需要的 raw_message/file_path/exit_code 等在解释链路中直接用内存对象，调试接口按需从 payload JSON 提取（`json_extract`）；避免 6 种 surface 的异构字段把表搞成稀疏大宽表。
- `student_name` 冗余存储为身份快照：归档/上报宽松不校验名册，事件发生时的姓名应随事件固化。
  - 2026-10-23 修订：归档接口 `/api/trace/archive` 增加花名册门禁——名册非空时学号不在名册 → 400 拒收（`student not in roster`），防止数据挂到无效/他人学号下（客户端对 400 不重试、位点跳尾，拒收安全）；名册为空仍放行（部署早期教师尚未导入名册，拒收会不可逆丢数据），实时通道 `/api/events` 不在本次范围。
- `ingested_at` 与 `ts` 分离：补传事件的 `ts` 是过去时间，`ingested_at` 是入库时间，第二阶段增量拉取互不干扰。

### 3.2 event_explanations（LLM 富化侧表）

```sql
CREATE TABLE event_explanations (
  event_id  TEXT PRIMARY KEY,                 -- = trace_events.event_id（一对一）
  category  TEXT NOT NULL,
  subtype   TEXT NOT NULL,
  knowledge TEXT NOT NULL,
  source    TEXT NOT NULL                     -- 'llm' / 'mock'
);
```

- run 成功事件不产生解释行（现状：成功只记活动信号）。
- 实时通道写原始行与解释行在**同一事务**内，保证"有解释必有原始行"。
- 不设显式 FOREIGN KEY（与现有建表风格一致，SQLite 默认不强制）；应用层保证先写原始行。

### 3.3 容量估算

40 学生课堂：edit（500ms 防抖聚合后的小事件）+ behavior（每次编辑会话 1 条，单条可能较大）为大头，粗估每人每天 2k~5k 条、原始体积 0.5~2MB，全班每天 20~80MB、一学期 2~8GB、行数百万至千万级。带索引的 `student_id + surface + ts` 查询仍为毫秒级；磁盘可承受。chat 全文与 behavior payload 是体积主体，超限风险见 §7。

## 4. 通信协议

### 4.1 POST /api/events（实时单条，格式变更）

请求体（在现有身份字段外，直接平铺 TraceEvent 原貌）：

```json
{
  "id": "diag:01J0ARZ9V8B...",
  "ts": "2026-10-16T06:31:14.754Z",
  "surface": "diag",
  "kind": "diagnostics_change",
  "payload": { "file": "a.py", "samples": ["..."], "errors": 1 },
  "session_id": "可选",
  "student_id": "2024001",
  "student_name": "张三",
  "class_id": "default"
}
```

- 全 6 个 surface 同一格式，服务端不再有 L1/flat 双格式分支。
- `id` 必填且形如 `<surface>:<ulid>`；缺失/非法返回 400。
- `surface` 必须在 6 值内；`student_id` 白名单 `[A-Za-z0-9_-]` 且不为 `unknown`；`class_id` 缺省 `default`。
- `date` 不需客户端传，服务端由 `ts` 派生（UTC 日期，与客户端 JSONL 文件命名规则一致）。

响应：

- 新事件：`200 { "ok": true, "duplicated": false }`
- event_id 已存在：`200 { "ok": true, "duplicated": true }`（不解释、不推看板）
- 校验失败：`400 { "error": "..." }`；服务端异常：`500`。

**旧 flat 格式不保留兼容**：内网私有系统、两端同批发布；唯一外部生产者是 tools/simulator.js 与 tools/demo-error-resolution.js，随本设计同步改为新格式。

### 4.2 POST /api/trace/archive（批量补传，协议不变）

请求/响应与现有完全一致（`{student_id, student_name, class_id, surface, date, events:[TraceEvent...]}`，响应 `{ok, accepted, duplicated}`），客户端 archiver/batcher/位点机制零改动。仅服务端语义变更：

- 落点：文件系统 → `trace_events` 表。
- 一个事务内逐条 `INSERT OR IGNORE`；`accepted = 事务变更行数`，`duplicated = 批次大小 - accepted`。
- 入库行的 `date` 取批次头 date（与客户端 JSONL 按天文件命名一致，批次内事件必属同一天）；实时路径则由服务端从事件 `ts` 派生。
- 现有 per-file 写锁、读全文件判重、目录创建逻辑全部删除（SQLite 写串行 + 主键幂等替代）。
- 校验规则（student_id/class_id 白名单、surface 枚举、date 格式、events 非空）保持不变。

## 5. 服务端改动（classroom-assistant）

### 5.1 persistence.ts

- 新增建表与索引（§3），加入启动迁移段。
- 新增接口：
  - `insertTraceEvent(row: TraceEventRow): boolean` —— INSERT OR IGNORE，返回是否新插入（`info.changes === 1`）。
  - `insertTraceEvents(rows: TraceEventRow[]): { accepted: number; duplicated: number }` —— 单事务批量。
  - `saveExplanation(eventId, {category, subtype, knowledge, source}): void` —— INSERT OR REPLACE。
  - `hasExplanation(eventId): boolean`（第二阶段补跑用，本阶段可一并提供）。
- 实时路径写库用 `db.transaction` 包住"原始行 + 解释行"。
- 删除 `insertEvent` / `EventRow`；`getRecentEvents`、`getEventStats` 改基于 `trace_events LEFT JOIN event_explanations`，返回字段保持调试接口既有形状（category/subtype/knowledge 来自侧表，成功事件为 null）。

### 5.2 eventIngress.ts

- 删除 L1/flat 双格式解析，改为解析 §4.1 单一格式，输出扩展后的 NormalizedEvent（新增 `id`、`surface` 放宽为 6 值、保留 `kind`/`payload`/`sessionId`）。
- diag/run 专有派生字段（success/errorType/cacheKey/samples/rawMessage 等）保留现有推导逻辑，仅对这两类计算；其他 surface 这些字段为 null。
- 保留现有 debug 日志（`event.normalized` 等），surface 维度放开。

### 5.3 index.ts（/api/events 路由）

```
normalize → 校验 student_id
persistence.insertTraceEvent(...)
  ├─ 返回 false（幂等命中）→ 直接 { ok:true, duplicated:true }
  └─ 返回 true（新事件）：
       diag/run：explainService.explain()（成功事件跳过 LLM，同现状）
                 同事务补写 event_explanations
                 stateManager.apply() + hub.publish(buildSnapshot())
       其他 surface：仅入库
       { ok:true, duplicated:false }
```

- stateManager 仅接收 diag/run（其类型现状即如此）；其他 surface 不进入内存聚合。
- 归档通道（traceArchive.ts）改为注入 `persistence`，不再注入 `traceDir`。

### 5.4 迁移与退役

- 启动迁移：`CREATE TABLE IF NOT EXISTS` 两表；`DROP TABLE events`（若存在）。
- **events 旧数据不迁移**：无 event_id 无法做幂等关联，且看板只看当天课堂窗口、调试数据无业务依赖；与此前作业域表退役（spec §0 不考虑迁移成本）同风格。
- `resolveTraceDir`、`AppDeps.traceDir`、TRACE_DIR 环境变量全部删除；服务器磁盘上已有的 L1-data 目录保留不动、不再写入（当前生产无数据）。
- `docs/database-schema.md`、`docs/architecture.md` 中事件表/通道描述同步更新。

## 6. 客户端改动（vscode-pylearner）

### 6.1 reporter.ts（重写上报内容）

- 删除 flat 格式 `buildPayload` 及业务过滤（diag 无 samples 不报、run 缺字段不报等）；是否解释由服务端按 surface/内容决定，客户端只负责把 TraceEvent 原貌送达。
- 请求体改为 §4.1 格式：平铺事件 `id/ts/surface/kind/payload/session_id` + 当前身份三字段。
- 身份门控保留：未设学号/姓名不上报，本地 L1 照记。
- 新增 **fetch 超时**：`AbortController` 单次 10s（现状无超时，断网时请求可长期挂起堆积）；超时/非 2xx 只打日志，不重试（幂等与补传由归档通道承担）。

### 6.2 l1Writer.ts

- `shouldReportToTeacher` 门控放开为全 surface（全部 append 点均触发实时上报）；上报点清单：
  - edit：code_change、file_save
  - run：execution_success、execution_error（task 与 terminal 两来源）
  - diag：diagnostics_change
  - chat：user_message、assistant_response
  - debug：breakpoint_change、debug_session_start、debug_session_end
  - behavior：typing_session
- L1Writer 不变的部分：本地按学号分目录 JSONL 落盘、per-surface 写锁、identity 快照、提交通道分发。

### 6.3 archiver / extension.ts

- **无改动**：批量补传维持现状——扩展激活后延迟自动执行一次 `runOnce()`，位点、断点续传、unknown 跳过等全部沿用。不新增恢复触发、不新增手动命令。

### 6.4 补传水位：维持现有位点机制（决策）

第一阶段**不做**"实时上报成功即推进归档字节位点"的水线联动，维持现状：

- 归档仍按 `archive-state.json` 字节位点，在每次扩展激活时扫描新增段、整段批量上传，服务端按 id 去重。
- 代价：同一条事件平均多走一次内网传输（激活以来的新增段会重传，全部计 duplicated）。量级为每生每天一次当天增量，估算每天 20~80MB 全校总量，内网可忽略。
- 不做的原因：水线联动需要把"事件在文件中的字节区间"从写盘路径暴露出来，并将目前 fire-and-forget 的并发上报改为 per-surface 串行队列以保证水位连续正确性，客户端复杂度显著增加；收益仅为省一倍可忽略的内网流量。列为未来可选优化，接口与位点协议届时不变。

## 7. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 服务端宕机/断网 | 实时上报失败只打日志（10s 超时）；本地 JSONL 持续写；下次扩展激活时位点从断点自动补传（VS Code 长期不重启则顺延至重启后） |
| 事件重复（任意通道、乱序、重传） | event_id 主键 + INSERT OR IGNORE，零重复 |
| 归档补传的 diag/run 先于实时到达 | 实时请求幂等命中，不推看板；该事件无解释行，第二阶段补跑 |
| 单事件超大（behavior 上限 5000 变更记录） | 实时请求受 express 2mb 限制；现有批次自限 512KB。正常 payload 远低于此；超限返回 413 并记日志，本地事件保留，不阻塞后续事件 |
| 未设身份 | 事件落本地 unknown/；实时不上报、归档不扫描（同现状） |
| 服务端收到旧 flat 格式 | 400（两端同批发布，不做兼容） |
| 客户端 400（数据非法） | 位点跳文件尾（现有逻辑，不重试无意义数据） |

## 8. 测试计划

服务端（vitest，沿用 __tests__ 风格）：

- traceArchive 重写：批量入库 accepted/duplicated 计数；同 id 跨批次/乱序重传零重复；含 diag/run 的批次不产生解释行、不触发 SSE；校验失败 400 用例保持。
- /api/events：6 surface 新格式各一条入库成功；diag/run 新事件写两表、推 SSE；非 diag/run 只写原始表、不进 stateManager；重复 id 返回 duplicated 且不重复解释/推送；缺 id/非法 surface/缺 student_id → 400。
- persistence：两表 DDL/索引；事务回滚一致性；getRecentEvents/getEventStats 的 JOIN 结果与字段形状；旧 events 表存在时启动后被 DROP、其他表（roster/review_cache/student_tokens/error_cache）无损。
- 回归：stateManager/aggregator/teacherHub、reviews、roster、llmProxy 相关测试全绿。

客户端（vitest + vscode-mock）：

- reporter：全 surface 均产生请求；请求体含 id 与原始 payload；身份门控；10s 超时路径（超时只记录不抛错、不重试）。
- l1Writer：全 surface 均调用 reporter；本地落盘/身份目录行为不变。
- archiver/batcher/archiveState/extension.ts 接线：现有测试保持，代码无改动（协议与位点未改、不新增触发点）。
- tools/simulator.js 升级后可对新格式打出端到端流量（手工验证）。

## 9. 部署与回滚

- 部署顺序：先服务端后客户端。新服务端不接受旧 flat 格式，因此两者应同批发布；发布窗口内旧客户端的实时上报会 400（本地数据不丢，激活补传在新客户端生效后自动补齐）。
- 服务端启动自动完成建表与 events 表 DROP，无需手工迁移；遵守"服务端运行中禁止外部直接改 SQLite"约束，迁移只在启动时由进程自身执行。
- 回滚：代码回退后旧服务端只认 events/flat，新写入的 trace_events 数据保留在库中不影响旧服务端运行；回滚窗口内学生数据仍在本地 JSONL，不丢失。

## 10. 第二阶段接口预留（已定方向，本期不实现）

以下决策在第一阶段只冻结方向、不写实现代码；列出是为了避免两阶段之间协议改两次。

### 10.1 聊天通道维持服务器代理（teacher provider）

生产部署形态为**内网自建 LLM**（学生机、课堂服务器、LLM 三者同内网；服务端 `.env` 配置 LLM_BASE_URL）。对比"学生机直连内网 LLM"后，维持现状代理方案：

- 上下文隔离与两种方案无关：对话上下文完全由客户端按 sessionId 持有（`globalStorage/chats/` 会话 JSON，每次请求全量重放），代理与 LLM 均无会话状态，40 路并发不可能串话；直连在隔离性上无优势。
- 代理占优的三条：**画像注入点**（见 10.2）、**配置单点**（模型地址/型号变更只改服务器一处，不下发 40 台机器）、**容量闸口**（自建 GPU 在全员并发时可能过载，代理层可一处加全局排队/限流）。
- router 的 openai/ollama/vscode-lm 直连 provider 保留，供教师机、开发调试、离线演示使用。

### 10.2 画像在代理层注入 system prompt

第二阶段聊天链路：

```
扩展                          课堂服务器                        内网 LLM
 │  POST /api/llm/chat        │                                 │
 │  X-Student-Id: <学号>       │  ① 按学号取 L2/L3（进程内缓存）  │
 │  messages: [对话历史]       │  ② 拼教学 system prompt         │
 │  （不再自带画像/system）     │  ③ unshift system 消息          │
 │ ──────────────────────────>│  ④ 改写 model 后转发 ──────────>│
 │                            │<──── SSE 原样泵回 ──────────────│
```

- 画像、画像生成器、prompt 模板三者留在服务器同一信任边界；调整 prompt 只需重启服务，不发版扩展。
- 客户端第二阶段**删除**现有本地注入（messageHandler 中的 `loadProfileMd` + `injectProfile`），请求只带对话历史。
- 否决"客户端先 GET 拉画像再直连 LLM"方案：画像全文（含评价性内容）下发到 40 台机器、prompt 模板绑死扩展发版、生成器与注入器版本耦合、与服务端评审/解释的画像口径分裂。

### 10.3 X-Student-Id 升级为带签名凭证

现 `X-Student-Id` 头仅用于日志、客户端自报。画像注入后该头决定"取谁的画像"，伪造即可读到他人画像。第二阶段将其升级为身份校验接口下发的**短期 HMAC 凭证**（花名册已验过学号+姓名），代理验签；chat 事件身份同时受益。第一阶段不改此头，但新事件协议的身份字段按可携带凭证预留演进空间，不做与之冲突的设计。

### 10.4 chat 不在 LLM 代理侧采集

尽管代理能看到聊天全文，chat 事件仍只经统一的实时上报 + 批量归档通道入库，代理不做顺手记录：

1. 代理自造的事件 id 与客户端 `chat:<ulid>` 无共同主键，与归档数据无法去重，同一次提问必然双份；
2. LLM 协议无状态，每轮请求带全量对话历史，代理侧无状态可做差集，无法识别"本轮新提问"；
3. 记录 assistant 回答需缓冲整条 SSE 流，破坏纯透传；
4. openai/ollama/vscode-lm provider 的对话不经过代理，采集挂在代理则覆盖面残缺。

### 10.5 本地遗留问题（与本期无关，记录备查）

聊天会话文件存机器级 globalStorage、不按学号分目录；共用电脑换人后，后一学生可在历史会话列表看到前一学生的聊天。后续在身份切换流程中评估清理 `chats/` 目录（与既有 `git clean -fdX` 同类）。

## 11. 决策记录

1. **原始表 + 解释侧表两张表**，而非统一大宽表：6 surface 异构 payload 不拆列，LLM 字段零重复，按 id 关联（用户提出并确认）。
2. **两阶段实施**：第一阶段只换数据通道，服务端画像管线第二阶段另立设计。
3. **不做课后定时脚本/CLI**：实时上报 + 激活补传已保证数据不丢不重；CLI 推迟到第二阶段有定时预生成画像需求时。
4. **events 表直接退役不迁移历史**。
5. **归档通道协议与客户端位点机制零改动**，仅换服务端落点。
6. **不做实时成功推进字节水线**，接受一倍可忽略的内网冗余流量换取客户端简单。
7. **旧 flat 协议不保留兼容**，simulator 等工具同步升级。
8. **不新增补传触发点**：不做断网恢复自动触发、不做手动归档命令，批量补传仅维持扩展激活时执行（数据不丢，只是长期不重启时补传顺延）。
9. **聊天维持服务器代理（内网自建 LLM 形态）**，第二阶段画像在代理层注入 system prompt，客户端删除本地画像注入；直连方案否决（详见 §10.1–10.2）。
10. **X-Student-Id 第二阶段升级为 HMAC 短期凭证**，第一阶段协议预留演进空间（§10.3）。
11. **chat 不在代理侧采集**，统一走上报/归档通道（§10.4）。
