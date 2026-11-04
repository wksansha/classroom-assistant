import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../index";
import { createPersistence } from "../persistence";
import { createStateManager } from "../stateManager";

// ── 单元：持久化锚点 ──
describe("app_meta（重置锚点持久化）", () => {
  it("set/get 往返；未设置返回 null；覆盖写生效", () => {
    const p = createPersistence(":memory:");
    expect(p.getMeta("dashboard.reset_anchor")).toBeNull();
    p.setMeta("dashboard.reset_anchor", "1000");
    expect(p.getMeta("dashboard.reset_anchor")).toBe("1000");
    p.setMeta("dashboard.reset_anchor", "2000");
    expect(p.getMeta("dashboard.reset_anchor")).toBe("2000");
  });
});

// ── 单元：stateManager 重置保留登录会话 ──
describe("stateManager.resetForNewClass", () => {
  it("清空事件/错误/活动状态；保留 machines（在线状态平滑过渡）", () => {
    const sm = createStateManager();
    sm.apply({
      studentId: "s1", studentName: "张三", classId: "3A", eventType: "run", success: false,
      errorType: "ZeroDivisionError", errorMessage: "division by zero", samples: [],
      rawMessage: "division by zero", cacheKey: "k", ts: Date.now(),
    }, { category: "运算错误", subtype: "除数为0", knowledge: "k" });
    sm.confirmLogin("s1", "张三", "3A", "m1", Date.now());
    expect(sm.listRecords()[0].consecutiveErrors).toBe(1);
    expect(sm.listRecords()[0].events).toHaveLength(1);

    sm.resetForNewClass();
    const r = sm.listRecords()[0];
    expect(r.events).toHaveLength(0);
    expect(r.lastErrorAt).toBeNull();
    expect(r.lastResolvedAt).toBeNull();
    expect(r.consecutiveErrors).toBe(0);
    expect(r.lastActivityAt).toBe(0);
    expect(r.machines.get("m1")).toBeTruthy();   // 登录会话保留
  });
});

// ── 集成：重置接口全链路（含重启回放不复活）──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-reset-"));
const dbPath = path.join(tmpDir, "reset.db");

const flatError = {
  id: "run:reset-err-0000001", ts: new Date().toISOString(), surface: "run", kind: "execution_error",
  payload: { command: "python a.py", exit_code: 1, error_type: "ZeroDivisionError", error_message: "division by zero" },
  student_id: "stu001", student_name: "张三", class_id: "3A",
};

/** 重置锚点 = Date.now()，重置后发的事件必须带新鲜 ts 才落入窗口 */
const nowIso = () => new Date().toISOString();

describe("POST /api/admin/reset（大屏课间重置）", () => {
  const first = createApp({ dbPath, staticDir: null });

  it("重置前：报错事件可见（黄色 + 聚合）", async () => {
    await request(first.app).post("/api/events").send(flatError).expect(200);
    const s = (await request(first.app).get("/api/summary").expect(200)).body;
    expect(s.students[0].status).toBe("yellow");
    expect(s.aggregates.length).toBeGreaterThan(0);
  });

  it("重置后：统计清零（绿色 + 空聚合 + 空节奏），响应带锚点", async () => {
    const r = (await request(first.app).post("/api/admin/reset").expect(200)).body;
    expect(r.ok).toBe(true);
    expect(r.anchor).toBeGreaterThan(0);
    const s = (await request(first.app).get("/api/summary").expect(200)).body;
    expect(s.students[0].status).toBe("green");
    expect(s.aggregates).toHaveLength(0);
    expect(s.trend).toHaveLength(0);
    expect(s.stats.runs).toBe(0);
  });

  it("重置后新事件正常进大屏", async () => {
    await request(first.app).post("/api/events").send({ ...flatError, id: "run:reset-err-0000002", ts: nowIso() }).expect(200);
    const s = (await request(first.app).get("/api/summary").expect(200)).body;
    expect(s.students[0].status).toBe("yellow");
    expect(s.aggregates).toHaveLength(1);
  });

  it("重启模拟：锚点持久化 → 锚点前的 run 行不回放，锚点后正常回放", async () => {
    const second = createApp({ dbPath, staticDir: null });   // 同 DB 重启：warmup 窗口含锚点
    const s = (await request(second.app).get("/api/summary").expect(200)).body;
    // 窗口内只有重置后的 err-002（errors=1）；若无锚点机制，重置前的 err-001 会被回放（errors=2）
    expect(s.trend.reduce((n: number, b: { errors: number }) => n + b.errors, 0)).toBe(1);
    expect(s.stats.runs).toBe(0);
    await request(second.app).post("/api/events").send({ ...flatSuccessReset, ts: nowIso() }).expect(200);
    const s2 = (await request(second.app).get("/api/summary").expect(200)).body;
    expect(s2.stats.runs).toBe(1);   // 锚点后的新事件正常计入
  });
});

const flatSuccessReset = {
  id: "run:reset-ok-0000001", ts: new Date().toISOString(), surface: "run", kind: "execution_success",
  payload: { command: "python a.py", exit_code: 0 },
  student_id: "stu001", student_name: "张三", class_id: "3A",
};

afterAll(() => {
  // Windows 上 SQLite WAL 文件句柄未关时 rmSync 会 EPERM：尽力清理，失败即留待系统回收
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
