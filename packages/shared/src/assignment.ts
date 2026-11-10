// 评审与轻量提交索引 DTO + 两仓 wire 契约（作业域退役后：无作业/练习实体，练习定位纯路径化）
export type ReviewStatus = "pass" | "fail" | "unreviewed";

export interface SubmissionFile { path: string; content: string }

/** 单文件多任务：逐任务结论（spec 2026-11-09 §4）；ReviewResult.tasks 存在于多任务题（≥2 任务声明） */
export interface ReviewTaskVerdict {
  name: string;               // 与题面声明的任务名一致
  status: ReviewStatus;
  reason: string;             // ≤50 字
  /** fail 时的教学分类（REVIEW_CATEGORIES 六选一）；旧缓存/LLM 未输出时缺省 */
  category?: string;
}

export interface ReviewResult {
  status: ReviewStatus;
  reason: string;             // ≤100 字（多任务题 = 逐任务结论拼接摘要）
  reviewedAt: number;
  model: string;              // 审计
  source: "llm" | "mock" | "timeout" | "not_configured";
  /** fail 时的教学分类（REVIEW_CATEGORIES 六选一，多任务题取首个 fail 任务的分类）；旧数据/不可用兜底时缺省 */
  category?: string;
  /** 多任务题逐任务结论；单任务题/LLM 不可用兜底时缺省 */
  tasks?: ReviewTaskVerdict[];
}

export interface RosterEntry { studentId: string; studentName: string; }

/** learner → server 运行触发评审 wire payload（spec §0：练习定位 = filePath，题面锚点 = 文件内注释） */
export interface ReviewRequestInput {
  studentId: string;
  studentName: string;
  filePath: string;          // POSIX 相对路径（相对仓库根），如 lesson5/weather-app/main.py
  code: string;              // 当前文件全文（≤50KB，含题面注释）
  commitHash?: string;       // 可空：未提交（未 clone）时为空，review_cache 仍可用，回填跳过
  files?: SubmissionFile[];  // 项目快照（可选）：有则按多文件组装评审输入
  source?: "auto" | "manual";
}
