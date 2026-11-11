import { describe, it, expect } from "vitest";
import { createActivityFeed, reviewRowsToFeedRows } from "../activityFeed";

// ── 运行条目 ──
describe("activityFeed.recordRun", () => {
  it("run 成功/失败产生对应条目，新的在前", () => {
    const f = createActivityFeed();
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 1000, filePath: "a.py", errorType: null, errorMessage: null });
    f.recordRun({ studentId: "s1", studentName: "张三", success: false, ts: 2000, filePath: "a.py", errorType: "ZeroDivisionError", errorMessage: "division by zero" });
    const list = f.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ kind: "run_fail", attempt: 2, reasonTag: "ZeroDivisionError", reason: "division by zero" });
    expect(list[1]).toMatchObject({ kind: "run_ok", attempt: 1, reasonTag: null, reason: null });
  });

  it("第 N 次运行计数：同生同题累加，失败也计入；不同题各自计数", () => {
    const f = createActivityFeed();
    f.recordRun({ studentId: "s1", studentName: "张三", success: false, ts: 1, filePath: "a.py", errorType: "E", errorMessage: "m" });
    f.recordRun({ studentId: "s1", studentName: "张三", success: false, ts: 2, filePath: "a.py", errorType: "E", errorMessage: "m" });
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 3, filePath: "b.py", errorType: null, errorMessage: null });
    const [b, a2, a1] = f.list();
    expect(a2.attempt).toBe(2);
    expect(a1.attempt).toBe(1);
    expect(b.attempt).toBe(1);
  });

  it("无 filePath 的 run 不影响其他题计数（键回落 _）", () => {
    const f = createActivityFeed();
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 1, filePath: null, errorType: null, errorMessage: null });
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 2, filePath: null, errorType: null, errorMessage: null });
    expect(f.list()[0].attempt).toBe(2);
    expect(f.list()[0].filePath).toBeNull();
  });
});

// ── 评审条目 ──
describe("activityFeed.recordReview", () => {
  it("pass/fail 产生条目；fail 带评审意见；unreviewed 只计数不产生条目（LLM 降级语义）", () => {
    const f = createActivityFeed();
    f.recordReview({ studentId: "s1", studentName: "张三", filePath: "a.py", ts: 1, status: "unreviewed", reason: "评审服务未配置" });
    expect(f.list()).toHaveLength(0);
    f.recordReview({ studentId: "s1", studentName: "张三", filePath: "a.py", ts: 2, status: "fail", reason: "存在未定义变量", title: "练习1：循环" });
    f.recordReview({ studentId: "s1", studentName: "张三", filePath: "a.py", ts: 3, status: "pass", reason: "通过" });
    const list = f.list();
    expect(list).toHaveLength(2);
    // attempt 计数含 unreviewed：unreviewed(1) → fail(2) → pass(3)
    expect(list[0]).toMatchObject({ kind: "review_pass", attempt: 3, reason: null, title: "练习1：循环" });
    expect(list[1]).toMatchObject({ kind: "review_fail", attempt: 2, reasonTag: "评审意见", reason: "存在未定义变量" });
  });

  it("reason 超长截断到 120 字符", () => {
    const f = createActivityFeed();
    f.recordReview({ studentId: "s1", studentName: "张三", filePath: "a.py", ts: 1, status: "fail", reason: "x".repeat(300) });
    expect(f.list()[0].reason).toHaveLength(120);
  });
});

// ── 代码 LRU ──
describe("activityFeed.stashCode/getCode", () => {
  it("按 studentId+filePath 存取；run 条目回退取题名", () => {
    const f = createActivityFeed();
    f.stashCode({ studentId: "s1", filePath: "a.py", code: "print(1)", title: "练习1：循环" });
    expect(f.getCode("s1", "a.py")).toEqual({ title: "练习1：循环", code: "print(1)" });
    expect(f.getCode("s1", "b.py")).toBeNull();
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 1, filePath: "a.py", errorType: null, errorMessage: null });
    expect(f.list()[0].title).toBe("练习1：循环");
  });

  it("LRU 容量 200：最旧的被淘汰", () => {
    const f = createActivityFeed();
    for (let i = 0; i < 205; i++) {
      f.stashCode({ studentId: `s${i}`, filePath: "a.py", code: `c${i}` });
    }
    expect(f.getCode("s0", "a.py")).toBeNull();
    expect(f.getCode("s204", "a.py")).toEqual({ title: null, code: "c204" });
  });

  it("路径形态不一致按文件名回退（用户 2026-11-10）：评审存相对路径，run 条目查绝对路径也能命中；不跨学生串卡", () => {
    const f = createActivityFeed();
    f.stashCode({ studentId: "s1", filePath: "Python程序设计/课后练习-下发/ex05_while.py", code: "print(1)", title: "练习五" });
    f.stashCode({ studentId: "s2", filePath: "ex05_while.py", code: "print(2)" });
    expect(f.getCode("s1", "c:\\Users\\stu\\Desktop\\Python程序设计\\课后练习-下发\\ex05_while.py")).toEqual({ title: "练习五", code: "print(1)" });
    expect(f.getCode("s2", "Python程序设计/课后练习-下发/ex05_while.py")).toEqual({ title: null, code: "print(2)" });
    expect(f.getCode("s1", "ex08_dict.py")).toBeNull();
  });
});

// ── 缓冲上限与重置 ──
describe("activityFeed 缓冲/重置/回放", () => {
  it("缓冲上限 30 条：旧的被淘汰", () => {
    const f = createActivityFeed();
    for (let i = 0; i < 35; i++) {
      f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: i, filePath: "a.py", errorType: null, errorMessage: null });
    }
    expect(f.list()).toHaveLength(30);
    expect(f.list()[0].ts).toBe(34);   // 新的在前
    expect(f.list()[29].ts).toBe(5);   // 最旧保留 5
  });

  it("reset 清空条目与计数", () => {
    const f = createActivityFeed();
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 1, filePath: "a.py", errorType: null, errorMessage: null });
    f.reset();
    expect(f.list()).toHaveLength(0);
    f.recordRun({ studentId: "s1", studentName: "张三", success: true, ts: 2, filePath: "a.py", errorType: null, errorMessage: null });
    expect(f.list()[0].attempt).toBe(1);   // 计数归零重来
  });

  it("replay：按 ts 升序回放 run_ok 与评审行，计数与实时路径同构；review_count 只计数", () => {
    const f = createActivityFeed();
    f.replay([
      { kind: "run_ok", studentId: "s1", studentName: "张三", filePath: "a.py", ts: 100 },
      { kind: "review_count", studentId: "s1", studentName: "张三", filePath: "a.py", ts: 200 },
      { kind: "review_fail", studentId: "s1", studentName: "张三", filePath: "a.py", ts: 300, reasonTag: "评审意见", reason: "循环条件错误" },
    ]);
    const list = f.list();
    expect(list.map((i) => i.kind)).toEqual(["review_fail", "run_ok"]);   // 新的在前，review_count 不产生条目
    expect(list[0].attempt).toBe(2);   // 评审第 2 次（review_count 已计入）
    expect(list[1].attempt).toBe(1);
  });

  it("recordReview partial（多任务部分完成，用户 2026-11-11）：产生条目，reasonTag=部分完成，清单摘要保留", () => {
    const f = createActivityFeed();
    f.recordReview({ studentId: "s1", studentName: "张三", filePath: "a.py", ts: 100, status: "partial", reason: "✅任务一：正确 / ⬜任务二：未开始" });
    const [it] = f.list();
    expect(it.kind).toBe("review_partial");
    expect(it.reasonTag).toBe("部分完成");
    expect(it.reason).toBe("✅任务一：正确 / ⬜任务二：未开始");
  });

  it("reviewRowsToFeedRows：多任务行聚合一条（有结论未全过→partial 含摘要；任一 fail→fail；全 unreviewed→只计数）", () => {
    const rows = [
      { studentId: "s1", studentName: "张三", filePath: "a.py", status: "pass" as const, reason: "正确", ts: 100, taskId: "任务一" },
      { studentId: "s1", studentName: "张三", filePath: "a.py", status: "unreviewed" as const, reason: null, ts: 101, taskId: "任务二" },
      { studentId: "s2", studentName: "李四", filePath: "b.py", status: "fail" as const, reason: "死循环", ts: 102, taskId: "任务一" },
      { studentId: "s2", studentName: "李四", filePath: "b.py", status: "pass" as const, reason: "正确", ts: 103, taskId: "任务二" },
      { studentId: "s3", studentName: "王五", filePath: "c.py", status: "unreviewed" as const, reason: null, ts: 104, taskId: "任务一" },
      { studentId: "s3", studentName: "王五", filePath: "c.py", status: "unreviewed" as const, reason: null, ts: 105, taskId: "任务二" },
      { studentId: "s4", studentName: "赵六", filePath: "d.py", status: "unreviewed" as const, reason: "评审超时", ts: 106, taskId: null },
    ];
    const out = reviewRowsToFeedRows(rows);
    expect(out.map((r) => r.kind)).toEqual(["review_partial", "review_fail", "review_count", "review_count"]);
    expect(out[0].reasonTag).toBe("部分完成");
    expect(out[0].reason).toBe("✅任务一：正确 / ⬜任务二：未开始");
    expect(out[1].reason).toBe("死循环");   // 任一 fail → 首个 fail 意见
    expect(out[1].reasonTag).toBe("评审意见");
  });
});
