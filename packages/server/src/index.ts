import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import type { TeacherSnapshot, IngressEvent } from "@classroom/shared";
import { createPersistence, type TraceEventRow } from "./persistence";
import { normalize, isDiagRunEvent } from "./eventIngress";
import { createCache } from "./explainService/cache";
import { createExplainService } from "./explainService";
import { createStateManager } from "./stateManager";
import { createAggregator } from "./aggregator";
import { createTeacherHub, type TeacherHub } from "./teacherHub";
import { logEvent } from "./logger";
import { registerLlmProxy, readLlmConfigFromEnv, type LlmProxyConfig } from "./llmProxy";
import type { ReviewLlmOptions } from "./reviewService";
import { createReviewService } from "./reviewService";
import { registerRosterRoutes } from "./routes/roster";
import { createGiteaAdmin } from "./gitea/adminApi";
import { registerReviewRoutes } from "./routes/reviews";
import { type ReviewRequestDeps } from "./controllers/reviewController";
import { registerTraceArchiveRoutes } from "./routes/traceArchive";

export interface AppDeps {
  /** 测试传 ":memory:"；缺省 data/assistant.db（相对 server 包） */
  dbPath?: string;
  /** 生产传 dashboard/dist 目录；缺省/不存在则不托管静态文件 */
  staticDir?: string | null;
  /** LLM 聊天代理配置；缺省读环境变量（LLM_API_KEY 等为空则不启用代理），测试可注入假上游 */
  llmConfig?: LlmProxyConfig | null;
  /** 评审 LLM 注入（测试传 fetchImpl）；缺省读环境变量，无 key 时 mock 兜底 */
  reviewConfig?: ReviewLlmOptions | null;
}

export function createApp(deps: AppDeps = {}): { app: Express; hub: TeacherHub } {
  const persistence = createPersistence(deps.dbPath);
  const stateManager = createStateManager();
  const cache = createCache(persistence);
  const explainService = createExplainService(cache);
  const aggregator = createAggregator();

  const buildSnapshot = (): TeacherSnapshot => {
    const now = Date.now();
    const records = stateManager.listRecords();
    // V1 单班级：records[0]?.classId 作为 classId 来源（未来多班级需改为聚合所有班级）
    return { ts: now, classId: records[0]?.classId ?? "default", ...aggregator.recompute(records, now) };
  };

  const hub = createTeacherHub(buildSnapshot);

  const toRow = (ev: IngressEvent): TraceEventRow => {
    const tsIso = new Date(ev.ts).toISOString();
    return {
      eventId: ev.id, studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
      surface: ev.surface, kind: ev.kind, ts: tsIso,
      sessionId: ev.sessionId ?? null,
      payload: JSON.stringify(ev.payload ?? {}),
      date: tsIso.slice(0, 10),
    };
  };

  // —— 作业评审模块装配（T8）——
  const reviewService = createReviewService(persistence, deps.reviewConfig ?? undefined);

  const app = express();
  app.use(cors());
  // 2mb：学生端聊天会把学习画像上下文塞进 messages，默认 100kb 不够
  app.use(express.json({ limit: "2mb" }));

  // SSE（spec §6）
  app.get("/api/stream/teacher", (req, res) => hub.handleStream(req, res));

  // 学生上报（TraceEvent 原样平铺，全 surface；spec §4.1）
  app.post("/api/events", async (req, res) => {
    const startTime = Date.now();
    try {
      const ev = normalize(req.body);
      if (!ev) {
        logEvent({ event: "route.invalid_body", level: "warn", data: { path: req.path, bodyKeys: Object.keys(req.body ?? {}) } });
        return res.status(400).json({ error: "缺少必要字段" });
      }
      if (!ev.studentId || !/^[A-Za-z0-9_-]+$/.test(ev.studentId) || ev.studentId === "unknown") {
        logEvent({ event: "route.missing_student_id", level: "warn", data: { path: req.path, studentId: ev.studentId } });
        return res.status(400).json({ error: "student_id 非法" });
      }

      logEvent({ event: "route.event_received", data: {
        eventId: ev.id, studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
        surface: ev.surface, kind: ev.kind, success: ev.success, ts: ev.ts,
      } });

      // 非 diag/run：仅入库（spec §2：原始行必写，不解释、不进内存看板）
      if (!isDiagRunEvent(ev)) {
        persistence.insertTraceEvent(toRow(ev));
        logEvent({ event: "route.event_stored", data: { eventId: ev.id, surface: ev.surface, kind: ev.kind }, durationMs: Date.now() - startTime });
        return res.json({ ok: true, duplicated: false });
      }

      // diag/run：成功事件只记活动信号不解释（现状语义保持）
      const explanation = ev.success ? null : await explainService.explain(ev);
      const inserted = persistence.insertTraceEvent(toRow(ev), explanation ? {
        category: explanation.category, subtype: explanation.subtype,
        knowledge: explanation.knowledge, source: explanation.source,
      } : undefined);

      if (!inserted) {
        // 幂等命中（典型：归档补传先到）：不解释、不推看板
        logEvent({ event: "route.event_duplicated", data: { eventId: ev.id, studentId: ev.studentId } });
        return res.json({ ok: true, duplicated: true });
      }

      stateManager.apply(ev, explanation);
      hub.publish(buildSnapshot());
      logEvent({ event: "route.event_processed", data: {
        eventId: ev.id, studentId: ev.studentId, surface: ev.surface, success: ev.success,
        explanationCategory: explanation?.category,
      }, durationMs: Date.now() - startTime });
      return res.json({ ok: true, duplicated: false });
    } catch (err) {
      // 兜底：未捕获异常返回 JSON（避免 Express 5 默认 HTML 500 + 堆栈泄漏）
      logEvent({ event: "route.event_error", level: "error", data: {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }, durationMs: Date.now() - startTime });
      return res.status(500).json({ error: "服务器内部错误" });
    }
  });

  // 全量快照（首载/断线重连补齐）
  app.get("/api/summary", (_req, res) => {
    const snapshot = buildSnapshot();
    logEvent({ event: "api.summary", level: "debug", data: { classId: snapshot.classId, studentCount: snapshot.students.length } });
    res.json(snapshot);
  });

  // 单生错误历史（抽屉）
  app.get("/api/student/:id", (req, res) => {
    const detail = stateManager.getStudentDetail(req.params.id);
    if (!detail) {
      logEvent({ event: "api.student_not_found", level: "warn", data: { studentId: req.params.id } });
      return res.status(404).json({ error: "未找到该学生" });
    }
    logEvent({ event: "api.student_detail", level: "debug", data: { studentId: req.params.id, eventCount: detail.events.length } });
    res.json(detail);
  });

  // 标记建议已处理（V1 仅内存）
  app.post("/api/suggestions/ack", (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : null;
    if (!id) {
      logEvent({ event: "api.ack_invalid", level: "warn", data: { body: req.body } });
      return res.status(400).json({ error: "缺少 id" });
    }
    aggregator.ack(id);
    logEvent({ event: "api.ack_success", level: "debug", data: { id } });
    res.json({ ok: true });
  });

  // 调试接口（沿用 demo）
  app.get("/api/events", (req, res) => {
    const limit = parseInt(String(req.query.limit ?? "50"), 10);
    logEvent({ event: "api.events_list", level: "debug", data: { limit } });
    res.json(persistence.getRecentEvents(limit));
  });
  app.get("/api/stats", (_req, res) => {
    const stats = {
      events: persistence.getEventStats(),
      cache: persistence.getCacheStats(),
      runtime: cache.getStats(),
      onlineClients: hub.clientCount(),
    };
    logEvent({ event: "api.stats", level: "debug", data: stats });
    res.json(stats);
  });

  // 作业评审路由（roster，T7）；作业域退役 + notify 退役（spec §0）：服务端无提交通道，
  // 学生提交事实以学生分支 git 历史为准，评审结果经 HTTP 响应回执 + 注入监控
  // Gitea 管理联动（学生分支直连模型）：GITEA_URL/GITEA_ADMIN_TOKEN/GITEA_REPO 三环境变量齐备才启用；缺任一则跳过（info 一条）
  const gitea = process.env.GITEA_URL && process.env.GITEA_ADMIN_TOKEN && process.env.GITEA_REPO
    ? createGiteaAdmin({ baseUrl: process.env.GITEA_URL, adminToken: process.env.GITEA_ADMIN_TOKEN, repo: process.env.GITEA_REPO })
    : null;
  if (!gitea) {
    logEvent({ event: "gitea.provision_skipped", level: "info", data: { reason: "GITEA_URL/GITEA_ADMIN_TOKEN/GITEA_REPO 未全部配置" } });
  }
  registerRosterRoutes(app, { persistence, gitea });

  // 运行触发评审路由（V2.0 F5：写回最新提交 + fail 注入实时聚合，Task 6）
  const reviewRequestDeps: ReviewRequestDeps = {
    persistence, reviewService, stateManager,
    publishSnapshot: () => hub.publish(buildSnapshot()),
  };
  registerReviewRoutes(app, reviewRequestDeps);

  // L1 全量归档（独立于分析链路，只写 trace_events 原始表；按 event_id 幂等）
  registerTraceArchiveRoutes(app, { persistence });

  // LLM 聊天代理（学生端 teacher provider → 服务器 .env 配置的大模型）
  registerLlmProxy(app, deps.llmConfig !== undefined ? deps.llmConfig : readLlmConfigFromEnv());

  // 生产：托管 dashboard 构建产物
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get("/", (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  return { app, hub };
}
