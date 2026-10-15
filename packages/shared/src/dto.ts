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
}

export type SSEMessage =
  | { type: "snapshot"; data: TeacherSnapshot }
  | { type: "update"; data: TeacherSnapshot };