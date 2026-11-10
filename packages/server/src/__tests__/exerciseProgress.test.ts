import { describe, it, expect } from "vitest";
import { createExerciseProgressTracker } from "../exerciseProgress";

const NOW = Date.parse("2026-10-23T08:00:00.000Z");
const TODAY_START = NOW - 8 * 60 * 60_000;   // 模拟当天起点（昨天 = 更早）

describe("ExerciseProgressTracker（当天涌现，spec dashboard-v2 §5.3 / 决策 #18）", () => {
  it("事件生格：评审 fail → stuck=1；pass 翻转 latest", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", NOW);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0, firstTs: NOW, latestTs: NOW, title: "a.py" },
    ]);
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW + 1000);
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/a.py", displayName: "a.py", isProject: false, passed: 1, stuck: 0, unreviewed: 0, firstTs: NOW, latestTs: NOW + 1000, title: "a.py" },
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

  it("降级通过：LLM 无结论 unreviewed + 当前题 run 成功 → 计通过（成功先到/后到皆可）", () => {
    // 成功先到：run 成功后再收到 LLM 挂的 unreviewed
    const t = createExerciseProgressTracker();
    t.applyRunSuccess("s1", "张三", "l1/a.py", NOW);
    t.applyUnreviewed("s1", "张三", "l1/a.py", NOW + 1000);
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 1, unreviewed: 0 });
    // 成功后到：unreviewed 降级在先，run 成功随后补升级
    const t2 = createExerciseProgressTracker();
    t2.applyUnreviewed("s1", "张三", "l1/a.py", NOW);
    t2.applyRunSuccess("s1", "张三", "l1/a.py", NOW + 1000);
    expect(t2.list(TODAY_START)[0]).toMatchObject({ passed: 1, unreviewed: 0 });
  });

  it("run 成功但从未提交评审 → 仍 unreviewed（编码中，不虚报通过）", () => {
    const t = createExerciseProgressTracker();
    t.applyRunSuccess("s1", "张三", "l1/a.py", NOW);
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 0, unreviewed: 1 });
  });

  it("强信号不受降级影响：降级通过后评审 fail 照常打回", () => {
    const t = createExerciseProgressTracker();
    t.applyRunSuccess("s1", "张三", "l1/a.py", NOW);
    t.applyUnreviewed("s1", "张三", "l1/a.py", NOW + 1000);   // 降级通过
    t.applyReview("s1", "张三", "l1/a.py", "fail", NOW + 2000);   // LLM 恢复后真实评审打回
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 0, stuck: 1 });
  });

  it("warmUpFromReviews：先回放 run 成功明细 → unreviewed 行合成降级通过", () => {
    const t = createExerciseProgressTracker();
    t.applyRunSuccess("s2", "李四", "l1/a.py", TODAY_START);           // 重启回放顺序：先 run 成功
    t.warmUpFromReviews([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START + 100 },   // 从未 run 成功 → 仍 unreviewed
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "unreviewed", ts: TODAY_START + 200 },   // 有 run 成功 → 降级通过
    ]);
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 1, unreviewed: 1 });
  });

  it("list 当天过滤：昨天格子的学生不计、昨天活跃的题不出现", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "fail", TODAY_START - 1000);   // 昨天
    t.applyReview("s2", "李四", "l1/b.py", "fail", NOW);                  // 今天
    expect(t.list(TODAY_START)).toEqual([
      { id: "l1/b.py", displayName: "b.py", isProject: false, passed: 0, stuck: 1, unreviewed: 0, firstTs: NOW, latestTs: NOW, title: "b.py" },
    ]);
    // 同题：昨天 fail 的 s1 不计入今天统计；firstTs 取今天格子（昨天事件不计）
    t.applyReview("s3", "王五", "l1/a.py", "pass", NOW + 2000);
    expect(t.list(TODAY_START).find((i) => i.id === "l1/a.py")).toMatchObject({ passed: 1, stuck: 0, firstTs: NOW + 2000 });
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
    expect(Object.keys(item).sort()).toEqual(["displayName", "firstTs", "id", "isProject", "latestTs", "passed", "stuck", "title", "unreviewed"]);
  });

  it("题面名：applyReview 带 title 时优先展示，未带时回退文件名", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW, "输出问候语");
    t.applyRunFailure("s2", "李四", "l2/b.py", NOW);
    expect(t.list(TODAY_START).find((i) => i.id === "l1/a.py")).toMatchObject({ title: "输出问候语" });
    expect(t.list(TODAY_START).find((i) => i.id === "l2/b.py")).toMatchObject({ title: "b.py" });
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

describe("ExerciseProgressTracker 多任务桶（spec 2026-11-09 §5）", () => {
  const TASKS = ["任务一", "任务二", "任务三"];

  it("逐任务独立桶：任务二 fail 不影响任务一 pass；tasks[] 随 item 下发", () => {
    const t = createExerciseProgressTracker();
    t.registerTasks("l1/a.py", TASKS);
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW, "练习一", "任务一");
    t.applyReview("s1", "张三", "l1/a.py", "fail", NOW + 1000, "练习一", "任务二");
    const item = t.list(TODAY_START)[0];
    expect(item.tasks).toEqual([
      { taskId: "任务一", passed: 1, stuck: 0, unreviewed: 0, firstTs: NOW, latestTs: NOW },
      { taskId: "任务二", passed: 0, stuck: 1, unreviewed: 0, firstTs: NOW + 1000, latestTs: NOW + 1000 },
      { taskId: "任务三", passed: 0, stuck: 0, unreviewed: 0, firstTs: 0, latestTs: 0 },   // 无格子桶：时间归零
    ]);
    // 文件级聚合：s1 任务一 pass + 任务二 fail → 任一 fail → stuck
    expect(item).toMatchObject({ passed: 0, stuck: 1, unreviewed: 0, title: "练习一" });
  });

  it("只写任务一的学生：文件级 = unreviewed（部分完成不虚报全过）", () => {
    const t = createExerciseProgressTracker();
    t.registerTasks("l1/a.py", TASKS);
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW, undefined, "任务一");
    const item = t.list(TODAY_START)[0];
    expect(item).toMatchObject({ passed: 0, stuck: 0, unreviewed: 1 });
    expect(item.tasks?.find((b) => b.taskId === "任务一")).toMatchObject({ passed: 1 });
  });

  it("全任务 pass 的学生 → 文件级 passed", () => {
    const t = createExerciseProgressTracker();
    t.registerTasks("l1/a.py", TASKS);
    for (const task of TASKS) t.applyReview("s1", "张三", "l1/a.py", "pass", NOW, undefined, task);
    expect(t.list(TODAY_START)[0]).toMatchObject({ passed: 1, stuck: 0, unreviewed: 0 });
  });

  it("run 语义修正：注册后 run 失败不判任何任务 fail，仅推进涌现；注册前维持整文件 fail", () => {
    const before = createExerciseProgressTracker();   // 未注册（尚无评审）→ 现状整文件 fail
    before.applyRunFailure("s1", "张三", "l1/a.py", NOW);
    expect(before.list(TODAY_START)[0]).toMatchObject({ stuck: 1 });

    const after = createExerciseProgressTracker();
    after.registerTasks("l1/a.py", TASKS);
    after.applyReview("s1", "张三", "l1/a.py", "pass", NOW, undefined, "任务一");
    after.applyRunFailure("s2", "李四", "l1/a.py", NOW + 1000);   // 学生 F5 失败
    const item = after.list(TODAY_START)[0];
    expect(item.tasks?.every((b) => b.stuck === 0)).toBe(true);   // 任务不被连坐
    expect(item.tasks?.every((b) => b.unreviewed >= 1 || b.passed >= 1)).toBe(true);   // 仅涌现（unreviewed 格子）
    expect(item).toMatchObject({ stuck: 0 });
  });

  it("run 成功弱信号/降级升级应用到全部任务桶", () => {
    const t = createExerciseProgressTracker();
    t.registerTasks("l1/a.py", TASKS);
    t.applyRunSuccess("s1", "张三", "l1/a.py", NOW);
    // 逐任务 unreviewed（LLM 不可用兜底路径）
    for (const task of TASKS) t.applyUnreviewed("s1", "张三", "l1/a.py", NOW + 1000, undefined, task);
    const item = t.list(TODAY_START)[0];
    expect(item.tasks?.every((b) => b.passed === 1)).toBe(true);   // 全桶降级通过
    expect(item).toMatchObject({ passed: 1 });
  });

  it("warmUpFromReviews 带 taskId 行重建注册表并回放任务桶", () => {
    const t = createExerciseProgressTracker();
    t.warmUpFromReviews([
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "pass", ts: NOW, taskId: "任务一" },
      { studentId: "s1", studentName: "张三", filePath: "l1/a.py", status: "unreviewed", ts: NOW + 100, taskId: "任务二" },
      { studentId: "s2", studentName: "李四", filePath: "l1/a.py", status: "unreviewed", ts: NOW + 200, taskId: "任务一" },
    ]);
    const item = t.list(TODAY_START)[0];
    expect(item.tasks).toHaveLength(2);   // 仅 2 个声明 → 多任务
    expect(item.tasks?.find((b) => b.taskId === "任务一")).toMatchObject({ passed: 1, unreviewed: 1 });
    expect(item.tasks?.find((b) => b.taskId === "任务二")).toMatchObject({ unreviewed: 1 });
    // 重启后 run 失败按注册语义抑制
    t.applyRunFailure("s3", "王五", "l1/a.py", NOW + 300);
    expect(t.list(TODAY_START)[0].stuck).toBe(0);
  });

  it("未注册任务名的 applyReview（taskName 单个）不构成多任务 → 整文件单桶现状", () => {
    const t = createExerciseProgressTracker();
    t.applyReview("s1", "张三", "l1/a.py", "pass", NOW, undefined, "任务一");   // 未 registerTasks
    const item = t.list(TODAY_START)[0];
    expect(item.tasks).toBeUndefined();
    expect(item).toMatchObject({ passed: 1 });
  });
});
