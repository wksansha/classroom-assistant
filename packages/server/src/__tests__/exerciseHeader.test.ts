import { describe, expect, it } from "vitest";
import { parseExerciseHeader } from "../exerciseHeader";

describe("parseExerciseHeader（题面头解析，spec 2026-11-09 §3）", () => {
  it("分隔线 + [任务X] 三任务：题名清洗 + 任务按序成清单", () => {
    const code = [
      "# 练习1：九九乘法表（week-02）",
      "# [任务一] 用 for 循环打印 1~9 每一行的乘法口诀",
      "# [任务二] 每行输出格式为 j x i = 积",
      "# [任务三] 只输出对角线（i == j）的乘法项",
      "# ===== 代码区 =====",
      "for i in range(1, 10):",
      "    pass",
    ].join("\n");
    const h = parseExerciseHeader(code);
    expect(h.title).toBe("练习1：九九乘法表");
    expect(h.tasks).toEqual(["任务一", "任务二", "任务三"]);
  });

  it("无分隔线 + 第X部分分节行 + docstring 题名（L15/L21 存量格式）", () => {
    const code = [
      "# -*- coding: utf-8 -*-",
      '"""',
      "练习十：推导式与排序（对应 L15 推导式与数据整理综合实践）",
      "",
      "任务：逐部分填写代码。",
      '"""',
      "# ---------- 第一部分：基本列表推导式 ----------",
      "# 提示：...",
      "# 在此填写代码：",
      "",
      "# ---------- 第二部分：条件推导式 ----------",
      "# 在此填写代码：",
      "",
      "# ------ 第三部分:sorted() 与 sort() 的区别 ------",
      "# 在此填写代码：",
    ].join("\n");
    const h = parseExerciseHeader(code);
    expect(h.title).toBe("练习十：推导式与排序");
    expect(h.tasks).toEqual(["基本列表推导式", "条件推导式", "sorted() 与 sort() 的区别"]);
  });

  it("现有单任务格式（分隔线+普通注释）→ tasks 空、title 行为不变", () => {
    const code = [
      "# 练习3：成绩等级判断（week-03）",
      "# 要求：五档完整",
      "# ===== 代码区 =====",
      "def grade(score):",
      "    pass",
    ].join("\n");
    const h = parseExerciseHeader(code);
    expect(h.title).toBe("练习3：成绩等级判断");
    expect(h.tasks).toEqual([]);
  });

  it("单个任务声明 = 单任务题（阈值 ≥2）", () => {
    const code = [
      "# 练习1：问候函数",
      "# [任务一] 实现 greet",
      "# ===== 代码区 =====",
      "pass",
    ].join("\n");
    expect(parseExerciseHeader(code).tasks).toEqual([]);
  });

  it("题名优先级：注释中的练习N匹配 > docstring 练习N > 首条非空注释 > docstring 首行", () => {
    const byDoc = parseExerciseHeader(['"""', "推导式练习", '"""', "x = 1"].join("\n"));
    expect(byDoc.title).toBe("推导式练习");
    const byComment = parseExerciseHeader([
      "# -*- coding: utf-8 -*-",
      "# 普通说明行",
      '"""',
      "docstring 标题",
      '"""',
      "x = 1",
    ].join("\n"));
    expect(byComment.title).toBe("普通说明行");   // 编码声明跳过，首条非空注释兜底
  });

  it("学生删头（无注释无 docstring）→ title undefined、tasks 空", () => {
    const h = parseExerciseHeader("print(1)\nprint(2)");
    expect(h.title).toBeUndefined();
    expect(h.tasks).toEqual([]);
  });

  it("有分隔线时任务只认分隔线前（代码区里的分节注释不算任务）", () => {
    const code = [
      "# 练习2：排序",
      "# [任务一] sorted 用法",
      "# [任务二] sort 用法",
      "# ===== 代码区 =====",
      "# ---------- 第三部分：条件推导式 ----------",
      "pass",
    ].join("\n");
    const h = parseExerciseHeader(code);
    expect(h.tasks).toEqual(["任务一", "任务二"]);   // 分节行在分隔线后 → 不入清单
  });

  it("重复任务名去重（首现生效）", () => {
    const code = [
      "# [任务一] a",
      "# [任务二] b",
      "# [任务二] b 重复",
      "# [任务三] c",
      "x = 1",
    ].join("\n");
    expect(parseExerciseHeader(code).tasks).toEqual(["任务一", "任务二", "任务三"]);
  });
});
