import type { Explanation, NormalizedEvent } from "@classroom/shared";

export interface StoredEvent {
  ts: number;
  eventType: "diag" | "run";
  success: boolean;
  subtype: string | null;
  category: string;
  knowledge: string | null;
  rawMessage: string;
  codeSnippet?: string;
}

export interface StudentRecord {
  studentId: string;
  studentName: string;
  classId: string;
  events: StoredEvent[];
  lastActivityAt: number;
  lastErrorAt: number | null;
  consecutiveErrors: number;
}

const MAX_EVENTS = 200;

export interface StateManager {
  apply(ev: NormalizedEvent, explanation: Explanation | null): void;
  listRecords(): StudentRecord[];
  getStudentDetail(id: string): {
    studentId: string; studentName: string; events: StoredEvent[];
    lastActivityAt: number; lastErrorAt: number | null;
  } | null;
}

export function createStateManager(): StateManager {
  const records = new Map<string, StudentRecord>();

  return {
    apply(ev, explanation) {
      let r = records.get(ev.studentId);
      if (!r) {
        r = {
          studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
          events: [], lastActivityAt: ev.ts, lastErrorAt: null, consecutiveErrors: 0,
        };
        records.set(ev.studentId, r);
      }
      r.studentName = ev.studentName; // 名字可能后来才配上
      r.classId = ev.classId;
      r.events.push({
        ts: ev.ts, eventType: ev.eventType, success: ev.success,
        subtype: ev.success ? null : (explanation?.subtype ?? null),
        category: ev.success ? "运行成功" : (explanation?.category ?? "其他"),
        knowledge: ev.success ? null : (explanation?.knowledge ?? null),
        rawMessage: ev.rawMessage,
        codeSnippet: ev.codeSnippet,
      });
      if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
      r.lastActivityAt = Math.max(r.lastActivityAt, ev.ts);
      if (ev.success) {
        r.consecutiveErrors = 0;
      } else {
        r.lastErrorAt = Math.max(r.lastErrorAt ?? 0, ev.ts);
        r.consecutiveErrors += 1;
      }
    },

    listRecords: () => [...records.values()],

    getStudentDetail(id) {
      const r = records.get(id);
      if (!r) return null;
      return {
        studentId: r.studentId, studentName: r.studentName,
        events: [...r.events].reverse(), // 新的在前（抽屉展示用）
        lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
      };
    },
  };
}