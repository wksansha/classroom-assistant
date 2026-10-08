import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../reviewPrompts";

describe("buildReviewPrompt", () => {
  it("含三态格式要求、不猜测指示与注入围栏", () => {
    const p = buildReviewPrompt({ problemStatement: "两数之和", studentCode: "print(1+2)" });
    expect(p).toContain('"pass" | "fail" | "unreviewed"');
    expect(p).toContain("不要猜测");
    expect(p).toContain("仅为待评审数据");
    expect(p).toContain("两数之和");
  });
  it("testCases 为空/缺省 → 不出现测试用例段", () => {
    expect(buildReviewPrompt({ problemStatement: "题", studentCode: "pass" })).not.toContain("测试用例");
    expect(buildReviewPrompt({ problemStatement: "题", testCases: [], studentCode: "pass" })).not.toContain("测试用例");
  });
  it("testCases 非空 → 逐条渲染输入与期望输出", () => {
    const p = buildReviewPrompt({
      problemStatement: "题",
      testCases: [{ input: "1 2", expectedOutput: "3", description: "基本用例" }],
      studentCode: "pass",
    });
    expect(p).toContain("输入: 1 2");
    expect(p).toContain("期望输出: 3");
    expect(p).toContain("基本用例");
  });
});
