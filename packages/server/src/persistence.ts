import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Explanation, ReviewResult, RosterEntry } from "@classroom/shared";
import { logEvent } from "./logger";

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

// —— 行映射（snake_case DB 行 → camelCase 领域对象）——

export interface Persistence {
  insertEvent(row: EventRow): void;
  getRecentEvents(limit: number): any[];
  getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] };
  getCachedExplanation(rawHash: string): Explanation | null;
  saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void;
  getCacheStats(): { total: number; totalHits: number };
  // —— 花名册 ——
  replaceRoster(entries: RosterEntry[]): void;
  getRoster(): RosterEntry[];
  getRosterEntry(studentId: string): RosterEntry | null;
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
  if (tableExists("review_cache") && colsOf("review_cache").includes("exercise_id")) {
    db.exec("DROP TABLE review_cache");   // 旧 key 公式（含 versionHash）已失效，丢弃无损
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      class_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('diag','run')),
      raw_message TEXT NOT NULL,
      category TEXT NOT NULL,
      subtype TEXT,
      knowledge TEXT,
      file_path TEXT,
      line_no INTEGER,
      exit_code INTEGER,
      timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      code_snippet TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_student ON events(student_id);
    CREATE INDEX IF NOT EXISTS idx_events_class_time ON events(class_id, timestamp);
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
    getRecentEvents(limit) {
      return db.prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    },
    getEventStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
      const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM events GROUP BY category ORDER BY count DESC").all() as { category: string; count: number }[];
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE DATE(timestamp) = ?").get(today) as { c: number }).c;
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
