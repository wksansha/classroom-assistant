import { describe, it, expect } from "vitest";
import { createPersistence } from "../persistence";

const p = createPersistence(":memory:");

const assignment = {
  id: "a-001", title: "第 1 周作业", week: 1, createdAt: 1_000,
};
const exercise = {
  id: "3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4", assignmentId: "a-001", order: 1,
  filename: "exercise-01.py", problemStatement: "两数之和", starterCode: "pass",
  testCases: [], versionHash: "abc123", isActive: true, createdAt: 1_000,
};

describe("名册", () => {
  it("覆盖式导入 → 查询 → 替换", () => {
    p.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
    expect(p.getRoster()).toEqual([{ studentId: "0001", studentName: "张三" }]);
    expect(p.getRosterEntry("0001")?.studentName).toBe("张三");
    expect(p.getRosterEntry("9999")).toBeNull();
    p.replaceRoster([{ studentId: "0002", studentName: "李四" }]);
    expect(p.getRoster()).toHaveLength(1);
    expect(p.getRosterEntry("0001")).toBeNull();
  });
});

describe("作业与练习", () => {
  it("upsert + 查询 + meta 修改", () => {
    p.upsertAssignment(assignment);
    p.updateAssignmentMeta("a-001", { title: "变量与表达式", dueAt: 1_760_000_000_000 });
    const a = p.getAssignment("a-001")!;
    expect(a.title).toBe("变量与表达式");
    expect(a.dueAt).toBe(1_760_000_000_000);
    expect(p.getAssignments()).toHaveLength(1);
  });

  it("练习 upsert / findByPath / deactivateMissing", () => {
    p.upsertExercise(exercise);
    expect(p.getExercises("a-001")[0].versionHash).toBe("abc123");
    expect(p.findExerciseByPath(1, "exercise-01.py")?.id).toBe(exercise.id);
    expect(p.findExerciseByPath(2, "exercise-01.py")).toBeNull();
    p.deactivateMissingExercises(1, []);  // main 上该周文件全删
    expect(p.getExercise(exercise.id)?.isActive).toBe(false);
    p.upsertExercise({ ...exercise, isActive: true, problemStatement: "改题" });
    expect(p.getExercise(exercise.id)?.problemStatement).toBe("改题");
    expect(p.getExercise(exercise.id)?.isActive).toBe(true);
  });
});

describe("提交轻量索引（submissions 表，spec §6.2）", () => {
  it("notify 行入库 → 幂等 → 评审回填 → 查询统一", () => {
    p.replaceRoster([{ studentId: "0001", studentName: "张三" }]);
    p.upsertExercise({ ...exercise, isActive: true });
    const row = { id: "n-001", exerciseId: exercise.id, studentId: "0001", studentName: "张三",
      commitHash: "c1", filesJson: JSON.stringify(["week-01/exercise-01.py"]), submittedAt: 3_000 };
    expect(p.insertNotifyRow(row)).toBe(true);
    expect(p.insertNotifyRow(row)).toBe(false);      // 同 (exercise, student, commit) 幂等忽略

    const subs = p.getSubmissionsByExercise(exercise.id);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      id: "n-001", exerciseId: exercise.id, studentId: "0001", studentName: "张三",
      commitHash: "c1", files: ["week-01/exercise-01.py"], submittedAt: 3_000, review: null,
    });
    expect(p.getSubmissionsByStudent("0001")).toHaveLength(1);
    expect(p.getLatestSubmissionByExerciseStudent(exercise.id, "0001")?.id).toBe("n-001");
    expect(p.getLatestSubmissionByExerciseStudent(exercise.id, "9999")).toBeNull();

    p.updateNotifyReview("n-001", {
      status: "pass", reason: "代码通过所有测试用例", reviewedAt: 3_100, model: "m", source: "llm",
    });
    expect(p.getSubmissionsByExercise(exercise.id)[0].review?.status).toBe("pass");
    p.updateNotifyReview("n-001", {
      status: "unreviewed", reason: "评审超时", reviewedAt: 3_200, model: "m", source: "timeout",
    });
    expect(p.getSubmissionsByExercise(exercise.id)[0].review?.status).toBe("unreviewed");
  });
});

describe("评审缓存", () => {
  it("save → get 往返（ReviewResult 完整序列化）", () => {
    const review = { status: "fail" as const, reason: "未处理空列表", reviewedAt: 5_000, model: "m", source: "llm" as const };
    p.saveReviewCache({ cacheKey: "k1", exerciseId: exercise.id, versionHash: "abc123", review });
    // reviewedAt 不入库、恒返回占位 0（T3 缓存命中时重打时间戳），其余字段完整往返
    expect(p.getCachedReview("k1")).toEqual({ ...review, reviewedAt: 0 });
    expect(p.getCachedReview("k2")).toBeNull();
  });
});
