import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../index";

// public-lite 精简部署（LITE_MODE=1）行为验证：
// 1) /api/events 仅收 run 与 behavior（登录态信号），edit/diag 静默 204 丢弃
// 2) run 失败不做 LLM 解释（无 GLM 外呼），仅入库 + 状态判定
// 3) 评审路由与聊天代理返回 404 JSON
// 4) 心跳在线判定不受影响

function makeApp() {
  const { app, hub } = createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null });
  const pushes = vi.spyOn(hub, "publish");
  return { app, pushes };
}

const runError = (id: string) => ({
  id, ts: new Date().toISOString(), surface: "run", kind: "execution_error",
  payload: { command: "python a.py", exit_code: 1, error_type: "ZeroDivisionError", error_message: "division by zero" },
  student_id: "2025001", student_name: "张三", class_id: "3A",
});
const runSuccess = (id: string) => ({
  id, ts: new Date().toISOString(), surface: "run", kind: "execution_success",
  payload: { command: "python a.py", exit_code: 0 },
  student_id: "2025001", student_name: "张三", class_id: "3A",
});
const editEvent = (id: string) => ({
  id, ts: new Date().toISOString(), surface: "edit", kind: "code_change",
  payload: { file: "a.py" },
  student_id: "2025001", student_name: "张三", class_id: "3A",
});
const diagEvent = (id: string) => ({
  id, ts: new Date().toISOString(), surface: "diag", kind: "diagnostics_change",
  payload: { file: "a.py", errors: 1, warnings: 0 },
  student_id: "2025001", student_name: "张三", class_id: "3A",
});
const confirmedEvent = (id: string) => ({
  id, ts: new Date().toISOString(), surface: "behavior", kind: "identity_confirmed",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { machine_id: "m1", session_id: "win-1" },
});

beforeEach(() => {
  process.env.LITE_MODE = "1";
});
afterEach(() => {
  delete process.env.LITE_MODE;
});

describe("public-lite 精简部署（LITE_MODE=1）", () => {
  it("edit/diag 实时上报 → 204 静默丢弃：不入库、不推快照", async () => {
    const { app, pushes } = makeApp();
    await request(app).post("/api/events").send(editEvent("edit:lite-0001")).expect(204);
    await request(app).post("/api/events").send(diagEvent("diag:lite-0001")).expect(204);
    const events = (await request(app).get("/api/events").expect(200)).body;
    expect(events).toHaveLength(0);
    expect(pushes).not.toHaveBeenCalled();
  });

  it("run 失败正常入库：变黄 + 无 LLM 解释字段", async () => {
    const { app } = makeApp();
    await request(app).post("/api/events").send(runError("run:lite-e01")).expect(200, { ok: true, duplicated: false });
    const summary = (await request(app).get("/api/summary").expect(200)).body;
    expect(summary.students[0].status).toBe("yellow");
    const events = (await request(app).get("/api/events").expect(200)).body;
    expect(events).toHaveLength(1);
    expect(events[0].category).toBeNull();   // lite 不做 LLM 解释
    expect(events[0].surface).toBe("run");
  });

  it("run 成功（无前置错误）→ 绿色 + 运行计数；错误后 run 成功不置绿（评审才清零）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/events").send(runSuccess("run:lite-s01")).expect(200);
    const s1 = (await request(app).get("/api/summary").expect(200)).body;
    expect(s1.students[0].status).toBe("green");
    expect(s1.stats.runs).toBe(1);
    await request(app).post("/api/events").send(runError("run:lite-e02")).expect(200);
    await request(app).post("/api/events").send(runSuccess("run:lite-s02")).expect(200);
    const s2 = (await request(app).get("/api/summary").expect(200)).body;
    expect(s2.students[0].status).toBe("yellow");
    expect(s2.stats.runs).toBe(2);
  });

  it("behavior 登录态信号保留：identity_confirmed → 在线点亮", async () => {
    const { app } = makeApp();
    await request(app).post("/api/events").send(confirmedEvent("behavior:lite-01")).expect(200);
    const summary = (await request(app).get("/api/summary").expect(200)).body;
    expect(summary.students[0]).toMatchObject({ online: true, machineCount: 1 });
  });

  it("聊天代理 → 404 JSON（lite 未启用）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/llm/chat/completions").send({ messages: [] })
      .expect(404, { error: "lite 部署未启用聊天" });
    await request(app).get("/api/llm/chat/completions")
      .expect(404, { error: "lite 部署未启用聊天" });
  });

  it("评审路由 → 404 JSON（lite 未启用）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/reviews/request").send({})
      .expect(404, { error: "lite 部署未启用评审" });
  });

  it("心跳在线判定不受影响：第一拍建档点亮", async () => {
    const { app } = makeApp();
    await request(app).post("/api/heartbeat")
      .send({ student_id: "2025001", student_name: "张三", machine_id: "m1" })
      .expect(200, { ok: true });
    const summary = (await request(app).get("/api/summary").expect(200)).body;
    expect(summary.students[0]).toMatchObject({ online: true, machineCount: 1 });
  });
});
