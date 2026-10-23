import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index";

function appWith(adminPassword?: string) {
  return createApp({ dbPath: ":memory:", staticDir: null, llmConfig: null, adminPassword }).app;
}

describe("管理面鉴权（ADMIN_PASSWORD，spec 2026-10-23）", () => {
  it("未配置密码：管理接口不设防（本地开发兼容），session 报告 adminProtected=false", async () => {
    const app = appWith();
    await request(app).get("/api/admin/session").expect(200, { adminProtected: false });
    await request(app).get("/api/roster").expect(200, []);
  });

  it("已配置：session 无头/错头 401，对头 200", async () => {
    const app = appWith("s3cret");
    await request(app).get("/api/admin/session").expect(401);
    await request(app).get("/api/admin/session").set("X-Admin-Token", "wrong").expect(401);
    await request(app).get("/api/admin/session").set("X-Admin-Token", "s3cret")
      .expect(200, { adminProtected: true, ok: true });
  });

  it("已配置：/api/roster 全路由要求 X-Admin-Token（增删改查全被罩住）", async () => {
    const app = appWith("s3cret");
    await request(app).get("/api/roster").expect(401);
    await request(app).post("/api/roster").send({ text: "0001 张三" }).expect(401);
    await request(app).post("/api/roster/entry").send({ studentId: "0001", studentName: "张三" }).expect(401);
    await request(app).patch("/api/roster/entry/0001").send({ studentName: "李四" }).expect(401);
    await request(app).delete("/api/roster/entry/0001").expect(401);
    await request(app).post("/api/roster/entry/0001/purge").expect(401);

    await request(app).get("/api/roster").set("X-Admin-Token", "s3cret").expect(200, []);
    await request(app).post("/api/roster/entry").set("X-Admin-Token", "s3cret")
      .send({ studentId: "0001", studentName: "张三" }).expect(200, { ok: true });
    await request(app).get("/api/roster").set("X-Admin-Token", "s3cret").expect(200, [
      { studentId: "0001", studentName: "张三" },
    ]);
  });

  it("学生端点不受管理门禁影响（identity/validate 照常可达）", async () => {
    const app = appWith("s3cret");
    await request(app).post("/api/identity/validate").send({ studentId: "0001", studentName: "张三" })
      .expect(400, { code: "roster_empty", message: "教师尚未导入名册，请联系教员后再试" });
  });
});
