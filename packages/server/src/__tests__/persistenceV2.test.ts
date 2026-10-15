import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";

const review = (status: "pass" | "fail", reason: string) =>
  ({ status, reason, reviewedAt: 1, model: "m", source: "llm" as const });

describe("persistence（评审缓存 + 迁移；notify 已退役）", () => {
  it("review_cache：内容寻址 DDL（无 exercise_id/version_hash），save 覆盖 + get 命中", () => {
    const p = createPersistence(":memory:");
    p.saveReviewCache({ cacheKey: "k1", review: review("pass", "ok") });
    expect(p.getCachedReview("k1")?.status).toBe("pass");
    p.saveReviewCache({ cacheKey: "k1", review: review("fail", "no") });
    expect(p.getCachedReview("k1")?.status).toBe("fail");
    expect(p.getCachedReview("missing")).toBeNull();
  });

  it("存量库迁移：旧作业域表与 submissions 全部 DROP，review_cache（旧形状）重建，roster 保留", () => {
    const file = path.join(os.tmpdir(), `mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE assignments (id TEXT PRIMARY KEY, title TEXT NOT NULL, week INTEGER NOT NULL UNIQUE, due_at INTEGER, created_at INTEGER NOT NULL, week_dir TEXT);
      CREATE TABLE exercises (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, order_no INTEGER NOT NULL, filename TEXT NOT NULL, problem_statement TEXT NOT NULL, starter_code TEXT, test_cases_json TEXT, version_hash TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'file', dir TEXT, entry TEXT);
      CREATE TABLE submissions (id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL, commit_hash TEXT NOT NULL, files_json TEXT NOT NULL, submitted_at INTEGER NOT NULL, review_json TEXT, UNIQUE(exercise_id, student_id, commit_hash));
      CREATE TABLE review_cache (cache_key TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, version_hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, model TEXT, hit_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE roster (student_id TEXT PRIMARY KEY, student_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    raw.prepare("INSERT INTO roster (student_id, student_name, created_at) VALUES ('0001', '张三', 1)").run();
    raw.close();

    const p = createPersistence(file);
    const check = new Database(file);
    const names = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("assignments");
    expect(names).not.toContain("exercises");
    expect(names).not.toContain("submissions");   // notify 已退役：提交流水以学生分支 git 历史为准
    const rcCols = (check.prepare("PRAGMA table_info(review_cache)").all() as { name: string }[]).map((c) => c.name);
    expect(rcCols).not.toContain("exercise_id");
    check.close();
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张三" });   // roster 无损
    p.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  });
});
