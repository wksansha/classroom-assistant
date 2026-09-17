import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Explanation } from "@classroom/shared";

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
}

export interface Persistence {
  upsertStudent(id: string, name: string, classId: string): void;
  insertEvent(row: EventRow): void;
  getRecentEvents(limit: number): any[];
  getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] };
  getCachedExplanation(rawHash: string): Explanation | null;
  saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void;
  getCacheStats(): { total: number; totalHits: number };
}

export function createPersistence(dbPath?: string): Persistence {
  const file = dbPath ?? path.join(process.cwd(), "data", "assistant.db");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      class_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `);

  return {
    upsertStudent(id, name, classId) {
      db.prepare("INSERT INTO students (id, name, class_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = ?, class_id = ?")
        .run(id, name, classId, name, classId);
    },
    insertEvent(r) {
      db.prepare(`INSERT INTO events (student_id, class_id, event_type, raw_message, category, subtype, knowledge, file_path, line_no, exit_code, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.studentId, r.classId, r.eventType, r.rawMessage, r.category, r.subtype, r.knowledge, r.filePath, r.lineNo, r.exitCode, r.timestamp);
    },
    getRecentEvents(limit) {
      return db.prepare("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    },
    getEventStats() {
      const total = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
      const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM events GROUP BY category ORDER BY count DESC").all();
      const today = new Date().toISOString().slice(0, 10);
      const todayCount = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE DATE(timestamp) = ?").get(today) as { c: number }).c;
      return { total, todayCount, byCategory };
    },
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
  };
}
