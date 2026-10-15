import { describe, it, expect } from "vitest";
import { createPersistence, type Persistence } from "../persistence";
import { handleNotify } from "../controllers/notifyController";

// seed 辅助：往 :memory: 库插 roster + assignment(week_dir='lesson5') + 两个 exercise
// exercise1: kind='file', filename='a.py'；exercise2: kind='project', filename='weather-app'
function seed(): Persistence {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
  p.upsertAssignment({ id: "a-lesson5", title: "lesson5", week: 5, createdAt: 1_000 });
  p.setAssignmentWeekDir("a-lesson5", "lesson5");
  p.upsertExercise({
    id: "ex-a", assignmentId: "a-lesson5", order: 1, filename: "a.py", problemStatement: "单文件题",
    testCases: [], versionHash: "v1", isActive: true, createdAt: 1_000, kind: "file",
  });
  p.upsertExercise({
    id: "ex-weather", assignmentId: "a-lesson5", order: 2, filename: "weather-app", problemStatement: "项目题",
    testCases: [], versionHash: "v1", isActive: true, createdAt: 1_000, kind: "project",
  });
  return p;
}

describe("POST /api/submissions/notify 处理", () => {
  it("文件清单对照 exercises → 每命中练习一行入库 + SSE 逐练习广播", () => {
    const p = seed();
    const events: unknown[] = [];
    const r = handleNotify({ persistence: p, publish: (m) => events.push(m) }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123",
      files: ["lesson5/a.py", "lesson5/weather-app/main.py"], pushedAt: 123,
    });
    expect(r.status).toBe(200);
    expect((r.body as { exercises: number }).exercises).toBe(2);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(2);   // 每命中练习一行
    expect(events).toHaveLength(2);                              // 逐练习两条
    const ids = events.map((m) => (m as { data: { exerciseId: string } }).data.exerciseId).sort();
    expect(ids).toEqual(["ex-a", "ex-weather"]);
  });
  it("学号不在名册 → 400", () => {
    const p = seed();
    const r = handleNotify({ persistence: p, publish: () => {} }, {
      studentId: "9999", studentName: "路人", commitHash: "abc123", files: ["lesson5/a.py"], pushedAt: 1,
    });
    expect(r.status).toBe(400);
    expect(p.getSubmissionsByStudent("9999")).toHaveLength(0);
  });
  it("重复 notify（同 commit 同练习）→ 幂等，不重复入库、不重复广播", () => {
    const p = seed();
    const events: unknown[] = [];
    const deps = { persistence: p, publish: (m: unknown) => events.push(m) };
    const body = { studentId: "0001", studentName: "张三", commitHash: "abc123", files: ["lesson5/a.py"], pushedAt: 123 };
    const r1 = handleNotify(deps, body);
    const r2 = handleNotify(deps, body);
    expect((r1.body as { exercises: number }).exercises).toBe(1);
    expect((r2.body as { exercises: number }).exercises).toBe(0);   // 冲突忽略
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(1);      // 1 行
    expect(events).toHaveLength(1);                                 // 1 条
  });
  it("缺必要字段 → 400", () => {
    const p = seed();
    const r = handleNotify({ persistence: p, publish: () => {} }, {
      studentId: "0001", studentName: "张三", files: ["lesson5/a.py"], pushedAt: 1,
    });
    expect(r.status).toBe(400);
  });
  it("未命中任何练习（纯自建文件）→ 200 且 0 行 0 广播", () => {
    const p = seed();
    const events: unknown[] = [];
    const r = handleNotify({ persistence: p, publish: (m) => events.push(m) }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123", files: ["notes.txt"], pushedAt: 1,
    });
    expect(r.status).toBe(200);
    expect((r.body as { exercises: number }).exercises).toBe(0);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  it("索引行形状：commitHash + files 路径清单 + review 初始 null", () => {
    const p = seed();
    handleNotify({ persistence: p, publish: () => {} }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123", files: ["lesson5/a.py"], pushedAt: 123,
    });
    const row = p.getSubmissionsByStudent("0001")[0];
    expect(row.commitHash).toBe("abc123");
    expect(row.files).toEqual(["lesson5/a.py"]);
    expect(row.review).toBeNull();
    p.updateNotifyReview(row.id, { status: "pass", reason: "通过", reviewedAt: 200, model: "m", source: "llm" });
    expect(p.getSubmissionsByStudent("0001")[0].review).toMatchObject({ status: "pass" });
  });
});
