import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SubmissionMatrix from "../components/SubmissionMatrix.vue";
import type { Exercise, RosterEntry, Submission } from "@classroom/shared";

const roster: RosterEntry[] = [
  { studentId: "0001", studentName: "张三" },
  { studentId: "0002", studentName: "李四" },
];
const exercises: Exercise[] = [
  { id: "e1", assignmentId: "a1", order: 1, filename: "exercise-01.py", problemStatement: "题", testCases: [], versionHash: "v", isActive: true, createdAt: 1 },
];
const sub = (review: Submission["review"], studentId = "0001"): Submission => ({
  id: "s", exerciseId: "e1", studentId, studentName: "张三", code: "print(1)", source: "auto", submittedAt: 1, review,
});

describe("SubmissionMatrix（A9/A24/A30）", () => {
  it("五态格子渲染 + 悬停 reason（A30）", () => {
    const matrix = {
      e1: {
        "0001": sub({ status: "fail", reason: "未处理空列表导致 IndexError", reviewedAt: 1, model: "m", source: "llm" }),
        "0002": sub(null, "0002"),
      },
    };
    const w = mount(SubmissionMatrix, { props: { roster, exercises, matrix } });
    const cells = w.findAll("td.cell");
    expect(cells[0].classes()).toContain("fail");
    expect(cells[0].attributes("title")).toContain("未处理空列表导致 IndexError");
    expect(cells[0].attributes("title")).toContain("llm");
    expect(cells[1].classes()).toContain("reviewing");
  });
  it("未提交 = unsubmitted；点击格子 emit select", async () => {
    const matrix = { e1: { "0001": sub({ status: "pass", reason: "通过", reviewedAt: 1, model: "m", source: "llm" }) } };
    const w = mount(SubmissionMatrix, { props: { roster, exercises, matrix } });
    expect(w.findAll("td.cell")[1].classes()).toContain("unsubmitted");
    await w.findAll("td.cell")[0].trigger("click");
    expect(w.emitted("select")![0]).toEqual([{ exerciseId: "e1", studentId: "0001" }]);
  });
  it("行 = 名册全员（A16），列头显示练习文件名", () => {
    const w = mount(SubmissionMatrix, { props: { roster, exercises, matrix: { e1: {} } } });
    expect(w.text()).toContain("0001");
    expect(w.text()).toContain("李四");
    expect(w.text()).toContain("exercise-01.py");
  });
});
