# 测试学生标记（花名册 is_test）设计

日期：2026-10-26
状态：已评审待实施

## 背景与目标

教师需要一个「测试学生」来演练全流程（拉取/运行/评审/聊天），但这类学号不应：

1. 出现在实时助教大屏（矩阵/顶栏统计/急需帮助告警/题目进度/建议）——尤其不应稀释每题通过率的分母
2. 在服务端留下数据痕迹（trace_events 原始事实表、归档落库）

测试学号本身仍是花名册内的真实学生：身份校验照常通过、Git 账户照常开通、评审照常执行（测全流程正是其用途），**唯一的差别是服务端不收集其数据、大屏不展示**。

## 语义总纲

| 维度 | 行为 |
|---|---|
| 标记入口 | 花名册面板行操作「设为测试 / 取消测试」（导入语法不扩展，2026-10-26 用户拍板） |
| 实时上报 `/api/events` | 200 + 静默丢弃：不入 trace_events、不进内存看板（stateManager），仅 debug 日志。不用 400——测试学生会持续产生 edit 事件，400 会刷爆 warn 日志 |
| 归档 `/api/trace/archive` | 400 `"student is test"`：复用既有花名册门禁语义，客户端收到 400 = 不重试、位点跳到文件尾，测试期间本地 L1 数据不上云；取消标记后新数据正常续传 |
| 心跳 `/api/heartbeat` | 200 但不调 stateManager（不建机器会话） |
| 大屏 `buildSnapshot` | 三处排除：内存记录、花名册补空记录（rosterGhosts）、**通过率分母 rosterTotal** |
| 评审链路 | 不拦：review_results 照常落行（已知例外，属教师测试用途） |
| 身份校验 / Gitea 账户 | 照常（学号在名册内即合法） |

## 数据层

- `roster` 表加列 `is_test INTEGER NOT NULL DEFAULT 0`
- 迁移：启动时 `PRAGMA table_info(roster)` 检查，缺列则 `ALTER TABLE roster ADD COLUMN ...`（复用 persistence.ts 的 colsOf 基建）；新建库的 CREATE TABLE 直接带列。老库无损升级
- `RosterEntry`（shared/assignment.ts）加 `isTest: boolean`，SELECT 处映射

## API 变更

- `PATCH /api/roster/entry/:studentId`：body 扩展可选 `isTest?: boolean`（与既有 studentName 改名并存）；persistence 新增 `setRosterTest(studentId, isTest): boolean`
- `/api/events`、`/api/trace/archive`、`/api/heartbeat`：在各自主流程入口处查 `getRosterEntry(studentId)?.isTest` 命中即按上表处理（每事件一次主键索引 SELECT，开销可忽略）

## 大屏排除（buildSnapshot）

- 组装 `allRecords` 前，先取 `testIds = new Set(roster.filter(e => e.isTest).map(...))`
- `records` 过滤（防御：服务端长运行期间标记翻转后，内存中可能残留该学号此前的记录）
- `rosterGhosts` 过滤（isTest 学生不补空记录，矩阵完全不出现）
- `rosterTotal` 剔除测试学生（每题通过率 = 通过人数 / 非测试花名册人数）

## 管理界面（RosterPanel）

- 测试学生的行显示「测试」徽章
- 行操作新增「设为测试 / 取消测试」（沿用现有 toast 反馈模式；软移出/彻底清除等既有操作不变）

## 边界与既有语义

1. **批量导入重置标记**：`POST /api/roster` 是全量替换（学期更替换血语义），导入后所有 is_test 归零；教师中途重导名册修名需重新标记（测试学生通常 1-2 人，可接受）
2. **软移出再添加 = 全新行**：is_test 归零（软删已从 roster 表移除该行、仅保留 Git 凭证）
3. **历史数据不清洗**：标记只管未来；标记前已入库的数据保留
4. **取消标记即时恢复**：收集/展示立即恢复正常；测试期间本地未上云的归档数据因位点已跳尾不会补传（符合「不收集」意图）
5. 二期 HMAC 短期凭证上线后，本门禁与其共存：isTest 判断在凭证校验之后追加

## 测试面

- 服务端：roster 迁移（老库加列）；PATCH isTest；events 对 isTest 学号 drop（不落库、不推看板）、对普通学号行为不变；archive 400；heartbeat 不记账；buildSnapshot 三处排除（records/ghosts/rosterTotal）
- dashboard：RosterPanel 徽章渲染、开关调用与刷新
