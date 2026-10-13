// packages/server/src/__tests__/traceArchive.test.ts
import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTraceArchiveRoutes } from "../routes/traceArchive";

const bases: string[] = [];
function makeApp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trace-archive-"));
  bases.push(base);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerTraceArchiveRoutes(app, { traceDir: base });
  return app;
}
afterAll(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

const ev = (id: string) => ({ id, ts: "2026-10-13T00:00:00.000Z", surface: "edit", kind: "code_change", payload: {} });
const post = (app: express.Express, body: Record<string, unknown>) =>
  request(app).post("/api/trace/archive").send(body);

function archived(baseDir: string, classId = "default", studentId = "2024001", surface = "edit", date = "2026-10-13") {
  return path.join(baseDir, "trace", classId, studentId, surface, `${date}.jsonl`);
}

describe("POST /api/trace/archive", () => {
  it("归档落位 + accepted 计数", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const res = await post(app, { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] }).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, duplicated: 0 });
    const text = fs.readFileSync(archived(base), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe("e1");
  });

  it("同 id 重传幂等（duplicated 计数、文件不重复）", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const batch = { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] };
    await post(app, batch).expect(200);
    const res = await post(app, batch).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, duplicated: 2 });
    expect(fs.readFileSync(archived(base), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("两台机器同日交错合并（不同 id 全部落盘）", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    await post(app, { student_id: "2024001", student_name: "张三", surface: "run", date: "2026-10-13", events: [ev("a:1")] }).expect(200);
    await post(app, { student_id: "2024001", student_name: "张三", surface: "run", date: "2026-10-13", events: [ev("b:1")] }).expect(200);
    expect(fs.readFileSync(archived(base, "default", "2024001", "run"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("class_id 缺省 default；自定义 class_id 落对应目录", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    await post(app, { student_id: "2024001", student_name: "张三", surface: "chat", date: "2026-10-13", events: [ev("c1")] }).expect(200);
    await post(app, { student_id: "2024002", student_name: "李四", class_id: "class-2", surface: "chat", date: "2026-10-13", events: [ev("c2")] }).expect(200);
    expect(fs.existsSync(archived(base, "default", "2024001", "chat"))).toBe(true);
    expect(fs.existsSync(archived(base, "class-2", "2024002", "chat"))).toBe(true);
  });

  it.each([
    [{ student_id: "../etc", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "路径穿越"],
    [{ student_id: "2024.01", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "含点非法字符"],
    [{ student_id: "unknown", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "保留字"],
    [{ surface: "edit", date: "2026-10-13", events: [ev("x")] }, "缺 student_id"],
    [{ student_id: "2024001", surface: "photo", date: "2026-10-13", events: [ev("x")] }, "非法 surface"],
    [{ student_id: "2024001", surface: "edit", date: "20261013", events: [ev("x")] }, "非法 date"],
    [{ student_id: "2024001", surface: "edit", date: "2026-10-13", events: [] }, "空 events"],
    [{ student_id: "2024001", class_id: "a/b", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "非法 class_id"],
  ])("校验拒绝：%#", async (body: Record<string, unknown>, _caseName: string) => {
    const app = makeApp();
    await post(app, body).expect(400);
  });

  it("并发写同一文件不丢行", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const mk = (p: string) => ({ student_id: "2024001", student_name: "张三", surface: "debug", date: "2026-10-13", events: [ev(`d-${p}-1`), ev(`d-${p}-2`)] });
    await Promise.all([post(app, mk("a")), post(app, mk("b"))]);
    expect(fs.readFileSync(archived(base, "default", "2024001", "debug"), "utf8").trim().split("\n")).toHaveLength(4);
  });
});
