import type { NormalizedEvent } from "@classroom/shared";

type AnyBody = Record<string, any>;

export function normalize(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as AnyBody;
  const ts = toMs(b.ts ?? b.timestamp);

  // L1 格式（simulator）：{ surface, kind, ts, payload }
  if (b.surface && b.payload) {
    const p = b.payload as AnyBody;
    if (b.surface !== "diag" && b.surface !== "run") return null;
    const eventType = b.surface;
    const exitCode = typeof p.exit_code === "number" ? p.exit_code : undefined;
    const success = eventType === "run" && exitCode === 0;
    const samples: string[] = Array.isArray(p.samples) ? p.samples : [];
    const errorType = eventType === "diag" ? null : (p.error_type ?? null);
    return {
      studentId: p.student_id ?? b.student_id ?? null,
      studentName: p.student_name ?? b.student_name ?? p.student_id ?? b.student_id ?? "unknown",
      classId: p.class_id ?? b.class_id ?? "default",
      eventType,
      success,
      errorType,
      errorMessage: eventType === "diag" ? samples.join("; ") : (p.error_message ?? null),
      samples,
      rawMessage: eventType === "diag" ? (samples[0] ?? "") : (p.error_message ?? ""),
      cacheKey: extractCacheKey(eventType, success, errorType, p.error_message, samples),
      command: p.command,
      exitCode,
      filePath: p.file ?? p.file_path,
      lineNo: p.line,
      ts,
    };
  }

  // flat 格式（reporter.ts）
  if (b.event_type === "diag" || b.event_type === "run") {
    const eventType = b.event_type;
    const exitCode = typeof b.exit_code === "number" ? b.exit_code : undefined;
    const success = eventType === "run" && (exitCode === 0 || b.error_type === "RunSuccess");
    const samples: string[] = Array.isArray(b.samples) ? b.samples : [];
    const errorType = eventType === "diag" ? null : (b.error_type ?? null);
    return {
      studentId: b.student_id ?? null,
      studentName: b.student_name ?? b.student_id ?? "unknown",
      classId: b.class_id ?? "default",
      eventType,
      success,
      errorType,
      errorMessage: eventType === "diag" ? samples.join("; ") : (b.error_message ?? null),
      samples,
      rawMessage: b.raw_message ?? b.error_message ?? "",
      cacheKey: extractCacheKey(eventType, success, errorType, b.error_message, samples),
      command: b.command,
      exitCode,
      filePath: b.file_path,
      lineNo: b.line_no,
      ts,
    };
  }

  return null;
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
