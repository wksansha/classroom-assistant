import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "../persistence";

describe("review_results 与预热查询（spec dashboard-v2 §5.2/§5.4）", () => {
  it("saveReviewResult 三态落行；getReviewResultsSince 窗口过滤 + 升序 + 名册姓名回填", () => {
    const p = createPersistence(":memory:");
    p.upsertRosterEntry("s1", "张三");
    p.saveReviewResult({ studentId: "s1", classId: null, filePath: "l1/a.py", status: "fail", reason: "死循环", ts: 1000 });
    p.saveReviewResult({ studentId: "s2", classId: null, filePath: "l1/a.py", status: "unreviewed", reason: "评审不可用", ts: 1500 });
    p.saveReviewResult({ studentId: "s3", classId: null, filePath: "l1/a.py", status: "pass", reason: "通过", ts: 2000 });
    expect(p.getReviewResultsSince(0)).toEqual([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "fail", reason: "死循环", ts: 1000, taskId: null },
      { studentId: "s2", studentName: "s2", filePath: "l1/a.py", status: "unreviewed", reason: "评审不可用", ts: 1500, taskId: null },
      { studentId: "s3", studentName: "s3", filePath: "l1/a.py", status: "pass", reason: "通过", ts: 2000, taskId: null },
    ]);
    expect(p.getReviewResultsSince(1600)).toEqual([
      { studentId: "s3", studentName: "s3", filePath: "l1/a.py", status: "pass", reason: "通过", ts: 2000, taskId: null },
    ]);
  });

  it("getRunEventsSince：surface=run 且 kind 区分成败；edit/chat 不入", () => {
    const p = createPersistence(":memory:");
    const common = { studentName: "张三", classId: "3A", sessionId: null as string | null, payload: "{}", date: "2026-10-22" };
    p.insertTraceEvents([
      { eventId: "run:a", studentId: "s1", ...common, surface: "run", kind: "execution_success", ts: "2026-10-22T01:00:00.000Z" },
      { eventId: "run:b", studentId: "s1", ...common, surface: "run", kind: "execution_error", ts: "2026-10-22T01:05:00.000Z" },
      { eventId: "edit:c", studentId: "s1", ...common, surface: "edit", kind: "code_change", ts: "2026-10-22T01:06:00.000Z" },
    ]);
    expect(p.getRunEventsSince(Date.parse("2026-10-22T00:00:00.000Z"))).toEqual([
      { ts: Date.parse("2026-10-22T01:00:00.000Z"), success: true },
      { ts: Date.parse("2026-10-22T01:05:00.000Z"), success: false },
    ]);
  });

  it("getRunSuccessesSince：仅 run 成功且 payload 带 file；失败行与无 file 行跳过", () => {
    const p = createPersistence(":memory:");
    const common = { studentName: "张三", classId: "3A", sessionId: null as string | null, date: "2026-10-22" };
    p.insertTraceEvents([
      { eventId: "run:a", studentId: "s1", ...common, payload: JSON.stringify({ file: "l1/a.py" }), surface: "run", kind: "execution_success", ts: "2026-10-22T01:00:00.000Z" },
      { eventId: "run:b", studentId: "s1", ...common, payload: JSON.stringify({ file: "l1/a.py" }), surface: "run", kind: "execution_error", ts: "2026-10-22T01:05:00.000Z" },
      { eventId: "run:c", studentId: "s2", ...common, payload: "{}", surface: "run", kind: "execution_success", ts: "2026-10-22T01:07:00.000Z" },   // 无 file
    ]);
    expect(p.getRunSuccessesSince(Date.parse("2026-10-22T00:00:00.000Z"))).toEqual([
      { ts: Date.parse("2026-10-22T01:00:00.000Z"), studentId: "s1", studentName: "张三", filePath: "l1/a.py" },
    ]);
  });

  it("建表幂等：同一 DB 文件重复 createPersistence 不报错且数据保留", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-results-"));
    const dbPath = path.join(dir, "test.db");
    const p1 = createPersistence(dbPath);
    p1.saveReviewResult({ studentId: "s1", classId: "3A", filePath: "l1/a.py", status: "pass", reason: null, ts: 100 });
    p1.close();
    const p2 = createPersistence(dbPath);   // CREATE TABLE IF NOT EXISTS 二次执行
    expect(p2.getReviewResultsSince(0)).toEqual([
      { studentId: "s1", studentName: "s1", filePath: "l1/a.py", status: "pass", reason: null, ts: 100, taskId: null },
    ]);
    p2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
