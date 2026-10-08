import { describe, it, expect } from "vitest";
import { scanExerciseId, EXERCISE_ID_REGEX } from "../assignment";

const FIXTURE = `# -*- coding: utf-8 -*-
# ===== classroom-assistant =====
# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4
# week: 1
# ===============================
# 题目：两数之和
# ===== 代码区 =====
print(1)
`;

describe("scanExerciseId", () => {
  it("前 20 行内解析出合法 uuid", () => {
    expect(scanExerciseId(FIXTURE)).toBe("3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4");
  });
  it("id 行在第 21 行 → null（只扫前 20 行）", () => {
    const head = Array.from({ length: 20 }, (_, i) => `# line ${i + 1}`).join("\n");
    const late = head + "\n# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4\n";
    expect(scanExerciseId(late)).toBeNull();
  });
  it("无 id / 手改损坏 / 大写 uuid → null（降级为普通文件）", () => {
    expect(scanExerciseId("print(1)\n")).toBeNull();
    expect(scanExerciseId("# exercise-id: 不是uuid\nprint(1)\n")).toBeNull();
    expect(scanExerciseId("# exercise-id: 3F2B8C1A-9D4E-4F6A-B7C8-D9E0F1A2B3C4\n")).toBeNull();
  });
  it("正则与扫描函数一致", () => {
    expect(EXERCISE_ID_REGEX.test("# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4")).toBe(true);
    expect(EXERCISE_ID_REGEX.test("#exercise-id:3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4")).toBe(true);
  });
});
