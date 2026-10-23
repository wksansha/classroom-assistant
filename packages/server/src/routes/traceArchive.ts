// packages/server/src/routes/traceArchive.ts
import type { Express } from "express";
import type { TraceSurface } from "@classroom/shared";
import { logEvent } from "../logger";
import type { Persistence } from "../persistence";

const SURFACE_VALUES = new Set(["edit", "run", "chat", "debug", "diag", "behavior"]);
// student_id / class_id 作为入库检索维度，白名单防注入与脏数据（沿用旧文件版约束）
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TraceArchiveDeps {
  persistence: Persistence;
}

export function registerTraceArchiveRoutes(app: Express, deps: TraceArchiveDeps): void {
  // 同步 handler：better-sqlite3 单连接写本身串行，旧单文件写锁随文件存储一并退役
  app.post("/api/trace/archive", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId = typeof body.student_id === "string" ? body.student_id : "";
    const studentName = typeof body.student_name === "string" && body.student_name !== "" ? body.student_name : studentId;
    const classId = typeof body.class_id === "string" && body.class_id !== "" ? body.class_id : "default";
    const surface = typeof body.surface === "string" ? body.surface : "";
    const date = typeof body.date === "string" ? body.date : "";
    const events = Array.isArray(body.events) ? body.events : [];

    if (!studentId || !NAME_PATTERN.test(studentId) || studentId === "unknown") {
      logEvent({ event: "archive.batch_rejected", level: "warn", data: { reason: "student_id", studentId } });
      return res.status(400).json({ error: "student_id 非法" });
    }
    // 花名册门禁（2026-10-23 修订，推翻「归档不做身份校验」旧决策）：学号不在名册 → 400 拒收，
    // 防止数据挂到无效/他人学号下；客户端对 400 语义为「数据问题不重试、位点跳到文件尾」，拒收安全。
    // 权衡：名册为空（部署早期教师尚未导入）时放行并打 info 日志——此时拒收会不可逆丢数据（客户端跳尾）。
    if (!deps.persistence.getRosterEntry(studentId)) {
      if (deps.persistence.getRoster().length === 0) {
        logEvent({ event: "archive.roster_empty_allow", level: "info", data: { studentId } });
      } else {
        logEvent({ event: "archive.student_not_in_roster", level: "warn", data: { studentId } });
        return res.status(400).json({ error: "student not in roster" });
      }
    }
    if (!NAME_PATTERN.test(classId)) {
      return res.status(400).json({ error: "class_id 非法" });
    }
    if (!SURFACE_VALUES.has(surface)) {
      return res.status(400).json({ error: "surface 非法" });
    }
    if (!DATE_PATTERN.test(date)) {
      return res.status(400).json({ error: "date 非法" });
    }
    if (events.length === 0) {
      return res.status(400).json({ error: "events 不能为空" });
    }

    // 只写原始表：不解释、不推看板（spec §4.2）；INSERT OR IGNORE 按 event_id 幂等去重
    const rows = events.map((item) => {
      const e = (item ?? {}) as Record<string, any>;
      return {
        eventId: typeof e.id === "string" ? e.id : "",
        studentId,
        studentName,
        classId,
        surface: surface as TraceSurface,
        kind: typeof e.kind === "string" ? e.kind : "unknown",
        ts: typeof e.ts === "string" ? e.ts : new Date().toISOString(),
        sessionId: typeof e.session_id === "string" ? e.session_id : null,
        payload: JSON.stringify(e.payload ?? {}),
        date,
      };
    });
    const { accepted, duplicated } = deps.persistence.insertTraceEvents(rows);
    logEvent({ event: "archive.batch_received", data: { studentId, classId, surface, date, accepted, duplicated } });
    return res.json({ ok: true, accepted, duplicated });
  });
}
