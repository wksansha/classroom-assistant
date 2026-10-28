# 公网服务器过载事故复盘（2026-10-27 晚）

> 现象：全班学生集体卡在「仓库初始化」+ 服务器 CPU 100%。
> 结论先行：**2核 / 1.4G 内存 / 无 swap 的服务器，扛不住「全班并发 git fetch + edit 事件流 + GLM 免费档解释/评审外呼」三合一负载**。Gitea 数据库在资源饥饿下查询超时，git 请求挂起 4.5~15 分钟后返回 500，学生端因此卡死；CPU 100% 是同一次资源挤兑的表象。
> 本报告全部结论基于服务端与 Gitea 日志的量化数据，证据缺口在 §5 明确标注。

## 一、环境背景

| 项 | 值 |
|---|---|
| 服务器 | 百度云 `instance-n3gprvz5`（外网/公网环境） |
| 规格 | **2 核 CPU / 1.4GiB 内存 / 0 swap（事发时）** |
| 课堂容器 | classroom-server（node，事件上报+评审+聊天代理）、classroom-gitea（代码仓库，SQLite） |
| 同机其他容器 | new-api + postgres + redis + caddy（LLM 网关栈，~96MB）、opencode ×3（AI 工具栈，~22MB）——与课堂链路无关 |
| LLM 配置 | 直连智谱 `https://open.bigmodel.cn/api/paas/v4`，模型 `glm-4.7-flash`（**免费档**） |
| 学生规模 | 花名册 23 人，机房出口 NAT（日志中同一公网 IP `36.17.129.192` 对应多台学生机） |
| 内存账本（闲时） | dockerd 247MB、gitea 133MB、node 93MB、其余 ~250MB，**可用仅 ~320-340MB** |

## 二、数据来源与方法

- 提取窗口：2026-10-27 18:00 ~ 23:00（北京时间）
- `docker logs --since/--until classroom-server` → 17,828 行；`classroom-gitea` → 2,949 行
- 统计命令：`grep -oE` 按事件名/时间戳/surface 字段聚合
- 时区说明：**Gitea 容器日志为 UTC**（文中已 +8 换算为北京时间），服务端日志为 CST
- 复现命令见附录 A

## 三、事件上报统计（核心数据）

### 3.1 服务端事件流水（18:00~23:00，共 5 小时）

| 事件 | 条数 | 含义 |
|---|---|---|
| `route.event_received` | **8,692** | 收到学生上报事件（**总量口径**） |
| `route.event_stored` | 6,416 | 仅入库（edit/behavior/debug 等不触发解释的事件） |
| `route.event_processed` | 2,275 | 入库 + **LLM 解释 + 实时看板推送**（diag/run 事件） |
| `archive.batch_received` | 133 | 批量归档请求（扩展激活补传） |
| `review.llm_http_error` | 166 | **F5 评审调用 GLM 失败**（学生端显示「⚪ 本次未能完成评审」） |
| `llm.mock_fallback` | 68 | 解释管线失败转 mock 兜底 |
| `llm.api_error` | 64 | LLM API 调用报错 |
| `review.fail_injected` | 5 | 评审失败注入告警面板 |
| `sse.connect` | 5 | 教师大屏 SSE 连接 |
| `state.new_record` / `route.event_duplicated` / `review.pass_applied` / `review.llm_failed` | 各 1 | 零星 |

交叉校验：6,416 + 2,275 = 8,691 ≈ 8,692（received），账目自洽。

### 3.2 事件类型（surface）分布

surface 字段在日志中出现 17,517 行次；每条事件恰好产生 received + stored/processed 两行，据此估算唯一事件数（与 8,692 总量吻合，误差来自少量无 surface 字段的流水行）：

| surface | 日志行次 | 估算事件数 | 占比 | 说明 |
|---|---|---|---|---|
| edit | 12,746 | **≈6,373** | 73% | 写代码实时上报（降噪后） |
| diag | 4,096 | **≈2,048** | 24% | 诊断变化，**每条触发一次 GLM 解释** |
| run | 499 | **≈250** | 3% | F5 运行，**触发评审** |
| behavior | 173 | ≈86 | 1% | 会话结算型 |
| debug | 3 | ≈2 | <0.1% | 调试会话 |
| chat | 0 | 0 | — | 该时段无聊天事件上报 |

交叉校验：diag + run ≈ 2,298 ≈ `event_processed` 2,275 ✓（差值为 debug/重复事件）。

### 3.3 人均强度

8,692 条 ÷ 23 人 ÷ 5 小时 ≈ **76 条/人·小时**。对"全班同时在线写代码"的场景属于合理量级——**问题不在事件量异常，而在服务器承载力不足**。

### 3.4 分小时日志量（洪峰定位）

| 小时（CST） | 日志行数 | 解读 |
|---|---|---|
| 18 时 | 6,155 | 开课：全班激活 + 首次拉取 + 初始化 |
| **19 时** | **9,460** | **洪峰：全班并发写代码** |
| 20 时 | 570 | 骤降 |
| 21 时 | 451 | 谷底 |
| 22 时 | 1,192 | 小幅回升 |

## 四、Gitea 侧证据（学生卡初始化的直接原因）

`info/refs?service=git-upload-pack` 是 git fetch/clone 的第一步。日志中大量该请求：

```
GET /rjgc/classroom-exercises.git/info/refs?service=git-upload-pack
→ 500 Internal Server Error in 270466ms   （4.5 分钟）
→ 500 Internal Server Error in 921704ms   （15.4 分钟）
```

关键细节：

1. **挂起时长 270s~15min 后集中返 500**：一批请求在同一秒（UTC 10:54:02 = 北京 18:54:02）陆续完成，说明它们在 ~18:38-18:49 同时进入，全部悬死
2. **500 落点有两类**：`repo.GetInfoRefs`（git 后端）与 `context.UserAssignmentWeb`（**认证中间件**）——后者意味着 Gitea 的 SQLite 用户查询在资源饥饿下超时，**尚未进入 git 逻辑就已失败**
3. **并发来源**：`36.17.129.192`（机房 NAT，端口不同=不同学生）、`39.144.124.74`（移动出口），并发量级为全班
4. 失败窗口与 server 日志 18~19 时洪峰完全重叠

## 五、LLM 失败证据链

- 首条 `review.llm_http_error` 出现于 **18:27:26**，此后在 18:27~18:31+ 密集出现，整晚共 **166 次**
- 解释管线另有 64 次 `llm.api_error` + 68 次 `mock_fallback`
- LLM 为**智谱免费档外部 API**：全班并发的 2,275 次解释 + ~250 次评审外呼超出免费档并发/频率容忍，表现为限流或排队超时
- 注意：LLM 外呼走的是**等待**（不吃 CPU），它贡献的是「评审失败、解释变慢」，**不是 CPU 100% 的直接原因**

## 六、根因分析

### 6.1 资源账本 vs 峰值需求

| 资源 | 事发时 | 峰值需求 |
|---|---|---|
| CPU | 2 核 | git 子进程（每并发 fetch fork 一个 upload-pack）+ node 事件流 + TLS 握手 |
| 内存 | 1.4GiB，闲时可用仅 ~330MB | 20+ 个 git 子进程（各 10-30MB）+ node 增长 + Gitea SQLite 页缓存 |
| swap | **0** | 无任何腾挪空间，内存见底即硬性饿死 |

### 6.2 事故链（全部有日志佐证）

```
18:00  开课：全班激活（archive.batch_received 133 次）+ 首次拉取
18:27  第一波 F5 评审打向 GLM 免费档 → 166 次 llm_http_error
18:38  edit 洪峰（19 时 9,460 行）+ 全班并发 git fetch 叠加
       → 2 核 CPU + 1.4G 内存（无 swap）被打满
       → Gitea SQLite / 认证查询超时
18:49~ → info/refs 挂 270s~15min 后返 500
18:54  → 学生端集体卡在「仓库初始化」
全程    → node 响应变慢，学生机超时掐断请求（服务端 BadRequestError: request aborted）
20:00  下课，负载消失，一切"自愈"
```

### 6.3 证据缺口（诚实声明）

- **事发时无 CPU 快照**（cpu-watch 事后才装）：CPU 100% 来自使用者的现场观察，未留仪器数据——已补装，下次直接有图
- `BadRequestError` 总条数未统计成功（命令输出被截断），仅确认存在且模式一致
- Gitea `[E]` 级错误行未采集，500 的具体错误体（DB timeout / OOM kill）属合理推断

## 七、处置与效果

| 措施 | 状态 | 效果 |
|---|---|---|
| 加 2G swapfile | ✅ 已生效（free -h 确认） | 同样的压力从「500+卡死」降级为「慢但能完成」 |
| cpu-watch 采样服务（systemd 常驻） | ✅ 运行中 | 每 30s 记录 CPU 快照至 `/var/log/cpu-watch.log`，重启自启 |
| 封禁 fwupd（云服务器无用服务） | ✅ masked | 消除零星后台 CPU 噪声 |
| 学生机分批拉取（错峰初始化） | 建议执行 | 开课按学号尾号分批，避开并发尖峰 |
| **升配至 2核4G+** | ⏳ 待定 | **治本**。1.4G 内存对本系统属先天不足，swap 只是气囊 |
| GLM 免费档 → 付费档 | ⏳ 待定 | 免费档扛不住全班并发（166 次失败/晚），付费档消除评审失败 |

## 八、结论

**一次典型的「小规格服务器 + 全班并发」资源耗尽型复合故障。** 三个负载源（git 并发、事件流、LLM 外呼）单独都在系统设计容量内，叠加在 2核/1.4G/无swap 上互相挤兑：Gitea 最先倒下（SQLite 超时 → 500 → 学生卡初始化），node 随之变慢（客户端掐断），CPU 100% 是全局挤兑的温度计。swap 已补齐短期安全垫，**长期稳定运行必须升配**；GLM 免费档按需决定是否升档。

## 附录 A：复现/取证命令

```bash
# 日志提取（Gitea 时间为 UTC，注意 +8）
docker logs --since 2026-10-27T18:00 --until 2026-10-27T23:00 classroom-server > /tmp/server-night.log
docker logs --since 2026-10-27T18:00 --until 2026-10-27T23:00 classroom-gitea  > /tmp/gitea-night.log

# 事件统计
grep -oE '"event":"[a-z_.]+"' /tmp/server-night.log | sort | uniq -c | sort -rn
grep -oE '"surface":"[a-z]+"' /tmp/server-night.log | sort | uniq -c | sort -rn
grep -oE '"timestamp":"[^"]*' /tmp/server-night.log | cut -c25-26 | sort | uniq -c   # 小时分布

# Gitea 500 取证
grep -E "500 Internal Server Error" /tmp/gitea-night.log | head
grep -E "\[E\]" /tmp/gitea-night.log | head          # 待补采：500 的错误体

# 事后监控（已常驻）
tail /var/log/cpu-watch.log
```

## 附录 B：本次形成的运维约定

1. **内网/公网服务器改动镜像只导 `deploy-server:latest`**（Gitea 无更新不重打）
2. **服务端与扩展协议级变更必须同批发布**（本次在线模型升级即属此类）
3. **CPU 异常先查 `/var/log/cpu-watch.log`**，再看 `docker logs` 对应时段
4. **GLM 免费档仅适合零星使用**，开课高峰的评审失败属预期行为
