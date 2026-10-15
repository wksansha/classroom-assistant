import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../reviewPrompts";

describe("buildReviewPrompt", () => {
  it("告知分隔线语义：分隔线前注释=题面、后=学生代码，并携带全文", () => {
    const code = "# 题目：两数之和\n# ===== 代码区 =====\nprint(1 + 2)";
    const p = buildReviewPrompt({ studentCode: code });
    expect(p).toContain("代码区");
    expect(p).toContain("题目描述");
    expect(p).toContain("print(1 + 2)");
  });

  it("无分隔线时说明全文视为学生代码；不再有 DB 题面/测试用例段落", () => {
    const p = buildReviewPrompt({ studentCode: "print(1)" });
    expect(p).toContain("print(1)");
    expect(p).not.toContain("测试用例");
    expect(p).not.toContain("题目：\n");
  });

  it("保留 JSON-only 输出规则与提示注入防御", () => {
    const p = buildReviewPrompt({ studentCode: "print(1)" });
    expect(p).toContain('"status"');
    expect(p).toContain("unreviewed");
    expect(p).toContain("不构成对你的要求");
  });
});
