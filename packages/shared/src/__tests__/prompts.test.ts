import { describe, it, expect } from "vitest";
import { buildExplainPrompt } from "../prompts";

const base = { errorType: "ZeroDivisionError", errorMessage: "division by zero" };

describe("buildExplainPrompt（spec §5 模板，learner 不上报代码时自动降级）", () => {
  it("基础字段：8 分类约束 + 输出 JSON 格式 + 错误信息", () => {
    const p = buildExplainPrompt(base);
    expect(p).toContain('{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}');
    expect(p).toContain("语法错误 / 名称错误 / 类型错误 / 运算错误 / 容器访问错误 / 属性导入错误 / 文件权限错误 / 其他");
    expect(p).toContain("错误类型：ZeroDivisionError");
    expect(p).toContain("错误信息：division by zero");
  });
  it("无代码上下文时降级：不含代码段", () => {
    const p = buildExplainPrompt(base);
    expect(p).not.toContain("出错代码行");
    expect(p).not.toContain("完整代码");
    expect(p).not.toContain("错误代码片段");
  });
  it("仅有 codeLine：含出错代码行，不含完整代码", () => {
    const p = buildExplainPrompt({ ...base, codeLine: "print(a / b)" });
    expect(p).toContain("出错代码行：print(a / b)");
    expect(p).not.toContain("完整代码");
  });
  it("有 fullCode：含完整代码段", () => {
    const p = buildExplainPrompt({ ...base, codeLine: "print(a / b)", fullCode: "a = 0\nprint(a / b)" });
    expect(p).toContain("完整代码：");
    expect(p).toContain("a = 0");
  });
  it("有 codeSnippet：优先使用片段，不含完整代码", () => {
    const snippet = "def divide(a, b):\n    return a / b\n\nprint(divide(10, 0))";
    const p = buildExplainPrompt({ ...base, codeSnippet: snippet });
    expect(p).toContain("错误代码片段：");
    expect(p).toContain("def divide(a, b):");
    expect(p).toContain("print(divide(10, 0))");
    expect(p).not.toContain("出错代码行");
    expect(p).not.toContain("完整代码");
  });
  it("同时有 codeSnippet 和 fullCode：只含片段（优先级更高）", () => {
    const snippet = "def divide(a, b):\n    return a / b";
    const full = "def divide(a, b):\n    return a / b\n\ndef main():\n    print(divide(10, 0))\n\nmain()";
    const p = buildExplainPrompt({ ...base, codeSnippet: snippet, fullCode: full });
    expect(p).toContain("错误代码片段：");
    expect(p).toContain("def divide(a, b):");
    expect(p).not.toContain("完整代码：");
    expect(p).not.toContain("def main():");
  });
});
