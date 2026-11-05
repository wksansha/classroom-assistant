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

/** 机器级登录会话（登录态在线模型）：键 = vscode.env.machineId，同机多窗口 upsert 幂等 */
export interface MachineSession {
  /** 服务端接收时刻记账（不信任客户端 ts，时钟错乱免疫） */
  lastAliveAt: number;
  closed: boolean;
  /** logout=切换学号显式登出（同键心跳不复活，仅 identity_confirmed 重开）；timeout=心跳超时（心跳恢复即重开） */
  closedBy: "logout" | "timeout" | null;
}

export interface StudentRecord {
  studentId: string;
  studentName: string;
  classId: string;
  events: StoredEvent[];
  lastActivityAt: number;
  lastErrorAt: number | null;
  /** 最近一次运行报错的文件：同文件 run 成功 = 自我解决信号；评审失败注入（无文件）不可被 run 成功清除 */
  lastErrorFile: string | null;
  /** 最近一次问题解决时间（评审通过或自我解决；晚于 lastErrorAt = 无未解决错误） */
  lastResolvedAt: number | null;
  consecutiveErrors: number;
  machines: Map<string, MachineSession>;
}

/** 心跳超时阈值：超过该时长无心跳判该机器下线（丢 3 拍容忍） */
export const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;

/** 在线判定：存在未关闭机器会话（超时由 sweep 置 closed，此处不再看时间） */
export function isStudentOnline(r: StudentRecord): boolean {
  for (const m of r.machines.values()) if (!m.closed) return true;
  return false;
}

/** 存活机器数（×N 徽标口径，与 online 同源） */
export function countAliveMachines(r: StudentRecord): number {
  let n = 0;
  for (const m of r.machines.values()) if (!m.closed) n++;
  return n;
}

const MAX_EVENTS = 200;

export interface ApplyOptions {
  /** 评审通过注入的事件置 true：清零连续错误并标记问题已解决（spec：评审成功才变绿） */
  resolves?: boolean;
}

export interface StateManager {
  apply(ev: NormalizedEvent, explanation: Explanation | null, opts?: ApplyOptions): void;
  /** edit 活动信号（spec dashboard-v2 §5.5）：仅推进 lastActivityAt（取更大值），
   * 不入事件列表、不解释。返回更新前的 lastActivityAt；新建档返回 null（此前无记录） */
  touchActivity(studentId: string, studentName: string, classId: string, ts: number): number | null;
  /** 登录确认（identity_confirmed 信号）：upsert 机器会话（可重开 logout 会话）。返回在线是否翻转 */
  confirmLogin(studentId: string, studentName: string, classId: string, machineId: string, now: number): boolean;
  /** 心跳：续命机器会话；logout 会话不复活（timeout 会话可重开）。返回在线是否翻转 */
  heartbeat(studentId: string, studentName: string, classId: string, machineId: string, now: number): boolean;
  /** 显式登出（切换学号）。返回在线是否翻转 */
  logout(studentId: string, machineId: string): boolean;
  /** 心跳超时扫描：过期机器置 closedBy=timeout。返回是否有任何翻转 */
  sweep(now: number): boolean;
  /** 课间重置（大屏重置）：清空事件/错误/活动状态重新统计；保留机器登录会话（学生无需重新确认身份） */
  resetForNewClass(): void;
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
          events: [], lastActivityAt: ev.ts, lastErrorAt: null, lastResolvedAt: null, lastErrorFile: null, consecutiveErrors: 0,
          machines: new Map(),
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
        if (opts?.resolves) {
          // 评审通过（注入事件）：清零连续错误并标记已解决
          r.lastResolvedAt = Math.max(r.lastResolvedAt ?? 0, ev.ts);
          r.consecutiveErrors = 0;
        } else if (ev.eventType === "run" && ev.filePath && r.lastErrorAt !== null
          && r.lastErrorFile === ev.filePath && (r.lastResolvedAt ?? -1) < r.lastErrorAt) {
          // 自我解决（方案A）：运行报错后同文件再次运行成功 = 该错误已被学员自己修好，
          // 即时恢复状态，不等 LLM 评审；评审维度问题由 review_fail 注入另行记账（无文件，不受此清除）
          r.lastResolvedAt = Math.max(r.lastResolvedAt ?? 0, ev.ts);
          r.consecutiveErrors = 0;
          r.lastErrorFile = null;
        }
      } else {
        r.lastErrorAt = Math.max(r.lastErrorAt ?? 0, ev.ts);
        r.consecutiveErrors += 1;
        // 记录报错文件：run 失败带文件（可被同文件 run 成功自解）；评审 fail 注入无文件（只能评审 pass 清除）
        r.lastErrorFile = ev.filePath ?? null;
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

    touchActivity(studentId, studentName, classId, ts) {
      const r = records.get(studentId);
      if (!r) {
        records.set(studentId, {
          studentId, studentName, classId, events: [],
          lastActivityAt: ts, lastErrorAt: null, lastResolvedAt: null, lastErrorFile: null, consecutiveErrors: 0,
          machines: new Map(),
        });
        logEvent({ event: "state.touch_new_record", level: "debug", data: { studentId, ts } });
        return null;
      }
      const prev = r.lastActivityAt;
      r.lastActivityAt = Math.max(r.lastActivityAt, ts);
      return prev;
    },

    confirmLogin(studentId, studentName, classId, machineId, now) {
      let r = records.get(studentId);
      if (!r) {
        r = {
          studentId, studentName, classId, events: [],
          lastActivityAt: 0, lastErrorAt: null, lastResolvedAt: null, lastErrorFile: null, consecutiveErrors: 0,
          machines: new Map(),
        };
        records.set(studentId, r);
      }
      const wasOnline = isStudentOnline(r);
      r.machines.set(machineId, { lastAliveAt: now, closed: false, closedBy: null });
      const flipped = wasOnline !== isStudentOnline(r);
      logEvent({ event: "state.login_confirmed", level: "debug", data: { studentId, machineId, flipped } });
      return flipped;
    },

    heartbeat(studentId, studentName, classId, machineId, now) {
      let r = records.get(studentId);
      if (!r) {
        // 服务端重启自愈：第一拍心跳重建档案（客户端确认态未变，身份可信）
        r = {
          studentId, studentName, classId, events: [],
          lastActivityAt: 0, lastErrorAt: null, lastResolvedAt: null, lastErrorFile: null, consecutiveErrors: 0,
          machines: new Map(),
        };
        records.set(studentId, r);
      }
      const existing = r.machines.get(machineId);
      if (existing?.closedBy === "logout") {
        // 显式登出后同键心跳不复活（切换竞态防护）；重新登录走 identity_confirmed
        return false;
      }
      const wasOnline = isStudentOnline(r);
      r.machines.set(machineId, { lastAliveAt: now, closed: false, closedBy: null });
      const flipped = wasOnline !== isStudentOnline(r);
      if (flipped) logEvent({ event: "state.heartbeat_flip", level: "debug", data: { studentId, machineId } });
      return flipped;
    },

    logout(studentId, machineId) {
      const r = records.get(studentId);
      if (!r) return false;
      const m = r.machines.get(machineId);
      if (!m || m.closed) return false;
      const wasOnline = isStudentOnline(r);
      m.closed = true;
      m.closedBy = "logout";
      const flipped = wasOnline !== isStudentOnline(r);
      logEvent({ event: "state.logout", level: "debug", data: { studentId, machineId, flipped } });
      return flipped;
    },

    sweep(now) {
      let flipped = false;
      for (const r of records.values()) {
        for (const [machineId, m] of r.machines) {
          if (!m.closed && now - m.lastAliveAt > HEARTBEAT_TIMEOUT_MS) {
            m.closed = true;
            m.closedBy = "timeout";
            flipped = true;
            logEvent({ event: "state.heartbeat_timeout", level: "debug", data: { studentId: r.studentId, machineId } });
          }
        }
      }
      return flipped;
    },

    resetForNewClass() {
      for (const r of records.values()) {
        r.events = [];
        r.lastActivityAt = 0;
        r.lastErrorAt = null;
        r.lastResolvedAt = null;
        r.lastErrorFile = null;
        r.consecutiveErrors = 0;
        // machines 保留：登录会话不丢，学生无需重新确认身份，在线状态平滑过渡到新课
      }
      logEvent({ event: "state.reset_for_new_class", level: "info", data: { recordCount: records.size } });
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