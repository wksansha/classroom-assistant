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

/** 课堂动态条目四态（spec 课堂动态）：评审 unreviewed 不产生条目 = LLM 降级自动只显示运行类 */
export type ActivityKind = "run_ok" | "run_fail" | "review_pass" | "review_fail";

export interface ActivityFeedItem {
  /** 去重/进入动画 key：`{studentId}:{kind}:{seq}` */
  id: string;
  kind: ActivityKind;
  studentId: string;
  studentName: string;
  ts: number;
  /** 该生该题的第 N 次（run=运行总数含失败；review=评审请求数含 unreviewed），按 studentId+filePath 计数 */
  attempt: number;
  /** 失败原因标签（run_fail=Python 异常名；review_fail=评审意见），成功类为 null */
  reasonTag: string | null;
  /** 失败原因摘要，成功类为 null */
  reason: string | null;
  /** 题面名（评审输入首行注释提取；run 事件回退最近一次评审缓存的题名），代码卡悬浮展示 */
  title: string | null;
  /** 代码懒加载锚点（/api/feed/code），run 事件可能为 null */
  filePath: string | null;
}

/** 题目涌现格子的三态（spec 决策 #14/#18）：格子因评审/run 事件而生，无"未开始"预置。
 * 仅用于服务端内部计数，快照不输出学生名单（2026-10-22 拍板） */
export type ExerciseStatus = "pass" | "fail" | "unreviewed";

/** 单文件多任务：一个任务桶（spec 2026-11-09 §5）。多任务题（任务声明 ≥2）逐任务一桶 */
export interface TaskBucket {
  /** 任务名（题面声明 [任务X] 短名 / 第X部分分节名；文件内唯一） */
  taskId: string;
  /** 人数口径与文件级三态一致：当天窗口内该任务桶的学生计数 */
  passed: number;
  stuck: number;
  unreviewed: number;
  /** 桶涌现时间（首个学生首个任务事件；min 口径） */
  firstTs: number;
  latestTs: number;
}

export interface ExerciseProgressItem {
  /** 文件路径（当天涌现，决策 #18） */
  id: string;
  /** 文件名（basename，兼容 Windows 反斜杠路径） */
  displayName: string;
  isProject: boolean;
  /** 均为当天人数；多任务题 = 学生聚合（全部任务 pass → passed / 任一任务 fail → stuck / 其余 unreviewed） */
  passed: number;
  stuck: number;
  unreviewed: number;
  /** 班级总人数（花名册，决策 #20；装配层注入） */
  total: number;
  /** passed/total（决策 #20；装配层注入） */
  passRate: number;
  /** 首次活跃时间（epoch ms，当天窗口内） */
  firstTs: number;
  /** 最近活跃时间（epoch ms，当天窗口内；前端据其锁定「当前题」——最新成功/报错事件的题） */
  latestTs: number;
  /** 题面名（评审输入代码分隔线前首行注释；无评审时回退文件名） */
  title: string;
  /** 多任务题的任务桶数组（任务声明 ≥2 时非空；单任务题缺省 = 整文件一桶走 top-level 字段） */
  tasks?: TaskBucket[];
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
  /** 近 5 分钟报错次数（滚动窗口，课堂安静即回落；区别于只增不减的当天累计值） */
  errors: number;
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
  /** 课堂动态（最近 30 条，新的在前；内存环形缓冲，重启后由回放重建） */
  activityFeed: ActivityFeedItem[];
  /** 评审 LLM 是否配置（false = 降级模式，feed 只会出现运行类条目） */
  reviewOnline: boolean;
}

export type SSEMessage =
  | { type: "snapshot"; data: TeacherSnapshot }
  | { type: "update"; data: TeacherSnapshot };