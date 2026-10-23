import type { Express } from "express";
import type { RosterEntry } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { parseRosterText, validateIdentity } from "../controllers/rosterController";
import { logEvent } from "../logger";
import type { GiteaAdmin } from "../gitea/adminApi";

/** F1 路径穿越防护：学号格式白名单（字母/数字/下划线/连字符）。Express 会解码 %2F，
 * "..%2Fvictim" 等若放行会拼进 Gitea admin API 路径操作任意账户；四条单条路由共用，不通过 → 400 */
function isValidStudentId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** 逐生建号+协作者+分支保护（异步不阻塞响应；单生失败仅告警，幂等重试）——整体导入与单条新增共用（spec roster §1.2） */
function provisionEntries(persistence: Persistence, gitea: GiteaAdmin, entries: RosterEntry[]): void {
  void (async () => {
    for (const e of entries) {
      try {
        // F4 防重复轮换：已有 gitSecret 的学生跳过建号/改密；gitSecret 生成即入库；协作者授权与分支保护幂等照常执行
        if (persistence.getStudentToken(e.studentId) === null) {
          persistence.saveStudentToken(e.studentId, await gitea.ensureStudentAccount(e.studentId));
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

export function registerRosterRoutes(app: Express, deps: { persistence: Persistence; gitea?: GiteaAdmin | null; onRosterChanged?: () => void }) {
  app.post("/api/roster", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const entries = parseRosterText(text);
    if (entries.length === 0) return res.status(400).json({ error: "名册为空或格式无法解析" });
    deps.persistence.replaceRoster(entries);
    logEvent({ event: "api.roster_imported", level: "info", data: { count: entries.length } });
    deps.onRosterChanged?.();   // 矩阵全班来源刷新（dashboard-v2 spec 决策 #15）
    // 学生分支直连模型：导入成功后逐生建号+分支保护+gitSecret 入库（异步不阻塞响应；单生失败仅警告，幂等重试）
    if (deps.gitea) provisionEntries(deps.persistence, deps.gitea, entries);
    res.json({ ok: true, count: entries.length });
  });
  app.get("/api/roster", (_req, res) => res.json(deps.persistence.getRoster()));
  // —— 单条新增（补录转学生，spec roster §1.1）——
  app.post("/api/roster/entry", (req, res) => {
    const studentId = typeof req.body?.studentId === "string" ? req.body.studentId.trim() : "";
    const studentName = typeof req.body?.studentName === "string" ? req.body.studentName.trim() : "";
    if (!studentId || !studentName) return res.status(400).json({ error: "学号和姓名不能为空" });
    if (!isValidStudentId(studentId)) return res.status(400).json({ error: "invalid studentId" });
    if (deps.persistence.getRosterEntry(studentId)) return res.status(409).json({ error: "该学号已在名册中" });
    deps.persistence.upsertRosterEntry(studentId, studentName);
    logEvent({ event: "api.roster_entry_added", level: "info", data: { studentId } });
    deps.onRosterChanged?.();
    if (deps.gitea) provisionEntries(deps.persistence, deps.gitea, [{ studentId, studentName }]);
    res.json({ ok: true });
  });
  // —— 改姓名（学号是主键不可改，spec roster §1.1）——
  app.patch("/api/roster/entry/:studentId", (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    if (!isValidStudentId(studentId)) return res.status(400).json({ error: "invalid studentId" });
    const studentName = typeof req.body?.studentName === "string" ? req.body.studentName.trim() : "";
    if (!studentName) return res.status(400).json({ error: "姓名不能为空" });
    if (!deps.persistence.updateRosterEntry(studentId, studentName)) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_renamed", level: "info", data: { studentId } });
    res.json({ ok: true, studentId, studentName });
  });
  // —— 软删除：仅移出名册，student_tokens 保留（重新导入无缝复用凭证）——
  app.delete("/api/roster/entry/:studentId", (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    if (!isValidStudentId(studentId)) return res.status(400).json({ error: "invalid studentId" });
    if (!deps.persistence.deleteRosterEntry(studentId)) return res.status(404).json({ error: "该学号不在名册中" });
    logEvent({ event: "api.roster_entry_removed", level: "info", data: { studentId } });
    deps.onRosterChanged?.();
    res.json({ ok: true });
  });
  // —— 硬删除：Gitea 联动彻底清除（删保护→删分支→删账户）+ 名册/token 清除；Gitea 失败则名册不动可重试 ——
  app.post("/api/roster/entry/:studentId/purge", async (req, res) => {
    const studentId = (req.params.studentId ?? "").trim();
    if (!studentId) return res.status(400).json({ error: "缺少学号" });
    if (!isValidStudentId(studentId)) return res.status(400).json({ error: "invalid studentId" });
    // F3 存在性前置校验：名册与 token 均无 → 404，不对不存在目标触发 Gitea 联动删除
    //（软删后仅剩 token 的学号必须仍可 purge，故存在性=名册或 token 任一存在）
    if (deps.persistence.getRosterEntry(studentId) === null && deps.persistence.getStudentToken(studentId) === null) {
      return res.status(404).json({ error: "该学号不存在或已彻底清除" });
    }
    if (deps.gitea) {
      try {
        await deps.gitea.purgeStudent(studentId);
      } catch (err) {
        logEvent({ event: "gitea.purge_failed", level: "warn", data: {
          studentId, error: err instanceof Error ? err.message : String(err),
        } });
        return res.status(502).json({ error: "Gitea 清除失败，名册未变动，可重试" });
      }
    }
    deps.persistence.purgeRosterEntry(studentId);
    logEvent({ event: "api.roster_purged", level: "info", data: { studentId } });
    deps.onRosterChanged?.();
    res.json({ ok: true });
  });
  app.post("/api/identity/validate", (req, res) => {
    const r = validateIdentity(deps.persistence, req.body ?? {});
    if (!r.ok) return res.status(400).json({ code: r.code, message: r.message });
    // 学生分支直连模型：校验通过后下发该生 gitSecret（null=离线/未建号，扩展端自行提示）
    const studentId = ((req.body ?? {}) as { studentId?: string }).studentId?.trim() ?? "";
    const payload: Record<string, unknown> = {
      ok: true,
      studentName: r.studentName,
      gitSecret: deps.persistence.getStudentToken(studentId),
      ...(r.previousIdInRoster !== undefined ? { previousIdInRoster: r.previousIdInRoster } : {}),
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
