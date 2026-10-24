import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../index";
import { createStateManager, HEARTBEAT_TIMEOUT_MS } from "../stateManager";

// ── stateManager 单元（翻转语义）─────────────────────────────

function makeSm() {
  return createStateManager();
}

describe("stateManager 机器会话（登录态在线模型）", () => {
  it("confirmLogin：离线→在线翻转 true；同机重复确认（幂等）不翻转", () => {
    const sm = makeSm();
    expect(sm.confirmLogin("001", "张三", "3A", "m1", 1000)).toBe(true);
    expect(sm.confirmLogin("001", "张三", "3A", "m1", 2000)).toBe(false);
  });

  it("同机多窗口各确认一次 → 仍一台机器（在线、计数 1）", () => {
    const sm = makeSm();
    sm.confirmLogin("001", "张三", "3A", "m1", 1000);
    expect(sm.confirmLogin("001", "张三", "3A", "m1", 1500)).toBe(false);
    const r = sm.listRecords()[0];
    expect(r.machines.size).toBe(1);
  });

  it("logout：在线→离线翻转 true；重复登出不翻转", () => {
    const sm = makeSm();
    sm.confirmLogin("001", "张三", "3A", "m1", 1000);
    expect(sm.logout("001", "m1")).toBe(true);
    expect(sm.logout("001", "m1")).toBe(false);
  });

  it("logout 后同键心跳不复活；identity_confirmed 可重开", () => {
    const sm = makeSm();
    sm.confirmLogin("001", "张三", "3A", "m1", 1000);
    sm.logout("001", "m1");
    expect(sm.heartbeat("001", "张三", "3A", "m1", 2000)).toBe(false);   // 切换竞态防护
    expect(sm.confirmLogin("001", "张三", "3A", "m1", 3000)).toBe(true); // 显式重新登录可重开
  });

  it("sweep 超时下线翻转；timeout 后心跳可重开（断网自愈）", () => {
    const sm = makeSm();
    sm.confirmLogin("001", "张三", "3A", "m1", 1000);
    expect(sm.sweep(1000 + HEARTBEAT_TIMEOUT_MS)).toBe(false);   // 恰好不超（> 才判超时）
    expect(sm.sweep(1000 + HEARTBEAT_TIMEOUT_MS + 1)).toBe(true);
    expect(sm.heartbeat("001", "张三", "3A", "m1", 5000)).toBe(true);   // timeout 可重开
  });

  it("双机：一台登出另一台仍在线（logout 不翻转全局）", () => {
    const sm = makeSm();
    expect(sm.confirmLogin("001", "张三", "3A", "m1", 1000)).toBe(true);
    expect(sm.confirmLogin("001", "张三", "3A", "m2", 1100)).toBe(false);   // 已在线，不再翻转
    expect(sm.logout("001", "m1")).toBe(false);   // m2 还活着，全局仍在线
    expect(sm.listRecords()[0].machines.get("m2")?.closed).toBe(false);
    expect(sm.logout("001", "m2")).toBe(true);    // 最后一台登出才翻转
  });

  it("heartbeat 无档案时建档（服务端重启自愈）", () => {
    const sm = makeSm();
    expect(sm.heartbeat("001", "张三", "3A", "m1", 1000)).toBe(true);
    expect(sm.listRecords()[0].studentName).toBe("张三");
  });
});

// ── HTTP 层（/api/events 信号识别 + /api/heartbeat）──────────

function makeApp() {
  const { app, hub } = createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null });
  const pushes = vi.spyOn(hub, "publish");
  return { app, pushes };
}

const confirmedBody = (n: number, machineId = "m1") => ({
  id: `behavior:logintest000000000000000000000${n}`, ts: Date.now(), surface: "behavior", kind: "identity_confirmed",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { machine_id: machineId, session_id: "win-1" },
});
const sessionEndBody = (n: number, machineId = "m1") => ({
  id: `behavior:logouttest00000000000000000000${n}`, ts: Date.now(), surface: "behavior", kind: "session_end",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { machine_id: machineId, reason: "identity_switch" },
});
const student = (summary: { students: Array<{ online: boolean; machineCount: number }> }) => summary.students[0];

describe("登录态在线 HTTP 链路", () => {
  it("identity_confirmed → 立即在线 machineCount=1 并推快照；双机 → ×2", async () => {
    const { app, pushes } = makeApp();
    await request(app).post("/api/events").send(confirmedBody(1)).expect(200);
    const s1 = await request(app).get("/api/summary").expect(200);
    expect(student(s1.body)).toMatchObject({ online: true, machineCount: 1 });
    expect(pushes).toHaveBeenCalled();
    await request(app).post("/api/events").send(confirmedBody(2, "m2")).expect(200);
    const s2 = await request(app).get("/api/summary").expect(200);
    expect(student(s2.body)).toMatchObject({ online: true, machineCount: 2 });
  });

  it("session_end → 立即下线；另一台机器不受影响", async () => {
    const { app } = makeApp();
    await request(app).post("/api/events").send(confirmedBody(1)).expect(200);
    await request(app).post("/api/events").send(confirmedBody(2, "m2")).expect(200);
    await request(app).post("/api/events").send(sessionEndBody(3, "m1")).expect(200);
    const s = await request(app).get("/api/summary").expect(200);
    expect(student(s.body)).toMatchObject({ online: true, machineCount: 1 });
    await request(app).post("/api/events").send(sessionEndBody(4, "m2")).expect(200);
    const s2 = await request(app).get("/api/summary").expect(200);
    expect(student(s2.body)).toMatchObject({ online: false, machineCount: 0 });
  });

  it("缺 machine_id 的登录/登出信号被忽略（旧客户端防御）", async () => {
    const { app, pushes } = makeApp();
    await request(app).post("/api/events").send({
      ...confirmedBody(1), payload: { session_id: "win-1" },
    }).expect(200);
    expect(pushes).not.toHaveBeenCalled();
    const s = await request(app).get("/api/summary").expect(200);
    expect(s.body.stats.online).toBe(0);   // behavior 事件不建档，不点亮
  });

  it("/api/heartbeat：无档案第一拍建档点亮（服务端重启自愈）；logout 后心跳不复活", async () => {
    const { app } = makeApp();
    await request(app).post("/api/heartbeat").send({ student_id: "2025001", student_name: "张三", machine_id: "m1" }).expect(200, { ok: true });
    const s = await request(app).get("/api/summary").expect(200);
    expect(student(s.body)).toMatchObject({ online: true, machineCount: 1 });
    await request(app).post("/api/events").send(sessionEndBody(1)).expect(200);
    await request(app).post("/api/heartbeat").send({ student_id: "2025001", student_name: "张三", machine_id: "m1" }).expect(200);
    const s2 = await request(app).get("/api/summary").expect(200);
    expect(student(s2.body).online).toBe(false);
  });

  it("/api/heartbeat 参数非法 → 400", async () => {
    const { app } = makeApp();
    await request(app).post("/api/heartbeat").send({ student_id: "bad id!", machine_id: "m1" }).expect(400);
    await request(app).post("/api/heartbeat").send({ student_id: "2025001" }).expect(400);
    await request(app).post("/api/heartbeat").send({}).expect(400);
  });

  it("告警排除未在线学生：报错但未确认 → 不进急需帮助；确认后进入", async () => {
    const { app } = makeApp();
    await request(app).post("/api/events").send({
      id: "run:loginalerttest0000000000000000001", ts: Date.now(), surface: "run", kind: "execution_error",
      student_id: "2025001", student_name: "张三", class_id: "3A",
      payload: { file: "l1/a.py", exit_code: 1, error_type: "NameError", error_message: "x" },
    }).expect(200);
    let s = await request(app).get("/api/summary").expect(200);
    expect(s.body.alerts).toHaveLength(0);   // 未确认：错误在案但不告警
    expect(s.body.students[0].online).toBe(false);
    await request(app).post("/api/events").send(confirmedBody(1)).expect(200);
    s = await request(app).get("/api/summary").expect(200);
    expect(s.body.alerts).toHaveLength(1);   // 确认在线后：错误进入告警
  });
});
