import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SubmissionDetailDrawer from "../components/SubmissionDetailDrawer.vue";
import type { Submission } from "@classroom/shared";

const submission: Submission = {
  id: "s1", exerciseId: "e1", studentId: "0001", studentName: "张三",
  code: "print('hello')\n", source: "auto", submittedAt: 1_700_000_000_000,
  review: { status: "fail", reason: "未处理空列表导致 IndexError", reviewedAt: 1, model: "test-model", source: "llm" },
};

describe("SubmissionDetailDrawer（A15/A30）", () => {
  it("代码 + 评审详情 + git 分支提示 + 历史列表", () => {
    const w = mount(SubmissionDetailDrawer, {
      props: { submission, history: [submission, { ...submission, id: "s0" }] },
    });
    expect(w.text()).toContain("print('hello')");
    expect(w.text()).toContain("未处理空列表导致 IndexError");
    expect(w.text()).toContain("test-model");
    expect(w.text()).toContain("student-0001");          // git 分支提示
    expect(w.text()).toContain("自动提交");              // source=auto 文案
  });
  it("点击历史条目 emit pick；关闭按钮 emit close", async () => {
    const w = mount(SubmissionDetailDrawer, {
      props: { submission, history: [submission, { ...submission, id: "s0" }] },
    });
    await w.findAll(".history-item")[1].trigger("click");
    expect(w.emitted("pick")![0]).toEqual(["s0"]);
    await w.find("button.close").trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });
  it("submission=null 不渲染内容", () => {
    const w = mount(SubmissionDetailDrawer, { props: { submission: null, history: [] } });
    expect(w.find(".drawer").exists()).toBe(false);
  });
});
