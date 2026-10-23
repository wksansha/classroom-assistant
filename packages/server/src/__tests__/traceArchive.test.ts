import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { createPersistence } from "../persistence";
import { registerTraceArchiveRoutes } from "../routes/traceArchive";

function app() {
  const p = createPersistence(":memory:");
  const a = express();
  a.use(express.json());
  registerTraceArchiveRoutes(a, { persistence: p });
  return { a, p };
}

const payload = { command: "python a.py", exit_code: 1, error_message: "x" };
const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, ts: "2026-10-16T06:31:14.754Z", kind: "execution_error", payload, ...over,
});

const post = (a: express.Express, body: Record<string, unknown>) =>
  request(a).post("/api/trace/archive").send(body);

describe("POST /api/trace/archive 落库（spec §4.2）", () => {
  it("批量入库 accepted 计数；date/surface 取批次头", async () => {
    const { a, p } = app();
    const res = await post(a, {
      student_id: "stu001", class_id: "3A", surface: "run", date: "2026-10-16",
      events: [ev("e1"), ev("e2")],
    }).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, duplicated: 0 });
    const rows = p.getRecentEvents(10);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.event_id).sort()).toEqual(["e1", "e2"]); // 同秒入库次序不保证
    expect(rows.every((r: any) => r.date === "2026-10-16")).toBe(true);
    expect(rows.every((r: any) => r.surface === "run")).toBe(true);
    expect(rows.every((r: any) => r.student_id === "stu001")).toBe(true);
  });

  it("同 id 跨批次去重；批内重复也计数 duplicated", async () => {
    const { a, p } = app();
    const batch = { student_id: "stu001", class_id: "3A", surface: "run", date: "2026-10-16", events: [ev("e1")] };
    await post(a, batch).expect(200, { ok: true, accepted: 1, duplicated: 0 });
    await post(a, batch).expect(200, { ok: true, accepted: 0, duplicated: 1 });
    const res = await post(a, { ...batch, events: [ev("e2"), ev("e2")] }).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, duplicated: 1 });
    expect(p.getRecentEvents(10)).toHaveLength(2);
  });

  it("归档不解释：diag 事件入库但无解释行（category=null）", async () => {
    const { a, p } = app();
    await post(a, { student_id: "stu001", class_id: "3A", surface: "diag", date: "2026-10-16",
      events: [ev("d1", { kind: "diagnostics_change", payload: { samples: ["NameError: x"] } })] }).expect(200);
    const rows = p.getRecentEvents(1);
    expect(rows[0].surface).toBe("diag");
    expect(rows[0].category).toBeNull();
  });

  it("chat 等非 diag/run surface 同样入库", async () => {
    const { a, p } = app();
    await post(a, { student_id: "stu001", class_id: "3A", surface: "chat", date: "2026-10-16",
      events: [ev("c1", { kind: "user_message", payload: { text: "你好" } })] }).expect(200);
    expect(p.getRecentEvents(10)[0].surface).toBe("chat");
  });

  it("非法 surface / 空 events / 非法 student_id → 400", async () => {
    const { a } = app();
    await post(a, { student_id: "stu001", class_id: "3A", surface: "hack", date: "2026-10-16", events: [ev("e1")] }).expect(400);
    await post(a, { student_id: "stu001", class_id: "3A", surface: "run", date: "2026-10-16", events: [] }).expect(400);
    await post(a, { student_id: "../etc", class_id: "3A", surface: "run", date: "2026-10-16", events: [ev("e1")] }).expect(400);
  });
});

describe("POST /api/trace/archive 花名册门禁（2026-10-23 修订）", () => {
  const batch = { student_id: "stu001", class_id: "3A", surface: "run", date: "2026-10-16", events: [ev("g1")] };

  it("名册含该学号 → 200 放行", async () => {
    const { a, p } = app();
    p.replaceRoster([{ studentId: "stu001", studentName: "张三" }]);
    const res = await post(a, batch).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 1, duplicated: 0 });
  });

  it("名册非空但不含该学号 → 400 拒收", async () => {
    const { a, p } = app();
    p.replaceRoster([{ studentId: "stu002", studentName: "李四" }]);
    const res = await post(a, batch).expect(400);
    expect(res.body).toEqual({ error: "student not in roster" });
    expect(p.getRecentEvents(10)).toHaveLength(0); // 拒收不入库
  });

  it("名册为空 → 放行 200（部署早期妥协）", async () => {
    const { a, p } = app(); // :memory: 未导名册，roster 为空
    await post(a, batch).expect(200);
    expect(p.getRecentEvents(10)).toHaveLength(1);
  });
});
