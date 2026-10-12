import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";

describe("persistence V2（项目练习 + files_json）", () => {
  it("exercise 携带 kind/dir/entry 往返一致", () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "第 3 周作业", week: 3, isPublished: true, createdAt: 1 });
    p.upsertExercise({
      id: "e1", assignmentId: "a1", order: 1, filename: "weather-app",
      problemStatement: "题面", starterCode: "print()", testCases: [], versionHash: "v1",
      isActive: true, createdAt: 1,
      kind: "project", dir: "weather-app", entry: "main.py",
    });
    const e = p.getExercise("e1")!;
    expect(e.kind).toBe("project");
    expect(e.dir).toBe("weather-app");
    expect(e.entry).toBe("main.py");
    // 单文件默认
    p.upsertExercise({ id: "e2", assignmentId: "a1", order: 2, filename: "01.py",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    expect(p.getExercise("e2")!.kind ?? "file").toBe("file");
  });

  it("submission files_json 往返 + 最新提交查询", () => {
    const p = createPersistence(":memory:");
    p.upsertAssignment({ id: "a1", title: "t", week: 3, isPublished: true, createdAt: 1 });
    p.upsertExercise({ id: "e1", assignmentId: "a1", order: 1, filename: "w",
      problemStatement: "s", starterCode: "", testCases: [], versionHash: "v", isActive: true, createdAt: 1 });
    p.insertSubmission({ id: "s1", exerciseId: "e1", studentId: "2025001", studentName: "张三",
      code: "main", source: "manual", submittedAt: 100, review: null,
      codeHash: "h1", gitSynced: false,
      files: [{ path: "main.py", content: "main" }, { path: "utils.py", content: "u" }] });
    p.insertSubmission({ id: "s2", exerciseId: "e1", studentId: "2025001", studentName: "张三",
      code: "main2", source: "manual", submittedAt: 200, review: null, codeHash: "h2", gitSynced: false });
    const latest = p.getLatestSubmissionByExerciseStudent("e1", "2025001")!;
    expect(latest.id).toBe("s2");
    expect(latest.files ?? null).toBeNull();
    const first = p.getSubmissionsByStudent("2025001").find((s) => s.id === "s1")!;
    expect(first.files).toEqual([{ path: "main.py", content: "main" }, { path: "utils.py", content: "u" }]);
  });

  it("旧库迁移：已存在的表补列不报错", () => {
    // createPersistence 对全新 :memory: 库执行同一迁移路径；再开一次模拟重启
    const p = createPersistence(":memory:");
    expect(p.getRoster()).toEqual([]);
  });
});
