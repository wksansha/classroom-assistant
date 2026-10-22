// 评审与轻量提交索引 DTO + 两仓 wire 契约（作业域退役后：无作业/练习实体，练习定位纯路径化）
export type ReviewStatus = "pass" | "fail" | "unreviewed";

export interface SubmissionFile { path: string; content: string }

export interface ReviewResult {
  status: ReviewStatus;
  reason: string;             // ≤100 字
  reviewedAt: number;
  model: string;              // 审计
  source: "llm" | "mock" | "timeout" | "not_configured";
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
