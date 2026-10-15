// 作业分发与 LLM 代码评审 DTO + 两仓 wire 契约（spec §2）
export type ReviewStatus = "pass" | "fail" | "unreviewed";

export type ExerciseKind = "file" | "project";
export interface SubmissionFile { path: string; content: string }

export interface ReviewResult {
  status: ReviewStatus;
  reason: string;             // ≤100 字
  reviewedAt: number;
  model: string;              // 审计
  source: "llm" | "mock" | "timeout";
}

export interface Assignment {
  id: string;
  title: string;              // 默认 = 作业目录名（管理页可改）
  week: number;               // 内部排序键（目录名含 week-N 时取 N，否则自增）；UNIQUE
  dueAt?: number;             // 仅展示
  createdAt: number;
  weekDir?: string;           // 磁盘实际目录名（任意一级子目录，spec §2.1）
}

export interface TestCase { input: string; expectedOutput: string; description?: string; }

export interface Exercise {
  id: string;                 // 头部 exercise-id
  assignmentId: string;
  order: number;
  filename: string;           // 创建后不可变（A20）
  problemStatement: string;
  starterCode?: string;
  testCases?: TestCase[];     // MVP 恒空（A29）
  versionHash: string;        // server 填充：sha256(problem+cases+starter)[:16]
  isActive: boolean;
  kind?: ExerciseKind;        // 缺省视为 "file"（存量行）
  dir?: string;               // 项目目录名（kind=project 时必填）
  entry?: string;             // 入口文件（缺省 "main.py"）
  createdAt: number;
}

/** 轻量提交索引行（spec §6.2：submissions 表即索引，不存代码全文；代码在学生分支 git 历史中） */
export interface Submission {
  id: string;
  exerciseId: string;
  studentId: string;
  studentName: string;
  commitHash: string;           // 学生分支提交 hash
  files: string[] | null;       // 本次 push 涉及文件清单（files_json）
  submittedAt: number;
  review: ReviewResult | null;  // 评审完成前 null
}

export interface RosterEntry { studentId: string; studentName: string; }

/** learner → server 运行触发评审 wire payload（spec §4.2；学生分支直连模型：路径定位练习） */
export interface ReviewRequestInput {
  studentId: string;
  studentName: string;
  filePath: string;          // POSIX 相对路径（相对仓库根），如 lesson5/weather-app/main.py
  code: string;              // 入口文件全文（≤50KB）
  commitHash?: string;       // 可空：未提交（未 clone）时为空，review_cache 仍可用，回填跳过
  files?: SubmissionFile[];  // 项目题快照（可选，与旧契约一致）
  source?: "auto" | "manual";
}

// —— .py 头部契约（A5）：server（T4）与 learner（T13）各自实现，正则一致 ——

export const EXERCISE_ID_REGEX =
  /^#\s*exercise-id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;

export function scanExerciseId(content: string): string | null {
  for (const line of content.split(/\r?\n/).slice(0, 20)) {
    const m = line.match(EXERCISE_ID_REGEX);
    if (m) return m[1];
  }
  return null;
}
