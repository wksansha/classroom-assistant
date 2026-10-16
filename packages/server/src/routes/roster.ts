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
    // 学生分支直连模型：导入成功后逐生建号+分支保护+gitSecret 入库（异步不阻塞响应；单生失败仅警告，幂等重试）
    if (gitea) {
      void (async () => {
        for (const e of entries) {
          try {
            // F4 防重复轮换：已有 gitSecret 的学生跳过建号/改密（重复导入不再使学生已用密码失效 push 401）；
            // gitSecret 生成即入库（后续步骤失败不丢密码，下次导入自动跳过重建）；协作者授权与分支保护幂等照常执行
            if (deps.persistence.getStudentToken(e.studentId) === null) {
              deps.persistence.saveStudentToken(e.studentId, await gitea.ensureStudentAccount(e.studentId));
            }
            await gitea.addCollaborator(e.studentId);   // write 协作者权限：学生 push 自己分支的前提
            await gitea.protectBranch(e.studentId);
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
    // 学生分支直连模型：校验通过后下发该生 gitSecret（null=离线/未建号，扩展端自行提示）
    const studentId = ((req.body ?? {}) as { studentId?: string }).studentId?.trim() ?? "";
    const payload: Record<string, unknown> = {
      ok: true,
      studentName: r.studentName,
      gitSecret: deps.persistence.getStudentToken(studentId),
    };
    // 学生机零配置：校验通过即下发课堂仓库地址（GITEA_PUBLIC_BASE=学生机可达的 Gitea 地址，
    // 与服务端 GITEA_URL 可不同——服务端走 127.0.0.1，学生走内网 IP；未配置则不下发，扩展端回退设置）
    const base = process.env.GITEA_PUBLIC_BASE;
    if (base && process.env.GITEA_REPO) {
      payload.gitRepoUrl = `${base.replace(/\/+$/, "")}/${process.env.GITEA_REPO}.git`;
    }
    res.json(payload);
  });
}
