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
  /** 最近一次评审通过时间（问题「已解决」的唯一信号；run 成功只是活动信号，不置绿） */
  lastResolvedAt: number | null;
  consecutiveErrors: number;
}

const MAX_EVENTS = 200;

export interface ApplyOptions {
  /** 评审通过注入的事件置 true：清零连续错误并标记问题已解决（spec：评审成功才变绿） */
  resolves?: boolean;
}

export interface StateManager {
  apply(ev: NormalizedEvent, explanation: Explanation | null, opts?: ApplyOptions): void;
  listRecords(): StudentRecord[];
  getStudentDetail(id: string): {
    studentId: string; studentName: string; events: StoredEvent[];
    lastActivityAt: number; lastErrorAt: number | null;
  } | null;
}

export function createStateManager(): StateManager {
  const records = new Map<string, StudentRecord>();

  return {
    apply(ev, explanation, opts) {
      let r = records.get(ev.studentId);
      if (!r) {
        r = {
          studentId: ev.studentId, studentName: ev.studentName, classId: ev.classId,
          events: [], lastActivityAt: ev.ts, lastErrorAt: null, lastResolvedAt: null, consecutiveErrors: 0,
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
        // run 成功只是活动信号；仅评审通过（resolves）才清零连续错误并标记已解决
        if (opts?.resolves) {
          r.lastResolvedAt = Math.max(r.lastResolvedAt ?? 0, ev.ts);
          r.consecutiveErrors = 0;
        }
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
          lastResolvedAt: r.lastResolvedAt,
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