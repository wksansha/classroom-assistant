import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import type { TeacherSnapshot } from "@classroom/shared";
import { createPersistence } from "./persistence";
import { normalize } from "./eventIngress";
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
  /** 归档根目录；缺省 classroom-assistant 同级 L1-data（resolveTraceDir 解析） */
  traceDir?: string;
  /** 评审 LLM 注入（测试传 fetchImpl）；缺省读环境变量，无 key 时 mock 兜底 */
  reviewConfig?: ReviewLlmOptions | null;
}

/**
 * 归档根目录解析：显式传入 > TRACE_DIR 环境变量 > 缺省 classroom-assistant 同级 L1-data。
 * 缺省锚定 __dirname（packages/server/src）向上四级到仓库同级，不随启动 cwd 漂移，
 * 本机与部署机同一套相对约定（spec：docs/superpowers/specs/2026-10-13-l1-trace-archive-design.md §5）。
 */
export function resolveTraceDir(explicit?: string): string {
  return explicit ?? process.env.TRACE_DIR ?? path.resolve(__dirname, "..", "..", "..", "..", "L1-data");
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

  // —— 作业评审模块装配（T8）——
  const reviewService = createReviewService(persistence, deps.reviewConfig ?? undefined);

  const app = express();
  app.use(cors());
  // 2mb：学生端聊天会把学习画像上下文塞进 messages，默认 100kb 不够
  app.use(express.json({ limit: "2mb" }));

  // SSE（spec §6）
  app.get("/api/stream/teacher", (req, res) => hub.handleStream(req, res));

  // 学生上报（learner 零改造：flat 格式不变）
  app.post("/api/events", async (req, res) => {
    const startTime = Date.now();
    try {
      const ev = normalize(req.body);
      if (!ev) {
        logEvent({ event: "route.invalid_body", level: "warn", data: {
          path: req.path, bodyKeys: Object.keys(req.body ?? {}),
        } });
        return res.status(400).json({ error: "缺少必要字段" });
      }
      if (!ev.studentId) {
        logEvent({ event: "route.missing_student_id", level: "warn", data: {
          path: req.path, bodyKeys: Object.keys(req.body ?? {}),
        } });
        return res.status(400).json({ error: "缺少 student_id" });
      }

      logEvent({ event: "route.event_received", data: {
        studentId: ev.studentId,
        studentName: ev.studentName,
        classId: ev.classId,
        eventType: ev.eventType,
        success: ev.success,
        errorType: ev.errorType,
        cacheKey: ev.cacheKey,
        ts: ev.ts,
        hasCodeSnippet: !!ev.codeSnippet,
      } });

      // runSuccess 只记活动信号，不调 LLM（spec §5 / §11 差距 #2）
      const explanation = ev.success ? null : await explainService.explain(ev);

      stateManager.apply(ev, explanation);
      persistence.insertEvent({
        studentId: ev.studentId, classId: ev.classId, eventType: ev.eventType,
        rawMessage: ev.rawMessage,
        category: ev.success ? "运行成功" : explanation!.category,
        subtype: ev.success ? null : explanation!.subtype,
        knowledge: ev.success ? null : explanation!.knowledge,
        filePath: ev.filePath ?? null, lineNo: ev.lineNo ?? null,
        exitCode: ev.exitCode ?? null,
        timestamp: new Date(ev.ts).toISOString(),
        codeSnippet: ev.codeSnippet ?? null,
      });

      hub.publish(buildSnapshot());
      logEvent({ event: "route.event_processed", data: {
        studentId: ev.studentId,
        eventType: ev.eventType,
        success: ev.success,
        explanationCategory: explanation?.category,
      }, durationMs: Date.now() - startTime });
      return res.json({ ok: true });
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

  // L1 全量归档（独立于分析链路；<traceDir>/trace/<classId>/<studentId>/...，TRACE_DIR 环境变量可覆盖）
  registerTraceArchiveRoutes(app, {
    traceDir: resolveTraceDir(deps.traceDir),
  });

  // LLM 聊天代理（学生端 teacher provider → 服务器 .env 配置的大模型）
  registerLlmProxy(app, deps.llmConfig !== undefined ? deps.llmConfig : readLlmConfigFromEnv());

  // 生产：托管 dashboard 构建产物
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get("/", (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  return { app, hub };
}
