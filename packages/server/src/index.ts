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

export interface AppDeps {
  /** 测试传 ":memory:"；缺省 data/assistant.db（相对 server 包） */
  dbPath?: string;
  /** 生产传 dashboard/dist 目录；缺省/不存在则不托管静态文件 */
  staticDir?: string | null;
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

  const app = express();
  app.use(cors());
  app.use(express.json());

  // SSE（spec §6）
  app.get("/api/stream/teacher", (req, res) => hub.handleStream(req, res));

  // 学生上报（learner 零改造：flat 格式不变）
  app.post("/api/events", async (req, res) => {
    const ev = normalize(req.body);
    if (!ev) return res.status(400).json({ error: "缺少必要字段" });

    persistence.upsertStudent(ev.studentId, ev.studentName, ev.classId);

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
    });

    hub.publish(buildSnapshot());
    res.json({ ok: true });
  });

  // 全量快照（首载/断线重连补齐）
  app.get("/api/summary", (_req, res) => res.json(buildSnapshot()));

  // 单生错误历史（抽屉）
  app.get("/api/student/:id", (req, res) => {
    const detail = stateManager.getStudentDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "未找到该学生" });
    res.json(detail);
  });

  // 标记建议已处理（V1 仅内存）
  app.post("/api/suggestions/ack", (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : null;
    if (!id) return res.status(400).json({ error: "缺少 id" });
    aggregator.ack(id);
    res.json({ ok: true });
  });

  // 调试接口（沿用 demo）
  app.get("/api/events", (req, res) =>
    res.json(persistence.getRecentEvents(parseInt(String(req.query.limit ?? "50"), 10))));
  app.get("/api/stats", (_req, res) => res.json({
    events: persistence.getEventStats(),
    cache: persistence.getCacheStats(),
    runtime: cache.getStats(),
    onlineClients: hub.clientCount(),
  }));

  // 生产：托管 dashboard 构建产物
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get("/", (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  return { app, hub };
}
