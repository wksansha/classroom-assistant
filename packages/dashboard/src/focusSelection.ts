// 完成度卡焦点选择纯函数（spec 2026-11-09 §6）：下拉合并、自动挑题、默认任务桶。
// 抽纯函数便于单测（ChartsRow 组件内不掺排序/筛选逻辑）。

import type { ExerciseProgressItem, TaskBucket } from "@classroom/shared";

/** 下拉「最新动态」哨兵值已废弃（用户 2026-11-10 交互重做）：有预选 → 下拉只列预选文件；无预选 → 无下拉（自动挑题） */

export interface FileOption {
  id: string;
  label: string;
}

/** 取文件名（basename）：预选清单带目录、事件上报可能是裸名，展示与匹配统一按文件名对齐 */
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** 预选清单 → 下拉选项：完全以教师选择为准，顺序 = 管理页保存顺序，label 只显示文件名 */
export function lessonFileOptions(lessonFiles: string[]): FileOption[] {
  return lessonFiles.map((f) => ({ id: f, label: baseName(f) }));
}

/** 按文件名在涌现题中定位：预选路径带目录、涌现 id 可能是裸名，basename 命中即同一文件 */
export function findItemByBase(items: ExerciseProgressItem[], targetId: string): ExerciseProgressItem | undefined {
  const t = baseName(targetId);
  return items.find((i) => baseName(i.id) === t);
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
