// packages/server/src/routes/traceArchive.ts
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "../logger";

const SURFACE_VALUES = new Set(["edit", "run", "chat", "debug", "diag", "behavior"]);
// student_id / class_id 直接拼进归档路径，目录名白名单防路径穿越
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TraceArchiveDeps {
  /** 数据根目录（TRACE_DIR 环境变量；归档落在 <traceDir>/trace/<classId>/<studentId>/<surface>/<date>.jsonl） */
  traceDir: string;
}

export function registerTraceArchiveRoutes(app: Express, deps: TraceArchiveDeps): void {
  // per-file 写锁：并发请求对同一归档文件读改写时串行化，防丢行（与客户端 L1Writer 锁模式同思路）
  const locks = new Map<string, Promise<unknown>>();

  app.post("/api/trace/archive", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId = typeof body.student_id === "string" ? body.student_id : "";
    const classId = typeof body.class_id === "string" && body.class_id !== "" ? body.class_id : "default";
    const surface = typeof body.surface === "string" ? body.surface : "";
    const date = typeof body.date === "string" ? body.date : "";
    const events = Array.isArray(body.events) ? body.events : [];

    if (!studentId || !NAME_PATTERN.test(studentId) || studentId === "unknown") {
      logEvent({ event: "archive.batch_rejected", level: "warn", data: { reason: "student_id", studentId } });
      return res.status(400).json({ error: "student_id 非法" });
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

    const fileDir = path.join(deps.traceDir, "trace", classId, studentId, surface);
    const filePath = path.join(fileDir, `${date}.jsonl`);

    const prev = locks.get(filePath) ?? Promise.resolve();
    const task = prev.catch(() => {}).then(() => {
      fs.mkdirSync(fileDir, { recursive: true });
      // 按事件 id 幂等判重：多机同日同名文件交错、客户端重传均不产生重复
      const existing = new Set<string>();
      if (fs.existsSync(filePath)) {
        for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { id?: unknown };
            if (typeof parsed.id === "string") existing.add(parsed.id);
          } catch {
            // 坏行跳过，不影响判重
          }
        }
      }
      const fresh: string[] = [];
      let duplicated = 0;
      for (const item of events) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || existing.has(id)) {
          duplicated++;
          continue;
        }
        existing.add(id);
        fresh.push(JSON.stringify(item));
      }
      if (fresh.length > 0) {
        fs.appendFileSync(filePath, fresh.join("\n") + "\n");
      }
      return { accepted: fresh.length, duplicated };
    });
    locks.set(filePath, task.catch(() => {}));

    task
      .then(({ accepted, duplicated }) => {
        logEvent({ event: "archive.batch_received", data: { studentId, classId, surface, date, accepted, duplicated } });
        return res.json({ ok: true, accepted, duplicated });
      })
      .catch((err: unknown) => {
        // 兜底：未捕获异常返回 JSON（避免 Express 5 默认 HTML 500）
        logEvent({ event: "archive.batch_error", level: "error", data: { error: err instanceof Error ? err.message : String(err) } });
        return res.status(500).json({ error: "服务器内部错误" });
      });
  });
}
