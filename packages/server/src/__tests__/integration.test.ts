import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index";

function app() {
  return createApp({ dbPath: ":memory:", staticDir: null }).app;
}

const flatError = {
  student_id: "stu001", student_name: "张三", class_id: "3A",
  timestamp: new Date().toISOString(), event_type: "run",
  raw_message: "division by zero", error_type: "ZeroDivisionError",
  error_message: "division by zero", exit_code: 1,
};
const flatSuccess = {
  student_id: "stu001", student_name: "张三", class_id: "3A",
  timestamp: new Date().toISOString(), event_type: "run",
  raw_message: "run success", error_type: "RunSuccess", error_message: "", exit_code: 0,
};

describe("POST /api/events 主流程（测试环境无 LLM_API_KEY → mock 兜底）", () => {
  it("报错上报 → 200；summary 黄色；events 落库带三字段（run 静态映射）", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatError).expect(200, { ok: true });
    const summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.students).toHaveLength(1);
    expect(summary.students[0].status).toBe("yellow");
    const events = (await request(a).get("/api/events").expect(200)).body;
    expect(events[0].category).toBe("运算错误");
    expect(events[0].subtype).toBe("除数为0");
  });

  it("runSuccess → 200，不产生解释（category=运行成功），学生绿色", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatSuccess).expect(200);
    const summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.students[0].status).toBe("green");
    const events = (await request(a).get("/api/events").expect(200)).body;
    expect(events[0].category).toBe("运行成功");
    expect(events[0].subtype).toBeNull();
  });

  it("无效 body → 400", async () => {
    await request(app()).post("/api/events").send({ foo: 1 }).expect(400);
  });
});

describe("GET /api/student/:id", () => {
  it("上报后可查详情（事件倒序）；未知名 404", async () => {
    const a = app();
    await request(a).post("/api/events").send(flatError);
    const d = (await request(a).get("/api/student/stu001").expect(200)).body;
    expect(d.events[0].subtype).toBe("除数为0");
    await request(a).get("/api/student/nope").expect(404);
  });
});

describe("POST /api/suggestions/ack", () => {
  it("ack 后 summary 中该建议标记已处理；缺 id 400", async () => {
    const a = app();
    // 单人单错 → 该 subtype 占比 100% ≥40% → class-review
    await request(a).post("/api/events").send(flatError);
    let summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.suggestions.some((s: any) => s.id === "class-review:除数为0")).toBe(true);
    await request(a).post("/api/suggestions/ack").send({ id: "class-review:除数为0" }).expect(200, { ok: true });
    summary = (await request(a).get("/api/summary").expect(200)).body;
    expect(summary.suggestions.find((s: any) => s.id === "class-review:除数为0").acked).toBe(true);
    await request(a).post("/api/suggestions/ack").send({}).expect(400);
  });
});
