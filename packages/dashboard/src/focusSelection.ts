// 完成度卡焦点选择纯函数（spec 2026-11-09 §6）：下拉合并、自动挑题、默认任务桶。
// 抽纯函数便于单测（ChartsRow 组件内不掺排序/筛选逻辑）。

import type { ExerciseProgressItem, TaskBucket } from "@classroom/shared";

/** 下拉「最新动态」哨兵值（选中 = 系统自动挑题） */
export const AUTO_FILE_ID = "__auto__";

export interface FileOption {
  id: string;
  label: string;
  group: "lesson" | "emerged";
}

/** 预选清单 ∪ 涌现题 → 下拉选项：预选置顶一组（未涌现的也在），涌现追加一组（涌现时间新→旧） */
export function mergeFileOptions(lessonFiles: string[], items: ExerciseProgressItem[]): FileOption[] {
  const emergedIds = new Set(items.map((i) => i.id));
  const lesson: FileOption[] = lessonFiles
    .filter((f) => !emergedIds.has(f))
    .map((f) => ({ id: f, label: f.split(/[\\/]/).pop() ?? f, group: "lesson" }));
  const emerged: FileOption[] = [...items]
    .sort((a, b) => b.firstTs - a.firstTs)
    .map((i) => ({ id: i.id, label: i.title || i.displayName, group: "emerged" as const }));
  return [...lesson, ...emerged];
}

/** 自动挑题（「最新动态」语义）：未全员通过的题里，有评审牵引（passed>0）优先，再按涌现时间最新 */
export function pickFocusFile(items: ExerciseProgressItem[]): string | null {
  const active = items.filter((e) => e.passed < e.total);
  if (!active.length) return null;
  return [...active]
    .sort((a, b) => ((b.passed > 0 ? 1 : 0) - (a.passed > 0 ? 1 : 0)) || (b.firstTs - a.firstTs))[0].id;
}

/** 任务 tab 默认桶：第一个未全员通过的任务；全过则第一个 */
export function pickDefaultTask(tasks: TaskBucket[], total: number): string | null {
  if (!tasks.length) return null;
  return (tasks.find((b) => b.passed < total) ?? tasks[0]).taskId;
}
