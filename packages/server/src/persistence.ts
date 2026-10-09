import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Assignment, Exercise, Explanation, ReviewResult, RosterEntry, Submission, TestCase } from "@classroom/shared";
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

// —— 行映射（作业/练习/提交，snake_case DB 行 → camelCase 领域对象）——
type AssignmentDbRow = { id: string; title: string; week: number; due_at: number | null; is_published: number; created_at: number; published_at: number | null };
function toAssignment(r: AssignmentDbRow): Assignment {
  return { id: r.id, title: r.title, week: r.week, dueAt: r.due_at ?? undefined,
    isPublished: r.is_published === 1, createdAt: r.created_at, publishedAt: r.published_at ?? undefined };
}
type ExerciseDbRow = { id: string; assignment_id: string; order_no: number; filename: string; problem_statement: string; starter_code: string | null; test_cases_json: string | null; version_hash: string; is_active: number; created_at: number };
function toExercise(r: ExerciseDbRow): Exercise {
  return { id: r.id, assignmentId: r.assignment_id, order: r.order_no, filename: r.filename,
    problemStatement: r.problem_statement, starterCode: r.starter_code ?? undefined,
    testCases: r.test_cases_json ? (JSON.parse(r.test_cases_json) as TestCase[]) : [],
    versionHash: r.version_hash, isActive: r.is_active === 1, createdAt: r.created_at };
}
type SubmissionDbRow = { id: string; exercise_id: string; student_id: string; student_name: string; code: string; source: string; submitted_at: number; review_json: string | null };
function toSubmission(r: SubmissionDbRow): Submission {
  return { id: r.id, exerciseId: r.exercise_id, studentId: r.student_id, studentName: r.student_name,
    code: r.code, source: r.source as "auto" | "manual", submittedAt: r.submitted_at,
    review: r.review_json ? JSON.parse(r.review_json) : null };
}

export interface Persistence {
  upsertStudent(id: string, name: string, classId: string): void;
  insertEvent(row: EventRow): void;
  getRecentEvents(limit: number): any[];
  getEventStats(): { total: number; todayCount: number; byCategory: { category: string; count: number }[] };
  getCachedExplanation(rawHash: string): Explanation | null;
  saveCache(rawHash: string, rawMessage: string, exp: Explanation, source: string): void;
  getCacheStats(): { total: number; totalHits: number };
  // —— 作业系统（T2：名册/作业/练习/提交/评审缓存）——
  replaceRoster(entries: RosterEntry[]): void;
  getRoster(): RosterEntry[];
  getRosterEntry(studentId: string): RosterEntry | null;
  upsertAssignment(a: Assignment): void;
  updateAssignmentMeta(id: string, patch: { title?: string; dueAt?: number | null }): void;
  setAssignmentPublished(id: string, published: boolean, publishedAt: number | null): void;
  getAssignments(): Assignment[];
  getAssignment(id: string): Assignment | null;
  upsertExercise(e: Exercise): void;
  getExercises(assignmentId: string): Exercise[];
  getExercise(id: string): Exercise | null;
  findExerciseByPath(week: number, filename: string): Exercise | null;
  deactivateMissingExercises(week: number, activeIds: string[]): void;
  insertSubmission(s: Submission & { codeHash: string; gitSynced: boolean }): void;
  findSubmissionByKey(exerciseId: string, studentId: string, codeHash: string): Submission | null;
  updateSubmissionReview(id: string, review: ReviewResult): void;
  setSubmissionGitSynced(id: string): void;
  getSubmissionsByExercise(exerciseId: string): Submission[];
  getSubmissionsByStudent(studentId: string): Submission[];
  getUnsyncedSubmissions(): Submission[];
  getPendingReviewSubmissions(): Submission[];
  getCachedReview(cacheKey: string): ReviewResult | null;
  saveReviewCache(row: { cacheKey: string; exerciseId: string; versionHash: string; review: ReviewResult }): void;
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
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      week INTEGER NOT NULL UNIQUE,
      due_at INTEGER,
      is_published INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      published_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      order_no INTEGER NOT NULL,
      filename TEXT NOT NULL,
      problem_statement TEXT NOT NULL,
      starter_code TEXT,
      test_cases_json TEXT,
      version_hash TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_assignment ON exercises(assignment_id, filename);
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      code TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      git_synced INTEGER DEFAULT 0,
      submitted_at INTEGER NOT NULL,
      review_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_dedup ON submissions(exercise_id, student_id, code_hash);
    CREATE INDEX IF NOT EXISTS idx_submissions_exercise ON submissions(exercise_id);
    CREATE TABLE IF NOT EXISTS review_cache (
      cache_key TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL,
      version_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      hit_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  return {
    upsertStudent(id, name, classId) {
      db.prepare("INSERT INTO students (id, name, class_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = ?, class_id = ?")
        .run(id, name, classId, name, classId);
    },
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
    // —— 作业系统（T2）——
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
    upsertAssignment(a) {
      db.prepare(`INSERT INTO assignments (id, title, week, due_at, is_published, created_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, due_at = excluded.due_at,
          is_published = excluded.is_published, published_at = excluded.published_at`)
        .run(a.id, a.title, a.week, a.dueAt ?? null, a.isPublished ? 1 : 0, a.createdAt, a.publishedAt ?? null);
    },
    updateAssignmentMeta(id, patch) {
      if (patch.title !== undefined) db.prepare("UPDATE assignments SET title = ? WHERE id = ?").run(patch.title, id);
      if (patch.dueAt !== undefined) db.prepare("UPDATE assignments SET due_at = ? WHERE id = ?").run(patch.dueAt, id);
    },
    setAssignmentPublished(id, published, publishedAt) {
      db.prepare("UPDATE assignments SET is_published = ?, published_at = ? WHERE id = ?").run(published ? 1 : 0, publishedAt, id);
    },
    getAssignments() {
      return (db.prepare("SELECT * FROM assignments ORDER BY week").all() as AssignmentDbRow[]).map(toAssignment);
    },
    getAssignment(id) {
      const r = db.prepare("SELECT * FROM assignments WHERE id = ?").get(id) as AssignmentDbRow | undefined;
      return r ? toAssignment(r) : null;
    },
    upsertExercise(e) {
      db.prepare(`INSERT INTO exercises (id, assignment_id, order_no, filename, problem_statement, starter_code, test_cases_json, version_hash, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET order_no = excluded.order_no, problem_statement = excluded.problem_statement,
          starter_code = excluded.starter_code, test_cases_json = excluded.test_cases_json,
          version_hash = excluded.version_hash, is_active = excluded.is_active`)
        .run(e.id, e.assignmentId, e.order, e.filename, e.problemStatement, e.starterCode ?? null,
          JSON.stringify(e.testCases ?? []), e.versionHash, e.isActive ? 1 : 0, e.createdAt);
    },
    getExercises(assignmentId) {
      return (db.prepare("SELECT * FROM exercises WHERE assignment_id = ? ORDER BY order_no").all(assignmentId) as ExerciseDbRow[]).map(toExercise);
    },
    getExercise(id) {
      const r = db.prepare("SELECT * FROM exercises WHERE id = ?").get(id) as ExerciseDbRow | undefined;
      return r ? toExercise(r) : null;
    },
    findExerciseByPath(week, filename) {
      const r = db.prepare(`SELECT e.* FROM exercises e JOIN assignments a ON e.assignment_id = a.id
        WHERE a.week = ? AND e.filename = ?`).get(week, filename) as ExerciseDbRow | undefined;
      return r ? toExercise(r) : null;
    },
    deactivateMissingExercises(week, activeIds) {
      const placeholders = activeIds.map(() => "?").join(",") || "''";
      db.prepare(`UPDATE exercises SET is_active = 0 WHERE is_active = 1 AND assignment_id IN
        (SELECT id FROM assignments WHERE week = ?) AND id NOT IN (${placeholders})`).run(week, ...activeIds);
    },
    insertSubmission(s) {
      db.prepare(`INSERT INTO submissions (id, exercise_id, student_id, student_name, code, code_hash, source, git_synced, submitted_at, review_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.id, s.exerciseId, s.studentId, s.studentName, s.code, s.codeHash, s.source, s.gitSynced ? 1 : 0, s.submittedAt, null);
    },
    findSubmissionByKey(exerciseId, studentId, codeHash) {
      const r = db.prepare("SELECT * FROM submissions WHERE exercise_id = ? AND student_id = ? AND code_hash = ?")
        .get(exerciseId, studentId, codeHash) as SubmissionDbRow | undefined;
      return r ? toSubmission(r) : null;
    },
    updateSubmissionReview(id, review) {
      db.prepare("UPDATE submissions SET review_json = ? WHERE id = ?").run(JSON.stringify(review), id);
    },
    setSubmissionGitSynced(id) {
      db.prepare("UPDATE submissions SET git_synced = 1 WHERE id = ?").run(id);
    },
    getSubmissionsByExercise(exerciseId) {
      return (db.prepare("SELECT * FROM submissions WHERE exercise_id = ? ORDER BY submitted_at DESC").all(exerciseId) as SubmissionDbRow[]).map(toSubmission);
    },
    getSubmissionsByStudent(studentId) {
      return (db.prepare("SELECT * FROM submissions WHERE student_id = ? ORDER BY submitted_at DESC").all(studentId) as SubmissionDbRow[]).map(toSubmission);
    },
    getUnsyncedSubmissions() {
      return (db.prepare("SELECT * FROM submissions WHERE git_synced = 0").all() as SubmissionDbRow[]).map(toSubmission);
    },
    getPendingReviewSubmissions() {
      return (db.prepare("SELECT * FROM submissions WHERE review_json IS NULL").all() as SubmissionDbRow[]).map(toSubmission);
    },
    getCachedReview(cacheKey) {
      const r = db.prepare("SELECT status, reason, source, model FROM review_cache WHERE cache_key = ?").get(cacheKey) as
        { status: string; reason: string; source: string; model: string | null } | undefined;
      if (!r) return null;
      db.prepare("UPDATE review_cache SET hit_count = hit_count + 1 WHERE cache_key = ?").run(cacheKey);
      return { status: r.status as ReviewResult["status"], reason: r.reason,
        reviewedAt: 0, model: r.model ?? "", source: r.source as ReviewResult["source"] };
    },
    saveReviewCache(row) {
      db.prepare(`INSERT INTO review_cache (cache_key, exercise_id, version_hash, status, reason, source, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, reason = excluded.reason,
          source = excluded.source, model = excluded.model`)
        .run(row.cacheKey, row.exerciseId, row.versionHash, row.review.status, row.review.reason,
          row.review.source, row.review.model, Date.now());
    },
  };
}
