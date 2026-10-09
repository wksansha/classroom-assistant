import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { Submission } from "@classroom/shared";

vi.mock("../api/assignments", () => ({
  assignmentsApi: {
    list: vi.fn(async () => [
      { id: "a1", title: "第 1 周作业", week: 1, isPublished: true, createdAt: 1, exercises: [
        { id: "e1", assignmentId: "a1", order: 1, filename: "exercise-01.py", problemStatement: "题", testCases: [], versionHash: "v", isActive: true, createdAt: 1 },
      ] },
    ]),
    roster: vi.fn(async () => [{ studentId: "0001", studentName: "张三" }]),
    submissionsByExercise: vi.fn(async (exerciseId: string) => {
      void exerciseId;
      const mk = (id: string, studentId: string, at: number, review: Submission["review"]): Submission =>
        ({ id, exerciseId: "e1", studentId, studentName: "张三", code: "print(1)", source: "auto", submittedAt: at, review });
      return [
        mk("s2", "0001", 2_000, { status: "pass", reason: "通过", reviewedAt: 2, model: "m", source: "llm" }),
        mk("s1", "0001", 1_000, { status: "fail", reason: "错", reviewedAt: 1, model: "m", source: "llm" }),
        mk("s3", "0002", 3_000, null),
      ];
    }),
    publish: vi.fn(async () => ({ ok: true })),
  },
}));

import { useAssignmentsStore, latestByStudent, cellState } from "../stores/assignments";

const sub = (review: Submission["review"]): Submission => ({
  id: "s", exerciseId: "e", studentId: "0001", studentName: "张三", code: "c",
  source: "auto", submittedAt: 1, review,
});

describe("纯函数", () => {
  it("latestByStudent：降序首见即最新（A9 矩阵取最新）", () => {
    const latest = latestByStudent([
      { ...sub(null), id: "s2", studentId: "0001", submittedAt: 2_000 },
      { ...sub(null), id: "s1", studentId: "0001", submittedAt: 1_000 },
      { ...sub(null), id: "s3", studentId: "0002", submittedAt: 3_000 },
    ]);
    expect(latest["0001"].id).toBe("s2");
    expect(latest["0002"].id).toBe("s3");
  });
  it("cellState 五态（A4/A9）", () => {
    expect(cellState(undefined)).toBe("unsubmitted");
    expect(cellState(sub(null))).toBe("reviewing");
    expect(cellState(sub({ status: "pass", reason: "r", reviewedAt: 1, model: "m", source: "llm" }))).toBe("pass");
    expect(cellState(sub({ status: "fail", reason: "r", reviewedAt: 1, model: "m", source: "llm" }))).toBe("fail");
    expect(cellState(sub({ status: "unreviewed", reason: "评审超时", reviewedAt: 1, model: "m", source: "timeout" }))).toBe("unreviewed");
  });
});

describe("assignments store", () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it("fetchAll + applyAssignmentMessage 触发对应练习刷新", async () => {
    const store = useAssignmentsStore();
    await store.fetchAll();
    expect(store.assignments).toHaveLength(1);
    expect(store.roster).toHaveLength(1);
    const { assignmentsApi } = await import("../api/assignments");
    (assignmentsApi.submissionsByExercise as ReturnType<typeof vi.fn>).mockClear();
    await store.applyAssignmentMessage({ submissionId: "s9", exerciseId: "e1", studentId: "0001", assignmentId: "a1", submittedAt: 9 });
    expect(assignmentsApi.submissionsByExercise).toHaveBeenCalledWith("e1");
    expect(store.submissionsByExercise["e1"]).toHaveLength(3);
  });
});
