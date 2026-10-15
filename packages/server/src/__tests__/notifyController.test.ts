import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";
import { handleNotify } from "../controllers/notifyController";

function seed() {
  const p = createPersistence(":memory:");
  p.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
  return p;
}

describe("POST /api/submissions/notify 处理（每次 push 一行，无练习对照）", () => {
  it("原样入库一行：files 清单不做对照直接保存", () => {
    const p = seed();
    const r = handleNotify({ persistence: p }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123",
      files: ["lesson5/a.py", "lesson5/weather-app/main.py", "notes/todo.txt"], pushedAt: 123,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, inserted: true });
    const rows = p.getSubmissionsByStudent("0001");
    expect(rows).toHaveLength(1);
    expect(rows[0].files).toEqual(["lesson5/a.py", "lesson5/weather-app/main.py", "notes/todo.txt"]);
    expect(rows[0].studentName).toBe("张三");
    expect(rows[0].submittedAt).toBe(123);
  });

  it("学号不在名册 → 400，不入库", () => {
    const p = seed();
    const r = handleNotify({ persistence: p }, {
      studentId: "9999", studentName: "路人", commitHash: "abc123", files: ["lesson5/a.py"], pushedAt: 1,
    });
    expect(r.status).toBe(400);
    expect(p.getSubmissionsByStudent("9999")).toHaveLength(0);
  });

  it("重复 notify（同 student+commit）→ 幂等 inserted=false，不重复入库", () => {
    const p = seed();
    const deps = { persistence: p };
    const body = { studentId: "0001", studentName: "张三", commitHash: "abc123", files: ["lesson5/a.py"], pushedAt: 123 };
    const r1 = handleNotify(deps, body);
    const r2 = handleNotify(deps, body);
    expect((r1.body as { inserted: boolean }).inserted).toBe(true);
    expect((r2.body as { inserted: boolean }).inserted).toBe(false);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(1);
  });

  it("缺必要字段 → 400", () => {
    const p = seed();
    const r = handleNotify({ persistence: p }, {
      studentId: "0001", studentName: "张三", files: ["lesson5/a.py"], pushedAt: 1,
    });
    expect(r.status).toBe(400);
  });

  it("纯自建文件 push 也入库（学生工作区全量归档语义）", () => {
    const p = seed();
    const r = handleNotify({ persistence: p }, {
      studentId: "0001", studentName: "张三", commitHash: "abc123", files: ["notes.txt"], pushedAt: 1,
    });
    expect(r.status).toBe(200);
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(1);
  });
});
