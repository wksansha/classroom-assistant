/**
 * LLM 代理门禁（不改学生端协议，spec 2026-10-23）：
 * - 插件 teacher provider 已带 X-Student-Id 头（0.2.6 起路由接线生效）
 * - 名册已导入：学号必须在名册中，缺头/陌生学号 → 403（响应体中文提示，学生聊天窗口直接可见）
 * - 名册为空（教师未导入/本地开发）→ 放行
 * - 按学号固定窗口限流，兜底"冒用他人学号"刷 LLM 额度
 */
import type { Request, Response, NextFunction } from "express";
import { logEvent } from "../logger";

/** 每学号每窗口最大聊天请求数 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

export interface LlmGateDeps {
  /** 名册是否有条目（空 = 教师未导入名册） */
  hasRoster: () => boolean;
  /** 学号是否在名册中 */
  isRosterStudent: (studentId: string) => boolean;
}

export function createLlmGate(deps: LlmGateDeps): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, { windowStart: number; count: number }>();
  let warnedEmptyRoster = false;
  return function llmGate(req: Request, res: Response, next: NextFunction): void {
    if (!deps.hasRoster()) {
      if (!warnedEmptyRoster) {
        warnedEmptyRoster = true;
        logEvent({ event: "llm_gate.roster_empty", level: "warn", data: { reason: "名册为空，LLM 代理不校验学号（导入名册后自动生效）" } });
      }
      return next();
    }
    const studentId = req.header("x-student-id") || "";
    if (!studentId) {
      res.status(403).json({ error: "缺少学号标识，请先在插件身份页保存学号后再使用聊天" });
      return;
    }
    if (!deps.isRosterStudent(studentId)) {
      logEvent({ event: "llm_gate.not_in_roster", level: "warn", data: { studentId } });
      res.status(403).json({ error: "学号不在名册中，请核对身份页设置的学号，或联系教员" });
      return;
    }
    const now = Date.now();
    const entry = hits.get(studentId);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      hits.set(studentId, { windowStart: now, count: 1 });
    } else {
      entry.count += 1;
      if (entry.count > MAX_PER_WINDOW) {
        logEvent({ event: "llm_gate.rate_limited", level: "warn", data: { studentId } });
        res.status(429).json({ error: "聊天请求过于频繁，请稍后再试" });
        return;
      }
    }
    next();
  };
}
