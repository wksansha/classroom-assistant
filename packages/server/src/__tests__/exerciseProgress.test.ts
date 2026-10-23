import { describe, it, expect } from "vitest";
import { createExerciseProgressTracker } from "../exerciseProgress";

const NOW = Date.parse("2026-10-23T08:00:00.000Z");
const TODAY_START = NOW - 8 * 60 * 60_000;   // 模拟当天起点（昨天 = 更早）

describe("ExerciseProgressTracker（当天涌现，spec dashboard-v2 §5.3 / 决策 #18）", () => {
  it("事件生格：评审 fail → stuck=1；pass 翻转 latest", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", NOW);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0 },
    ]);
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW + 1000);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 1, stuck: 0, unreviewed: 0 },
    ]);
  });

  it("unreviewed → 待评审；pass/fail 强信号不覆盖", () => {
    const t = createExerciseProgressTracker();
    t.applyUnreviewed("s1", "张三", "l1/a.py", NOW);
    expect(t.list(TODAY_START)[0]).toMatchObject({ unreviewed: 1 });
    t.applyReview("s2", "李四", "l1/a.py", "pass", NOW);
    t.applyUnreviewed("s2", "李四", "l1/a.py", NOW + 1000);   // pass 不覆盖
    t.applyReview("s3", "王五", "l1/a.py", "fail", NOW);
    t.applyUnreviewed("s3", "王五", "l1/a.py", NOW + 1000);   // fail 不覆盖
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 1, stuck: 1, unreviewed: 1 });
  });

  it("run 失败 → fail（强负面信号）", () => {
    const t = createExerciseProgressTracker();
    t.applyRunFailure("s1", "张三", "l1/a.py", NOW);
    expect(t.list(TODAY_START)[0]).toMatchObject({ stuck: 1 });
  });

  it("list 当天过滤：昨天格子的学生不计、昨天活跃的题不出现", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", TODAY_START - 1000);   // 昨天
    t.applyReview("s2", "李四", "l1/b.py", "fail", NOW);                  // 今天
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/b.py", displayName: "b.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0 },
    ]);
    // 同题：昨天 fail 的 s1 不计入今天统计
    t.applyReview("s3", "王五", "l1/a.py", "pass", NOW + 2000);
    expect(t.list(TODAY_START).find((i) => i.id === "l1/a.py")).toMatchObject({ passed: 1, stuck: 0 });
  });

  it("排序：三态总和降序（最活跃在前）", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW);
    t.applyReview("s2", "李四", "l2/b.py", "pass", NOW);
    t.applyReview("s3", "王五", "l2/b.py", "pass", NOW);
    const items = t.list(TODAY_START);
    expect(items[0].id).toBe("l2/b.py");   // 2 人 > 1 人
  });

  it("Windows 反斜杠路径取 basename；输出不含学生名单", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "lesson5\\weather_app.py", "pass", NOW);
    const item = t.list(TODAY_START)[0];
    expect(item.displayName).toBe("weather_app.py");
    expect(item).not.toHaveProperty("students");
    expect(Object.keys(item).sort()).toEqual(["displayName", "id", "isProject", "passed", "stuck", "unreviewed"]);
  });

  it("warmUpFromReviews：仅回放当天行（unreviewed 不覆盖 pass/fail）", () => {
    const t = createExerciseProgressTracker();
    t.warmUpFromReviews([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START - 500 },   // 昨天 → 忽略
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "pass", ts: TODAY_START + 100 },
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START + 200 },   // 不覆盖 pass
      { studentId: "s3", studentName: "王五", filePath: "l1/b.py", status: "unreviewed", ts: TODAY_START + 300 },
    ]);
    const items = t.list(TODAY_START);
    expect(items.find((i) => i.id === "l1/a.py")).toMatchObject({ passed: 1, unreviewed: 0 });
    expect(items.find((i) => i.id === "l1/b.py")).toMatchObject({ unreviewed: 1 });
  });
});
