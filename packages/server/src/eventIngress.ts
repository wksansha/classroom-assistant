import type { IngressEvent, TraceSurface } from "@classroom/shared";
import { logEvent } from "./logger";

type AnyBody = Record<string, any>;

const SURFACE_VALUES = new Set<string>(["edit", "run", "chat", "debug", "diag", "behavior"]);
const EVENT_ID_PATTERN = /^(edit|run|chat|debug|diag|behavior):[0-9A-Za-z-]{6,64}$/;

export function isDiagRunEvent(ev: IngressEvent): ev is IngressEvent & { eventType: "diag" | "run" } {
  return ev.eventType === "diag" || ev.eventType === "run";
}

export function normalize(body: unknown): IngressEvent | null {
  if (!body || typeof body !== "object") {
    logEvent({ event: "event.invalid_body", level: "debug", data: { body } });
    return null;
  }
  const b = body as AnyBody;
  const idOk = typeof b.id === "string" && EVENT_ID_PATTERN.test(b.id);
  const surfaceOk = typeof b.surface === "string" && SURFACE_VALUES.has(b.surface);
  if (!idOk || !surfaceOk || typeof b.kind !== "string" || b.kind === "") {
    logEvent({ event: "event.unrecognized", level: "debug", data: { body } });
    return null;
  }
  const surface = b.surface as TraceSurface;
  const p: AnyBody = b.payload && typeof b.payload === "object" && !Array.isArray(b.payload) ? b.payload : {};
  const ts = toMs(b.ts);
  const isDiagRun = surface === "diag" || surface === "run";
  const exitCode = typeof p.exit_code === "number" ? p.exit_code : undefined;
  const samples: string[] = isDiagRun && Array.isArray(p.samples) ? p.samples : [];
  // run：exit_code 0 即成功；diag：无错误样本 = 错误清零信号（活动信号，不解释、不告警）
  const success = isDiagRun && (surface === "run" ? exitCode === 0 : samples.length === 0);
  const errorType = surface === "run" ? (p.error_type ?? null) : null;

  const ev: IngressEvent = {
    id: b.id,
    surface,
    kind: b.kind,
    payload: p,
    sessionId: typeof b.session_id === "string" ? b.session_id : undefined,
    studentId: p.student_id ?? b.student_id ?? null,
    studentName: b.student_name ?? b.student_id ?? "unknown",
    classId: b.class_id ?? "default",
    eventType: isDiagRun ? surface : undefined,
    success: isDiagRun ? success : false,
    errorType,
    errorMessage: surface === "diag" ? samples.join("; ") : (p.error_message ?? null),
    samples,
    rawMessage: surface === "diag" ? (samples[0] ?? "") : (p.error_message ?? ""),
    codeSnippet: p.code_snippet,
    cacheKey: isDiagRun ? extractCacheKey(surface as "diag" | "run", success, errorType, p.error_message, samples) : null,
    command: p.command,
    exitCode,
    filePath: p.file ?? p.file_path,
    lineNo: p.line,
    ts,
  };

  logEvent({ event: "event.normalized", level: "debug", data: {
    surface, kind: ev.kind, success: ev.success, cacheKey: ev.cacheKey, studentId: ev.studentId,
  } });
  return ev;
}

function extractCacheKey(
  eventType: "diag" | "run",
  success: boolean,
  errorType: string | null | undefined,
  errorMessage: string | null | undefined,
  samples: string[],
): string | null {
  if (success) return null;
  if (eventType === "diag") {
    return samples.length ? [...samples].sort((a, b) => a.length - b.length)[0] : null;
  }
  if (errorType && errorMessage) return `${errorType}: ${errorMessage}`;
  return null;
}

function toMs(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
