import type { Express } from "express";
import type { Persistence } from "../persistence";
import { parseRosterText, validateIdentity } from "../controllers/rosterController";
import { logEvent } from "../logger";
import type { GiteaAdmin } from "../gitea/adminApi";

export function registerRosterRoutes(app: Express, deps: { persistence: Persistence; gitea?: GiteaAdmin | null }) {
  const gitea = deps.gitea ?? null;
  app.post("/api/roster", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const entries = parseRosterText(text);
    if (entries.length === 0) return res.status(400).json({ error: "名册为空或格式无法解析" });
    deps.persistence.replaceRoster(entries);
    logEvent({ event: "api.roster_imported", level: "info", data: { count: entries.length } });
    // 学生分支直连模型：导入成功后逐生建号+分支保护+token 入库（异步不阻塞响应；单生失败仅警告，幂等重试）
    if (gitea) {
      void (async () => {
        for (const e of entries) {
          try {
            const token = await gitea.ensureStudentAccount(e.studentId);
            await gitea.protectBranch(e.studentId);
            deps.persistence.saveStudentToken(e.studentId, token);
          } catch (err) {
            logEvent({ event: "gitea.provision_failed", level: "warn", data: {
              studentId: e.studentId, error: err instanceof Error ? err.message : String(err),
            } });
          }
        }
      })();
    }
    res.json({ ok: true, count: entries.length });
  });
  app.get("/api/roster", (_req, res) => res.json(deps.persistence.getRoster()));
  app.post("/api/identity/validate", (req, res) => {
    const r = validateIdentity(deps.persistence, req.body ?? {});
    if (!r.ok) return res.status(400).json({ code: r.code, message: r.message });
    // 学生分支直连模型：校验通过后下发该生专属 token（null=离线/未建号，扩展端自行提示）
    const studentId = ((req.body ?? {}) as { studentId?: string }).studentId?.trim() ?? "";
    res.json({ ok: true, studentName: r.studentName, gitToken: deps.persistence.getStudentToken(studentId) });
  });
}
