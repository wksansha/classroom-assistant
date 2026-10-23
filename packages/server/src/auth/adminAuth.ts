/**
 * 管理面鉴权（单密码共享凭证，spec 2026-10-23）：
 * - .env ADMIN_PASSWORD 配置后，/api/roster 全部路由要求 X-Admin-Token 头
 * - timingSafeEqual 恒时比较，防时序侧信道逐位猜密码
 * - 未配置 = 不设防（本地开发兼容），warn 提示；云上部署必须配置
 */
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logEvent } from "../logger";

/** 缺省从环境读取；测试/嵌入方可直接传密码创建 */
export function readAdminPasswordFromEnv(): string {
  return process.env.ADMIN_PASSWORD || "";
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual 长度不等会抛异常；先比长度只泄露"长度"，不泄露内容
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface AdminGuard {
  /** 是否启用了管理鉴权（ADMIN_PASSWORD 非空） */
  enabled: boolean;
  /** 管理 API 门禁：X-Admin-Token 匹配 → next()，否则 401 短路 */
  requireAdmin(req: Request, res: Response, next: NextFunction): void;
  /** GET /api/admin/session：管理页登录门探测（是否受保护 / token 是否有效） */
  sessionHandler(req: Request, res: Response): void;
}

export function createAdminGuard(password: string): AdminGuard {
  const enabled = password.length > 0;
  if (!enabled) {
    logEvent({ event: "admin_auth.disabled", level: "warn", data: { reason: "ADMIN_PASSWORD 未配置，管理接口不设防（公网部署必须配置）" } });
  }
  const tokenOf = (req: Request): string => String(req.header("X-Admin-Token") ?? "");
  return {
    enabled,
    requireAdmin(req, res, next) {
      if (!enabled) return next();
      if (tokenMatches(tokenOf(req), password)) return next();
      logEvent({ event: "admin_auth.denied", level: "warn", data: { path: req.path } });
      res.status(401).json({ error: "unauthorized" });
    },
    sessionHandler(req, res) {
      if (!enabled) {
        res.json({ adminProtected: false });
        return;
      }
      if (tokenMatches(tokenOf(req), password)) {
        res.json({ adminProtected: true, ok: true });
        return;
      }
      res.status(401).json({ error: "unauthorized" });
    },
  };
}
