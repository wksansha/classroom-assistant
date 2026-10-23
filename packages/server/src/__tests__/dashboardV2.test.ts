import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../index";

function makeApp() {
  const { app, hub } = createApp({ dbPath: ":memory:", llmConfig: null, reviewConfig: null });
  const pushes = vi.spyOn(hub, "publish");
  return { app, pushes };
}

const editBody = (n: number) => ({
  id: `edit:dashboardv2test000${n}`, ts: Date.now(), surface: "edit", kind: "code_change",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { file: "l1/a.py", changes: 1 },
});
const runErrorBody = (n: number) => ({
  id: `run:dashboardv2test000${n}`, ts: Date.now(), surface: "run", kind: "execution_error",
  student_id: "2025001", student_name: "张三", class_id: "3A",
  payload: { file: "lesson1/a.py", exit_code: 1, error_type: "NameError", error_message: "name 'x' is not defined" },
});

describe("按天窗口与 V2 快照（spec dashboard-v2）", () => {
  it("快照字段就位：exerciseProgress/trend/stats；无 classSession 字段", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/summary").expect(200);
    expect(res.body.exerciseProgress).toEqual([]);
    expect(res.body.trend).toEqual([]);
    expect(res.body.stats).toEqual({ online: 0, total: 0, needHelp: 0, runs: 0 });
    expect(res.body.classSession).toBeUndefined();
  });

  it("edit 事件：首次跨边界推快照 + 学生转活跃；同窗口连续 edit 不再推；幂等命中不推", async () => {
    const { app, pushes } = makeApp();
    await request(app).post("/api/events").send(editBody(1)).expect(200);
    expect(pushes).toHaveBeenCalledTimes(1);
    await request(app).post("/api/events").send(editBody(2)).expect(200);
    expect(pushes).toHaveBeenCalledTimes(1);          // 边沿触发：同一天内不刷屏
    await request(app).post("/api/events").send(editBody(1)).expect(200, { ok: true, duplicated: true });
    expect(pushes).toHaveBeenCalledTimes(1);          // 幂等命中跳过
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.students[0]).toMatchObject({ studentId: "2025001", status: "green" });
    expect(summary.body.stats).toMatchObject({ online: 1, total: 1 });
  });

  it("run 失败事件：当天涌现题 stuck=1 + 通过率（花名册分母）+ 趋势 errors 桶", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四\n2025003 王五\n2025004 赵六" }).expect(200);
    for (const n of [1, 2, 3]) await request(app).post("/api/events").send(runErrorBody(n)).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.exerciseProgress[0]).toMatchObject({
      id: "lesson1/a.py", displayName: "a.py", isProject: false,
      passed: 0, stuck: 1, unreviewed: 0,
      total: 4, passRate: 0,   // 花名册 4 人为分母（决策 #20）
    });
    expect(summary.body.trend[0]).toMatchObject({ runs: 0, errors: 3 });
    expect(summary.body.students[0].status).toBe("red");   // 同 subtype ×3 未解决
    expect(summary.body.stats.needHelp).toBe(1);
  });

  it("学生抽屉详情：仅返回当天（窗口内）事件（spec §4.2）", async () => {
    const { app } = makeApp();
    // 窗口外事件（昨天）：入库但不进抽屉
    await request(app).post("/api/events").send({
      ...runErrorBody(9), id: "run:dashboardv2testOLD1", ts: Date.now() - 25 * 60 * 60_000,
    }).expect(200);
    await request(app).post("/api/events").send(runErrorBody(10)).expect(200);
    const detail = await request(app).get("/api/student/2025001").expect(200);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.events[0].rawMessage).toContain("name 'x' is not defined");
  });

  it("花名册导入触发矩阵学生侧刷新（onRosterChanged 联动）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四" }).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    // catalog 为空（测试环境无 Gitea）→ 矩阵骨架为空，但 roster 变更不报错即可
    expect(Array.isArray(summary.body.exerciseProgress)).toBe(true);
  });

  it("矩阵显示全班：花名册学生无事件也出现在 students（online=false 变暗标识，spec 决策 #15/#19）", async () => {
    const { app } = makeApp();
    await request(app).post("/api/roster").send({ text: "2025001 张三\n2025002 李四" }).expect(200);
    const summary = await request(app).get("/api/summary").expect(200);
    expect(summary.body.students).toHaveLength(2);
    expect(summary.body.students.map((s: { studentId: string }) => s.studentId).sort()).toEqual(["2025001", "2025002"]);
    expect(summary.body.students.every((s: { status: string; online: boolean }) => s.status === "green" && s.online === false)).toBe(true);
    expect(summary.body.stats.total).toBe(2);
  });
});
