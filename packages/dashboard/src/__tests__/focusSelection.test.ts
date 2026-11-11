import { describe, expect, it } from "vitest";
import { baseName, findItemByBase, lessonFileOptions, pickDefaultTask, pickFocusFile } from "../focusSelection";
import type { ExerciseProgressItem, TaskBucket } from "@classroom/shared";

function item(partial: Partial<ExerciseProgressItem>): ExerciseProgressItem {
  return {
    id: "a.py", displayName: "a.py", isProject: false,
    passed: 0, stuck: 0, unreviewed: 0, total: 20, passRate: 0,
    firstTs: 1000, latestTs: 1000, title: "a.py",
    ...partial,
  };
}

describe("lessonFileOptions（预选清单 → 下拉选项，用户 2026-11-10）", () => {
  it("顺序 = 保存顺序，label 只显示文件名（basename），不做任何增删排序", () => {
    expect(lessonFileOptions(["第3章/zz.py", "第2章/aa.py"])).toEqual([
      { id: "第3章/zz.py", label: "zz.py" },
      { id: "第2章/aa.py", label: "aa.py" },
    ]);
  });
});

describe("findItemByBase（预选路径 ↔ 涌现 id 按文件名匹配）", () => {
  const items = [
    item({ id: "lesson1/a.py" }),
    item({ id: "裸名.py", title: "题面" }),
  ];
  it("带目录预选路径命中涌现裸名/带目录 id", () => {
    expect(findItemByBase(items, "某目录/a.py")?.id).toBe("lesson1/a.py");
    expect(findItemByBase(items, "lesson1/a.py")?.id).toBe("lesson1/a.py");
    expect(findItemByBase(items, "x/裸名.py")?.id).toBe("裸名.py");
  });
  it("未涌现 → undefined（上游造零进度虚拟桶）", () => {
    expect(findItemByBase(items, "nope.py")).toBeUndefined();
  });
  it("baseName 兼容两种分隔符", () => {
    expect(baseName("a\\b/c.py")).toBe("c.py");
  });
});

describe("pickFocusFile（「最新动态」自动挑题，用户 2026-11-11 定稿：latestTs 最新优先）", () => {
  it("按最近活跃时间（latestTs）最新优先，跟随课堂注意力", () => {
    const items = [
      item({ id: "a.py", passed: 3, firstTs: 1000, latestTs: 5000 }),
      item({ id: "b.py", firstTs: 9000, latestTs: 9000 }),
      item({ id: "c.py", passed: 1, firstTs: 5000, latestTs: 7000 }),
    ];
    expect(pickFocusFile(items)).toBe("b.py");   // b 动态最新
  });

  it("全员通过的题不排除：课堂安静时焦点停在最后活跃题（100% 水桶）", () => {
    expect(pickFocusFile([item({ id: "a.py", passed: 20, total: 20, firstTs: 1000, latestTs: 8000 })])).toBe("a.py");
  });

  it("空清单 → null", () => {
    expect(pickFocusFile([])).toBeNull();
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
