import { describe, it, expect } from "vitest";
import { parseLLMResponse, mockExplain } from "../explainService/llm";

describe("parseLLMResponse：从 LLM 文本中提取三字段 JSON", () => {
  it("纯 JSON 直接解析", () => {
    const r = parseLLMResponse('{"category":"运算错误","subtype":"除数为0","knowledge":"除法运算：除数不能为 0"}');
    expect(r).toEqual({ category: "运算错误", subtype: "除数为0", knowledge: "除法运算：除数不能为 0" });
  });
  it("带前后废话的 JSON 也能提取", () => {
    const r = parseLLMResponse('好的，分析如下：\n{"category":"名称错误","subtype":"未定义变量","knowledge":"变量要先赋值再使用，检查拼写"}\n希望有帮助');
    expect(r?.subtype).toBe("未定义变量");
  });
  it("缺字段 / 非 JSON → null", () => {
    expect(parseLLMResponse("没有任何 JSON")).toBeNull();
    expect(parseLLMResponse('{"category":"运算错误"}')).toBeNull();
    expect(parseLLMResponse('{"category":"运算错误","subtype":"x","knowledge":123}')).toBeNull();
  });
});

describe("mockExplain：关键词兜底（spec §8）", () => {
  const cases: [string, string, string, string, string][] = [
    ["ZeroDivisionError", "division by zero", "运算错误", "除数为0", "除法运算：除数不能为 0"],
    ["IndentationError", "expected an indented block", "语法错误", "缩进或标点错误", "缩进规则：Python 靠缩进划分代码块"],
    ["NameError", "name 'totl' is not defined", "名称错误", "未定义变量", "变量要先赋值再使用，检查拼写"],
    ["DiagnosticError", "应为 \":\"", "语法错误", "缩进或标点错误", "缩进规则：Python 靠缩进划分代码块"],
    ["IndexError", "list index out of range", "容器访问错误", "索引或键越界", "访问前确认容器长度和键名"],
  ];
  it.each(cases)("%s → %s", (errorType, errorMessage, category, subtype, knowledge) => {
    expect(mockExplain({ errorType, errorMessage })).toEqual({ category, subtype, knowledge });
  });
  it("无法匹配 → 其他/未知错误", () => {
    expect(mockExplain({ errorType: "WeirdError", errorMessage: "???" })).toEqual({
      category: "其他", subtype: "未知错误", knowledge: "请检查代码与输入是否正确",
    });
  });
});
