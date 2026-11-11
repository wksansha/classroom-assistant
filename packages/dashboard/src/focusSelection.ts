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

/** 自动挑题（「最新动态」语义，用户 2026-11-11 定稿）：按最近活跃时间（latestTs）最新优先，跟随课堂注意力。
 * 全员通过的题不排除：保持显示 100% 水桶（终点文案已废弃，避免课间误报「干得漂亮」），
 * 新题涌现后 latestTs 更新自然接管焦点。无涌现题 → null */
export function pickFocusFile(items: ExerciseProgressItem[]): string | null {
  if (!items.length) return null;
  return [...items].sort((a, b) => b.latestTs - a.latestTs)[0].id;
}

/** 任务 tab 默认桶：第一个未全员通过的任务；全过则第一个 */
export function pickDefaultTask(tasks: TaskBucket[], total: number): string | null {
  if (!tasks.length) return null;
  return (tasks.find((b) => b.passed < total) ?? tasks[0]).taskId;
}
