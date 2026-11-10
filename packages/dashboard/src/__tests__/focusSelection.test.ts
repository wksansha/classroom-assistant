import { describe, expect, it } from "vitest";
import { AUTO_FILE_ID, mergeFileOptions, pickDefaultTask, pickFocusFile } from "../focusSelection";
import type { ExerciseProgressItem, TaskBucket } from "@classroom/shared";

function item(partial: Partial<ExerciseProgressItem>): ExerciseProgressItem {
  return {
    id: "a.py", displayName: "a.py", isProject: false,
    passed: 0, stuck: 0, unreviewed: 0, total: 20, passRate: 0,
    firstTs: 1000, latestTs: 1000, title: "a.py",
    ...partial,
  };
}

describe("mergeFileOptions（预选 ∪ 涌现，spec 2026-11-09 §6）", () => {
  it("预选置顶一组（含未涌现）、涌现追加一组按时间新→旧；重复文件只在预选组出现", () => {
    const options = mergeFileOptions(
      ["l21/old.py", "l21/new.py"],
      [
        item({ id: "l21/new.py", firstTs: 2000, title: "新题" }),
        item({ id: "l15/old2.py", firstTs: 3000, title: "更题" }),
        item({ id: "l15/old.py", firstTs: 1000, title: "旧题" }),
      ],
    );
    expect(options).toEqual([
      { id: "l21/old.py", label: "old.py", group: "lesson" },          // 预选未涌现也入列
      { id: "l15/old2.py", label: "更题", group: "emerged" },          // 涌现 3000
      { id: "l21/new.py", label: "新题", group: "emerged" },           // 涌现 2000
      { id: "l15/old.py", label: "旧题", group: "emerged" },           // 涌现 1000
    ]);
  });
});

describe("pickFocusFile（「最新动态」自动挑题）", () => {
  it("有评审牵引优先，同牵引按涌现时间最新", () => {
    const items = [
      item({ id: "a.py", passed: 3, firstTs: 1000 }),
      item({ id: "b.py", passed: 0, firstTs: 9000 }),
      item({ id: "c.py", passed: 1, firstTs: 5000 }),
    ];
    expect(pickFocusFile(items)).toBe("c.py");   // a/c 有牵引，c 更新
  });

  it("全员通过 → null（卡片显示「全员通过」空态）", () => {
    expect(pickFocusFile([item({ id: "a.py", passed: 20, total: 20 })])).toBeNull();
    expect(pickFocusFile([])).toBeNull();
  });

  it("全为涌现中的 0% 题（无牵引）→ 涌现时间最新", () => {
    const items = [
      item({ id: "a.py", firstTs: 1000 }),
      item({ id: "b.py", firstTs: 8000 }),
    ];
    expect(pickFocusFile(items)).toBe("b.py");
  });
});

describe("pickDefaultTask（任务 tab 默认桶）", () => {
  const tasks: TaskBucket[] = [
    { taskId: "任务一", passed: 20, stuck: 0, unreviewed: 0, firstTs: 0, latestTs: 0 },
    { taskId: "任务二", passed: 5, stuck: 0, unreviewed: 0, firstTs: 0, latestTs: 0 },
    { taskId: "任务三", passed: 0, stuck: 0, unreviewed: 0, firstTs: 0, latestTs: 0 },
  ];
  it("默认第一个未全员通过的桶", () => {
    expect(pickDefaultTask(tasks, 20)).toBe("任务二");
  });
  it("全过 → 第一个；空清单 → null", () => {
    const allPassed: TaskBucket[] = tasks.map((b) => ({ ...b, passed: 20 }));
    expect(pickDefaultTask(allPassed, 20)).toBe("任务一");
    expect(pickDefaultTask([], 20)).toBeNull();
  });
});

describe("AUTO_FILE_ID 哨兵", () => {
  it("下拉「最新动态」选项值", () => {
    expect(AUTO_FILE_ID).toBe("__auto__");
  });
});
