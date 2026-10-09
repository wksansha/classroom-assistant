import type { Explanation, NormalizedEvent } from "@classroom/shared";
import { logEvent } from "./logger";

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
        logEvent({ event: "state.new_record", level: "info", data: {
          studentId: ev.studentId,
          studentName: ev.studentName,
          classId: ev.classId,
          initialEvent: ev,
        } });
      }

      r.studentName = ev.studentName; // 名字可能后来才配上
      r.classId = ev.classId;
      const storedEvent = {
        ts: ev.ts, eventType: ev.eventType, success: ev.success,
        subtype: ev.success ? null : (explanation?.subtype ?? null),
        category: ev.success ? "运行成功" : (explanation?.category ?? "其他"),
        knowledge: ev.success ? null : (explanation?.knowledge ?? null),
        rawMessage: ev.rawMessage,
        codeSnippet: ev.codeSnippet,
      };
      r.events.push(storedEvent);
      if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
      r.lastActivityAt = Math.max(r.lastActivityAt, ev.ts);
      if (ev.success) {
        r.consecutiveErrors = 0;
      } else {
        r.lastErrorAt = Math.max(r.lastErrorAt ?? 0, ev.ts);
        r.consecutiveErrors += 1;
      }

      logEvent({ event: "state.event_applied", level: "debug", data: {
        studentId: ev.studentId,
        storedEvent,
        explanation: explanation || null,
        recordState: {
          totalEvents: r.events.length,
          consecutiveErrors: r.consecutiveErrors,
          lastActivityAt: r.lastActivityAt,
          lastErrorAt: r.lastErrorAt,
        },
      } });
    },

    listRecords: () => [...records.values()],

    getStudentDetail(id) {
      const r = records.get(id);
      if (!r) {
        logEvent({ event: "state.get_detail_not_found", level: "debug", data: { studentId: id } });
        return null;
      }
      const detail = {
        studentId: r.studentId, studentName: r.studentName,
        events: [...r.events].reverse(), // 新的在前（抽屉展示用）
        lastActivityAt: r.lastActivityAt, lastErrorAt: r.lastErrorAt,
      };
      logEvent({ event: "state.get_detail_success", level: "debug", data: { studentId: id, eventCount: r.events.length } });
      return detail;
    },
  };
}