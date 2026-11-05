export interface ExplainInput {
  errorType: string;
  errorMessage: string;
  codeLine?: string;
  fullCode?: string;
  codeSnippet?: string;
}

export function buildExplainPrompt(input: ExplainInput): string {
  const lines: string[] = [
    "你是一位 Python 教学助手。请分析学员的错误，输出 JSON：",
    '{"category":"<分类>","subtype":"<细分类型，6字以内>","knowledge":"<知识点句>"}',
    "",
    "要求：",
    "- category 用简短中文标签按错误性质归类（如 语法错误 / 名称错误 / 类型错误 / 运算错误 / 逻辑错误 等），由你判断；禁止输出「未知错误」",
    "- knowledge 面向初学者，说清 (1) 是什么知识点的问题 (2) 学员最可能哪里没懂，20 字左右，不要堆术语；措辞统一用「学员」，禁止出现「学生」",
    '- subtype 是这个错误的具体类型标签，例如"缺少冒号""意外缩进""除数为0""未定义变量"；信息不足时用错误信息原文的关键短语，禁止输出「未知错误」',
    "- 只输出 JSON，不要解释",
    "",
    `错误类型：${input.errorType}`,
    `错误信息：${input.errorMessage}`,
  ];
  if (input.codeSnippet) lines.push(`错误代码片段：\n${input.codeSnippet}`);
  else if (input.fullCode) lines.push(`完整代码：\n${input.fullCode}`);
  else if (input.codeLine) lines.push(`出错代码行：${input.codeLine}`);
  return lines.join("\n");
}
