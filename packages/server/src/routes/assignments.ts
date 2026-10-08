import type { Express } from "express";
import type { Persistence } from "../persistence";
import type { GitService } from "../gitService";
import type { SyncService } from "../syncService";
import {
  listAssignmentsWithExercises, getAssignmentDetail, buildPublishedList,
  readExerciseContent, publishAssignment,
} from "../controllers/assignmentController";
import { logEvent } from "../logger";

export interface AssignmentRouteDeps {
  persistence: Persistence;
  git: GitService | null;
  repoDir: string;
  sync: SyncService | null;
}

export function registerAssignmentRoutes(app: Express, deps: AssignmentRouteDeps) {
  // 注册顺序敏感：/published 必须先于 /:id（Express 按注册顺序匹配）
  app.get("/api/assignments/published", (_req, res) => res.json(buildPublishedList(deps.persistence)));
  app.get("/api/assignments", (_req, res) => res.json(listAssignmentsWithExercises(deps.persistence)));
  app.get("/api/assignments/:id", (req, res) => {
    const detail = getAssignmentDetail(deps.persistence, req.params.id);
    if (!detail) return res.status(404).json({ error: "作业不存在" });
    res.json(detail);
  });
  app.patch("/api/assignments/:id", (req, res) => {
    const patch = req.body ?? {};
    if (patch.title !== undefined && typeof patch.title !== "string") return res.status(400).json({ error: "title 必须为字符串" });
    if (patch.dueAt !== undefined && patch.dueAt !== null && typeof patch.dueAt !== "number") return res.status(400).json({ error: "dueAt 必须为数字" });
    deps.persistence.updateAssignmentMeta(req.params.id, { title: patch.title, dueAt: patch.dueAt ?? null });
    const detail = getAssignmentDetail(deps.persistence, req.params.id);
    if (!detail) return res.status(404).json({ error: "作业不存在" });
    res.json(detail);
  });
  app.post("/api/assignments/:id/publish", async (req, res) => {
    const publish = req.body?.publish === true;
    const r = await publishAssignment(deps.persistence, deps.git, req.params.id, publish);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    logEvent({ event: "api.publish", level: "info", data: { id: req.params.id, publish } });
    res.json({ ok: true });
  });
  app.get("/api/exercises/:id/content", (req, res) => {
    const r = readExerciseContent(deps.persistence, deps.repoDir, req.params.id);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.setHeader("Content-Type", "text/x-python; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${r.filename}"`);
    res.send(r.content);
  });
  app.post("/api/sync", async (_req, res) => {
    if (!deps.sync) return res.status(503).json({ error: "git 未配置" });
    res.json(await deps.sync.syncNow());
  });
}
