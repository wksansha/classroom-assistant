/** learner 上报的 flat 格式（vscode-pylearner reporter.ts buildPayload 的产物） */
export interface FlatReport {
  student_id: string;
  student_name: string;
  class_id: string;
  timestamp: string;
  event_type: "diag" | "run";
  raw_message?: string;
  samples?: string[];
  error_type?: string;
  error_message?: string;
  command?: string;
  exit_code?: number;
  file_path?: string;
  line_no?: number;
  source?: string;
}

/** LLM 解释结果（spec §5 三字段，缓存值同构） */
export interface Explanation {
  category: string;
  subtype: string;
  knowledge: string;
}

/** eventIngress.normalize 的输出，服务端全链路统一用这个 */
export interface NormalizedEvent {
  studentId: string;
  studentName: string;
  classId: string;
  eventType: "diag" | "run";
  /** run 且 exit_code === 0 */
  success: boolean;
  /** run 报错时的 Python 异常名；diag 为 null（error_type 是写死的占位） */
  errorType: string | null;
  errorMessage: string | null;
  /** diag 原始样本 */
  samples: string[];
  /** 展示用：diag 取首样本；run 取 error_message */
  rawMessage: string;
  /** run: `${error_type}: ${error_message}`；diag: 最短样本；成功事件为 null */
  cacheKey: string | null;
  command?: string;
  exitCode?: number;
  filePath?: string;
  lineNo?: number;
  /** epoch ms */
  ts: number;
}
