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

  it("fail 分类清单：prompt 携带六类固定分类并标注仅 fail 必填", () => {
    const p = buildReviewPrompt({ studentCode: "print(1)" });
    expect(p).toContain("边界未处理");
    expect(p).toContain("需求理解偏差");
    expect(p).toContain("仅在 status=fail 时必填");
    const multi = buildReviewPrompt({ studentCode: "pass", tasks: ["任务一", "任务二"] });
    expect(multi).toContain("边界未处理");
  });

  it("TODO 分步任务规则：pass 占位属未开始而非错误，只评判已实现部分", () => {
    const p = buildReviewPrompt({ studentCode: "# TODO 1：筛选\nprint(1)\n# TODO 2：导入\npass" });
    expect(p).toContain("分步任务清单");
    expect(p).toContain("未开始而非错误");
    expect(p).toContain("已实现部分");
  });
});
