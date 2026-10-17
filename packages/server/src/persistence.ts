import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Explanation, ReviewResult, RosterEntry, TraceSurface } from "@classroom/shared";
import { logEvent } from "./logger";

// 暂留至 Task 5（旧 /api/events handler 仍引用，届时随路由一并删除）
export interface EventRow {
  studentId: string;
  classId: string;
  eventType: "diag" | "run";
  rawMessage: string;
  category: string;
  subtype: string | null;
  knowledge: string | null;
  filePath: string | null;
  lineNo: number | null;
  exitCode: number | null;
  timestamp: string;
  codeSnippet?: string | null;
}

export interface TraceEventRow {
  eventId: string;
  studentId: string;
  studentName: string;
  classId: string;
  surface: TraceSurface;
  kind: string;
  ts: string;      // ISO-8601 UTC（字典序即时间序）
  sessionId: string | null;
  payload: string; // 原样 payload JSON
  date: string;    // YYYY-MM-DD（UTC）
}

export interface EventExplanation {
  category: string;
  subtype: string;
  knowledge: string;
  source: string; // 'llm' | 'mock'
}

// —— 行映射（snake_case DB 行 → camelCase 领域对象）——

export interface Persistence {
  insertEvent(row: EventRow): void; // 暂留至 Task 5
  insertTraceEvent(row: TraceEventRow, explanation?: EventExplanation): boolean;
  insertTraceEvents(rows: TraceEventRow[]): { accepted: number; duplicated: number };
  saveExplanation(eventId: string, exp: EventExplanation): void;
  hasExplanation(eventId: string): boolean;
  getRecentEvents(limit: number): any[];
  getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] };
  getCachedExplanation(rawHash: string): Explanation | null;
  saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void;
  getCacheStats(): { total: number; totalHits: number };
  // —— 花名册 ——
  replaceRoster(entries: RosterEntry[]): void;
  getRoster(): RosterEntry[];
  getRosterEntry(studentId: string): RosterEntry | null;
  upsertRosterEntry(studentId: string, studentName: string): void;
  updateRosterEntry(studentId: string, studentName: string): boolean;
  deleteRosterEntry(studentId: string): boolean;
  purgeRosterEntry(studentId: string): void;
  // —— 评审缓存（内容寻址：key = sha256(filePath + 评审输入)）——
  getCachedReview(cacheKey: string): ReviewResult | null;
  saveReviewCache(row: { cacheKey: string; review: ReviewResult }): void;
  // —— student_tokens（学生分支直连模型）——
  saveStudentToken(studentId: string, token: string): void;
  getStudentToken(studentId: string): string | null;
  close(): void;
}

export function createPersistence(dbPath?: string): Persistence {
  const file = dbPath ?? path.join(process.cwd(), "data", "assistant.db");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  // —— 作业域退役迁移（spec §0：不考虑迁移成本）——
  const tableExists = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const colsOf = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (tableExists("exercises")) db.exec("DROP TABLE exercises");
  if (tableExists("assignments")) db.exec("DROP TABLE assignments");
  if (tableExists("submissions")) db.exec("DROP TABLE submissions");   // notify 退役：提交流水以学生分支 git 历史为准
  if (tableExists("events")) db.exec("DROP TABLE events"); // 事件表退役（spec §5.4，无 event_id 不迁移）
  if (tableExists("review_cache") && colsOf("review_cache").includes("exercise_id")) {
    db.exec("DROP TABLE review_cache");   // 旧 key 公式（含 versionHash）已失效，丢弃无损
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_events (
      event_id     TEXT PRIMARY KEY,
      student_id   TEXT NOT NULL,
      student_name TEXT NOT NULL,
      class_id     TEXT NOT NULL DEFAULT 'default',
      surface      TEXT NOT NULL CHECK(surface IN ('edit','run','chat','debug','diag','behavior')),
      kind         TEXT NOT NULL,
      ts           TEXT NOT NULL,
      session_id   TEXT,
      payload      TEXT NOT NULL,
      date         TEXT NOT NULL,
      ingested_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trace_student_surface_ts ON trace_events(student_id, surface, ts);
    CREATE INDEX IF NOT EXISTS idx_trace_class_ts           ON trace_events(class_id, ts);
    CREATE INDEX IF NOT EXISTS idx_trace_date               ON trace_events(date);
    CREATE TABLE IF NOT EXISTS event_explanations (
      event_id  TEXT PRIMARY KEY,
      category  TEXT NOT NULL,
      subtype   TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      source    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS error_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_hash TEXT UNIQUE NOT NULL,
      raw_message TEXT NOT NULL,
      category TEXT NOT NULL,
      subtype TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      source TEXT DEFAULT 'llm',
      hit_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON error_cache(raw_hash);
    CREATE TABLE IF NOT EXISTS roster (
      student_id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_cache (
      cache_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      hit_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_tokens (
      student_id TEXT PRIMARY KEY,
      token TEXT NOT NULL
    );
  `);

  return {
    insertEvent(r) {
      db.prepare(`INSERT INTO events (student_id, class_id, event_type, raw_message, category, subtype, knowledge, file_path, line_no, exit_code, timestamp, code_snippet)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.studentId, r.classId, r.eventType, r.rawMessage, r.category, r.subtype, r.knowledge, r.filePath, r.lineNo, r.exitCode, r.timestamp, r.codeSnippet ?? null);
      logEvent({ event: "db.insert_event", level: "debug", data: {
        studentId: r.studentId,
        classId: r.classId,
        eventType: r.eventType,
        category: r.category,
        hasCodeSnippet: r.codeSnippet != null,
      } });
    },
    insertTraceEvent(row, explanation) {
      const insertRow = db.prepare(`INSERT OR IGNORE INTO trace_events
        (event_id, student_id, student_name, class_id, surface, kind, ts, session_id, payload, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const args = [row.eventId, row.studentId, row.studentName, row.classId, row.surface, row.kind, row.ts, row.sessionId, row.payload, row.date];
      if (!explanation) {
        return insertRow.run(...args).changes === 1;
      }
      const insertExp = db.prepare(`INSERT INTO event_explanations (event_id, category, subtype, knowledge, source) VALUES (?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        const ok = insertRow.run(...args).changes === 1;
        if (ok) insertExp.run(row.eventId, explanation.category, explanation.subtype, explanation.knowledge, explanation.source);
        return ok;
      });
      return tx();
    },
    insertTraceEvents(rows) {
      const ins = db.prepare(`INSERT OR IGNORE INTO trace_events
        (event_id, student_id, student_name, class_id, surface, kind, ts, session_id, payload, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction((rs: TraceEventRow[]) => {
        let accepted = 0;
        for (const r of rs) {
          if (ins.run(r.eventId, r.studentId, r.studentName, r.classId, r.surface, r.kind, r.ts, r.sessionId, r.payload, r.date).changes === 1) accepted++;
        }
        return accepted;
      });
      const accepted = tx(rows);
      return { accepted, duplicated: rows.length - accepted };
    },
    saveExplanation(eventId, exp) {
      db.prepare(`INSERT INTO event_explanations (event_id, category, subtype, knowledge, source) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET category = excluded.category, subtype = excluded.subtype,
          knowledge = excluded.knowledge, source = excluded.source`)
        .run(eventId, exp.category, exp.subtype, exp.knowledge, exp.source);
    },
    hasExplanation(eventId) {
      return !!db.prepare("SELECT 1 FROM event_explanations WHERE event_id = ?").get(eventId);
    },
    getRecentEvents(limit) {
      return db.prepare(`SELECT t.event_id, t.student_id, t.class_id, t.surface, t.kind, t.ts, t.session_id,
           t.payload, t.date, t.ingested_at,
           x.category, x.subtype, x.knowledge
         FROM trace_events t LEFT JOIN event_explanations x ON x.event_id = t.event_id
         ORDER BY t.ingested_at DESC, t.event_id DESC LIMIT ?`).all(limit);
    },
    getEventStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM trace_events").get() as { c: number }).c;
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = (db.prepare("SELECT COUNT(*) AS c FROM trace_events WHERE date = ?").get(today) as { c: number }).c;
      const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM event_explanations GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];
      return { total, todayCount, byCategory };
    },
    // 缓存命中/未命中/写入由 explainService/cache.ts 统一记录（cache.* 事件），此处不再重复打日志
    getCachedExplanation(rawHash) {
      const row = db.prepare("SELECT category, subtype, knowledge FROM error_cache WHERE raw_hash = ?").get(rawHash) as Explanation | undefined;
      if (!row) return null;
      db.prepare("UPDATE error_cache SET hit_count = hit_count + 1 WHERE raw_hash = ?").run(rawHash);
      return { category: row.category, subtype: row.subtype, knowledge: row.knowledge };
    },
    saveCache(rawHash, rawMessage, exp, source) {
      db.prepare(`INSERT INTO error_cache (raw_hash, raw_message, category, subtype, knowledge, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(raw_hash) DO UPDATE SET raw_message = excluded.raw_message, category = excluded.category,
          subtype = excluded.subtype, knowledge = excluded.knowledge, source = excluded.source, updated_at = CURRENT_TIMESTAMP`)
        .run(rawHash, rawMessage, exp.category, exp.subtype, exp.knowledge, source);
    },
    getCacheStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM error_cache").get() as { c: number }).c;
      const totalHits = (db.prepare("SELECT COALESCE(SUM(hit_count), 0) AS c FROM error_cache").get() as { c: number }).c;
      return { total, totalHits };
    },
    // —— 花名册 ——
    replaceRoster(entries) {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM roster").run();
        const ins = db.prepare("INSERT INTO roster (student_id, student_name, created_at) VALUES (?, ?, ?)");
        for (const e of entries) ins.run(e.studentId, e.studentName, Date.now());
      });
      tx();
    },
    getRoster() {
      return db.prepare("SELECT student_id AS studentId, student_name AS studentName FROM roster ORDER BY student_id").all() as RosterEntry[];
    },
    getRosterEntry(studentId) {
      return (db.prepare("SELECT student_id AS studentId, student_name AS studentName FROM roster WHERE student_id = ?").get(studentId) as RosterEntry) ?? null;
    },
    upsertRosterEntry(studentId, studentName) {
      db.prepare(`INSERT INTO roster (student_id, student_name, created_at) VALUES (?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET student_name = excluded.student_name`)
        .run(studentId, studentName, Date.now());
    },
    updateRosterEntry(studentId, studentName) {
      return db.prepare("UPDATE roster SET student_name = ? WHERE student_id = ?").run(studentName, studentId).changes > 0;
    },
    deleteRosterEntry(studentId) {
      return db.prepare("DELETE FROM roster WHERE student_id = ?").run(studentId).changes > 0;
    },
    purgeRosterEntry(studentId) {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM roster WHERE student_id = ?").run(studentId);
        db.prepare("DELETE FROM student_tokens WHERE student_id = ?").run(studentId);
      });
      tx();
    },
    // —— 评审缓存（内容寻址）——
    getCachedReview(cacheKey) {
      const r = db.prepare("SELECT status, reason, source, model FROM review_cache WHERE cache_key = ?").get(cacheKey) as
        { status: string; reason: string; source: string; model: string | null } | undefined;
      if (!r) return null;
      db.prepare("UPDATE review_cache SET hit_count = hit_count + 1 WHERE cache_key = ?").run(cacheKey);
      return { status: r.status as ReviewResult["status"], reason: r.reason,
        reviewedAt: 0, model: r.model ?? "", source: r.source as ReviewResult["source"] };
    },
    saveReviewCache(row) {
      db.prepare(`INSERT INTO review_cache (cache_key, status, reason, source, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, reason = excluded.reason,
          source = excluded.source, model = excluded.model`)
        .run(row.cacheKey, row.review.status, row.review.reason, row.review.source, row.review.model, Date.now());
    },
    // —— student_tokens（学生分支直连模型）——
    saveStudentToken(studentId, token) {
      db.prepare(`INSERT INTO student_tokens (student_id, token) VALUES (?, ?)
        ON CONFLICT(student_id) DO UPDATE SET token = excluded.token`).run(studentId, token);
    },
    getStudentToken(studentId) {
      const r = db.prepare("SELECT token FROM student_tokens WHERE student_id = ?").get(studentId) as { token: string } | undefined;
      return r?.token ?? null;
    },
    close() {
      db.close();
    },
  };
}
