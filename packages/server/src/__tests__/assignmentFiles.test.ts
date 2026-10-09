import { describe, it, expect } from "vitest";
import { parseExerciseFile, injectExerciseId, computeExerciseVersionHash } from "../assignmentFiles";
import { scanExerciseId } from "@classroom/shared";

const EXERCISE_FILE_FIXTURE = `# -*- coding: utf-8 -*-
# ===== classroom-assistant =====
# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4
# week: 1
# ===============================
# 题目：两数之和
# 描述：读取两个整数，输出它们的和。
# ===== 代码区 =====
a = int(input())
b = int(input())
print(a + b)
`;

const TEACHER_BARE_FIXTURE = `# 题目：两数之和
# 描述：读取两个整数，输出它们的和。
# ===== 代码区 =====
a = int(input())
b = int(input())
print(a + b)
`;

describe("parseExerciseFile（spec §2.2 提取规则）", () => {
  it("标准文件：id + week + 题目 + starterCode", () => {
    const r = parseExerciseFile(EXERCISE_FILE_FIXTURE);
    expect(r.exerciseId).toBe("3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4");
    expect(r.week).toBe(1);
    expect(r.problemStatement).toBe("题目：两数之和\n描述：读取两个整数，输出它们的和。");
    expect(r.starterCode).toBe("a = int(input())\nb = int(input())\nprint(a + b)");
  });
  it("教师裸文件（无元数据块）：id/week 为 null，题目照常提取", () => {
    const r = parseExerciseFile(TEACHER_BARE_FIXTURE);
    expect(r.exerciseId).toBeNull();
    expect(r.week).toBeNull();
    expect(r.problemStatement).toBe("题目：两数之和\n描述：读取两个整数，输出它们的和。");
    expect(r.starterCode).toBe("a = int(input())\nb = int(input())\nprint(a + b)");
  });
  it("无代码区标记 → 全文为题目描述，starterCode 为空", () => {
    const r = parseExerciseFile("# 题目：只有描述\n# 第二行");
    expect(r.problemStatement).toBe("题目：只有描述\n第二行");
    expect(r.starterCode).toBe("");
  });
});

describe("injectExerciseId（A28：ID 以调用方为准，幂等可重做）", () => {
  it("裸文件 → 前插完整元数据块，可被 scanExerciseId 解析", () => {
    const injected = injectExerciseId(TEACHER_BARE_FIXTURE, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 2);
    expect(scanExerciseId(injected)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const r = parseExerciseFile(injected);
    expect(r.week).toBe(2);
    expect(r.problemStatement).toBe("题目：两数之和\n描述：读取两个整数，输出它们的和。");
    expect(r.starterCode).toBe("a = int(input())\nb = int(input())\nprint(a + b)");
  });
  it("已有元数据块但缺 id → 插到块内，不破坏原有内容", () => {
    const noId = EXERCISE_FILE_FIXTURE.replace(/# exercise-id: .*\n/, "");
    const injected = injectExerciseId(noId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", 1);
    expect(scanExerciseId(injected)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(parseExerciseFile(injected).problemStatement).toContain("两数之和");
  });
});

describe("computeExerciseVersionHash（A6）", () => {
  it("稳定且随题目内容变化", () => {
    const h1 = computeExerciseVersionHash("题A", [], "");
    expect(h1).toBe(computeExerciseVersionHash("题A", [], ""));
    expect(h1).toHaveLength(16);
    expect(computeExerciseVersionHash("题B", [], "")).not.toBe(h1);
    expect(computeExerciseVersionHash("题A", [], "code")).not.toBe(h1);
  });
});
