import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence, type TraceEventRow } from "../persistence";

const exp = { category: "运算错误", subtype: "除数为0", knowledge: "除数不能为 0", source: "llm" as const };

const row = (over: Partial<TraceEventRow> = {}): TraceEventRow => ({
  eventId: "run:01J0ARZ9V8B", studentId: "stu001", studentName: "张三", classId: "3A",
  surface: "run", kind: "execution_error", ts: "2026-10-16T02:00:00.000Z",
  sessionId: null, payload: JSON.stringify({ error_message: "division by zero" }),
  date: "2026-10-16", ...over,
});

describe("persistence trace_events / event_explanations（SQLite，:memory:）", () => {
  let p: ReturnType<typeof createPersistence>;
  beforeEach(() => { p = createPersistence(":memory:"); });

  it("insertTraceEvent 新事件返回 true，getRecentEvents 读回字段完整", () => {
    expect(p.insertTraceEvent(row())).toBe(true);
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("run:01J0ARZ9V8B");
    expect(rows[0].student_id).toBe("stu001");
    expect(rows[0].surface).toBe("run");
    expect(rows[0].kind).toBe("execution_error");
    expect(rows[0].payload).toBe(JSON.stringify({ error_message: "division by zero" }));
    expect(rows[0].date).toBe("2026-10-16");
    expect(rows[0].category).toBeNull(); // 未写解释
  });

  it("同 event_id 幂等：第二次返回 false，不产生重复行", () => {
    expect(p.insertTraceEvent(row())).toBe(true);
    expect(p.insertTraceEvent(row())).toBe(false);
    expect(p.getRecentEvents(10)).toHaveLength(1);
  });

  it("解释随原始行同事务写入；幂等命中不重复写解释", () => {
    expect(p.insertTraceEvent(row(), exp)).toBe(true);
    expect(p.insertTraceEvent(row(), exp)).toBe(false);
    const rows = p.getRecentEvents(10);
    expect(rows[0].category).toBe("运算错误");
    expect(rows[0].subtype).toBe("除数为0");
    expect(rows[0].knowledge).toBe("除数不能为 0");
  });

  it("insertTraceEvents 批量计数 accepted/duplicated（单事务）", () => {
    const r = p.insertTraceEvents([row({ eventId: "a:1" }), row({ eventId: "a:2" }), row({ eventId: "a:1" })]);
    expect(r).toEqual({ accepted: 2, duplicated: 1 });
    expect(p.getRecentEvents(10)).toHaveLength(2);
  });

  it("saveExplanation INSERT OR REPLACE；hasExplanation 判断", () => {
    p.insertTraceEvent(row({ eventId: "a:1" }));
    expect(p.hasExplanation("a:1")).toBe(false);
    p.saveExplanation("a:1", exp);
    expect(p.hasExplanation("a:1")).toBe(true);
    p.saveExplanation("a:1", { ...exp, subtype: "除数为零" });
    expect(p.getRecentEvents(1)[0].subtype).toBe("除数为零");
  });

  it("getEventStats：total/todayCount 基于 trace_events，byCategory 基于侧表", () => {
    const today = new Date().toISOString().slice(0, 10); // todayCount 按 UTC 今天统计，行数据需落在当天
    p.insertTraceEvent(row({ eventId: "a:1", date: today }), exp);
    p.insertTraceEvent(row({ eventId: "a:2", surface: "chat", kind: "user_message", date: today }));
    const s = p.getEventStats();
    expect(s.total).toBe(2);
    expect(s.todayCount).toBe(2);
    expect(s.byCategory).toEqual([{ category: "运算错误", count: 1 }]);
  });

  it("启动迁移：旧 events 表被 DROP，error_cache/roster 等无损", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-mig-"));
    const file = path.join(dir, "t.db");
    const pre = new Database(file);
    pre.exec("CREATE TABLE events (id INTEGER PRIMARY KEY)");
    pre.exec("CREATE TABLE error_cache (raw_hash TEXT UNIQUE NOT NULL, hit_count INTEGER DEFAULT 0)");
    pre.close();
    const p2 = createPersistence(file);
    expect(p2.getRecentEvents(5)).toEqual([]);
    expect((p2 as any).getCacheStats().total).toBe(0); // error_cache 表存活即可
    p2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
