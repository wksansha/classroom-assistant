import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";

const review = (status: "pass" | "fail", reason: string) =>
  ({ status, reason, reviewedAt: 1, model: "m", source: "llm" as const });

describe("persistence（提交轻量索引 + 评审缓存，作业域退役后）", () => {
  it("notify 行：files_json 原样往返，按 student 查询，review 初始 null", () => {
    const p = createPersistence(":memory:");
    p.insertNotifyRow({ id: "s1", studentId: "2025001", studentName: "张三", commitHash: "c1",
      filesJson: JSON.stringify(["lesson5/a.py", "lesson5/weather-app/main.py"]), submittedAt: 100 });
    const row = p.getSubmissionsByStudent("2025001")[0];
    expect(row.files).toEqual(["lesson5/a.py", "lesson5/weather-app/main.py"]);
    expect(row.commitHash).toBe("c1");
    expect(row.review).toBeNull();
  });

  it("幂等：同 (student, commit) 重复 notify → INSERT OR IGNORE 返回 false 不重复入库", () => {
    const p = createPersistence(":memory:");
    const row = { id: "s1", studentId: "2025001", studentName: "张三", commitHash: "c1", filesJson: "[]", submittedAt: 100 };
    expect(p.insertNotifyRow(row)).toBe(true);
    expect(p.insertNotifyRow({ ...row, id: "s2" })).toBe(false);   // 不同 id 同业务键也冲突
    expect(p.getSubmissionsByStudent("2025001")).toHaveLength(1);
  });

  it("review map 回填：按 filePath upsert，同 push 多文件互不覆盖", () => {
    const p = createPersistence(":memory:");
    p.insertNotifyRow({ id: "s1", studentId: "2025001", studentName: "张三", commitHash: "c1", filesJson: "[]", submittedAt: 100 });
    p.updateNotifyReview("s1", "lesson5/a.py", review("pass", "通过"));
    p.updateNotifyReview("s1", "lesson5/b.py", review("fail", "有错"));
    p.updateNotifyReview("s1", "lesson5/a.py", review("pass", "复评通过"));
    const map = p.getSubmissionsByStudent("2025001")[0].review!;
    expect(Object.keys(map).sort()).toEqual(["lesson5/a.py", "lesson5/b.py"]);
    expect(map["lesson5/a.py"].reason).toBe("复评通过");
    expect(map["lesson5/b.py"].status).toBe("fail");
  });

  it("review_cache：新 DDL（无 exercise_id/version_hash），save 覆盖 + get 命中", () => {
    const p = createPersistence(":memory:");
    p.saveReviewCache({ cacheKey: "k1", review: review("pass", "ok") });
    expect(p.getCachedReview("k1")?.status).toBe("pass");
    p.saveReviewCache({ cacheKey: "k1", review: review("fail", "no") });
    expect(p.getCachedReview("k1")?.status).toBe("fail");
    expect(p.getCachedReview("missing")).toBeNull();
  });

  it("存量库迁移：旧作业域表 DROP，旧 submissions/review_cache 重建，roster 保留", () => {
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
    const sCols = (check.prepare("PRAGMA table_info(submissions)").all() as { name: string }[]).map((c) => c.name);
    expect(sCols).not.toContain("exercise_id");
    expect(sCols).toContain("files_json");
    const rcCols = (check.prepare("PRAGMA table_info(review_cache)").all() as { name: string }[]).map((c) => c.name);
    expect(rcCols).not.toContain("exercise_id");
    check.close();
    expect(p.getRosterEntry("0001")).toEqual({ studentId: "0001", studentName: "张三" });   // roster 无损
    p.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  });
});
