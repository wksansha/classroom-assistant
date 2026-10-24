export type StatusColor = "green" | "yellow" | "red";

export interface RecentError {
  ts: number;
  subtype: string;
  knowledge: string;
  rawMessage: string;
}

export interface StudentState {
  studentId: string;
  studentName: string;
  status: StatusColor;
  /** 未在线标识（决策 #19）：当天无任何活动 = false，矩阵瓦片变暗+灰点（不占状态）。
   * 会话模型：存在「未关闭且当天有活动」的窗口会话才算在线（切换学号关闭本机会话后立即下线） */
  online: boolean;
  /** 并发在线机器数：未关闭且 10 分钟内有活动的窗口会话数（≥2 时矩阵瓦片右上角显示 ×N） */
  machineCount: number;
  priorityScore: number;
  lastActivityAt: number | null;
  lastErrorAt: number | null;
  errorCountTotal: number;
  /** 最近 3 条错误，新的在前（矩阵悬停用） */
  recentErrors: RecentError[];
}

export interface AlertItem {
  studentId: string;
  studentName: string;
  score: number;
  reason: string;
  subtype: string;
  knowledge: string;
  lastErrorAt: number;
}

export interface AggItem {
  subtype: string;
  category: string;
  knowledge: string;
  /** 涉及人数（不是事件数） */
  count: number;
  students: { studentId: string; studentName: string }[];
}

export type SuggestionKind = "class-review" | "group-discuss" | "individual";

export interface SuggestionItem {
  /** 稳定 id（ack 用）：class-review:{subtype} / group-discuss:{subtype} / individual:{排序后 studentId 逗号拼接} */
  id: string;
  kind: SuggestionKind;
  text: string;
  acked: boolean;
}

/** 题目涌现格子的三态（spec 决策 #14/#18）：格子因评审/run 事件而生，无"未开始"预置。
 * 仅用于服务端内部计数，快照不输出学生名单（2026-10-22 拍板） */
export type ExerciseStatus = "pass" | "fail" | "unreviewed";

export interface ExerciseProgressItem {
  /** 文件路径（当天涌现，决策 #18） */
  id: string;
  /** 文件名（basename，兼容 Windows 反斜杠路径） */
  displayName: string;
  isProject: boolean;
  /** 均为当天人数 */
  passed: number;
  stuck: number;
  unreviewed: number;
  /** 班级总人数（花名册，决策 #20；装配层注入） */
  total: number;
  /** passed/total（决策 #20；装配层注入） */
  passRate: number;
}

export interface TrendBucket {
  /** 桶起点（epoch ms），桶宽 5 分钟 */
  tStart: number;
  runs: number;
  errors: number;
}

/** 顶栏统计条预聚合（spec §3①；无「已通过评审」，决策 #18） */
export interface ClassStats {
  /** 当天有活动的学生数（非 idle） */
  online: number;
  /** 本节课出现过的学生总数 */
  total: number;
  /** 红色状态学生数 */
  needHelp: number;
  /** 当天 run 成功总次数 */
  runs: number;
}

export interface TeacherSnapshot {
  ts: number;
  classId: string;
  students: StudentState[];
  /** ≤5，score 降序 */
  alerts: AlertItem[];
  /** "其余 N 人正常" */
  alertSummary: string;
  /** 按 subtype 分组，count 降序 */
  aggregates: AggItem[];
  suggestions: SuggestionItem[];
  /** 通过率升序全量（作业累计域，spec §5.3） */
  exerciseProgress: ExerciseProgressItem[];
  /** 当天全量桶，tStart 升序 */
  trend: TrendBucket[];
  stats: ClassStats;
}

export type SSEMessage =
  | { type: "snapshot"; data: TeacherSnapshot }
  | { type: "update"; data: TeacherSnapshot };