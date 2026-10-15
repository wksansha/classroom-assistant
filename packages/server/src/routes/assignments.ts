import type { Express } from "express";
import type { Persistence } from "../persistence";
import type { SyncService } from "../syncService";
import { listAssignmentsWithExercises, getAssignmentDetail } from "../controllers/assignmentController";

export interface AssignmentRouteDeps {
  persistence: Persistence;
  sync: SyncService | null;
}

export function registerAssignmentRoutes(app: Express, deps: AssignmentRouteDeps) {
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
  app.post("/api/sync", async (_req, res) => {
    if (!deps.sync) return res.status(503).json({ error: "git 未配置" });
    res.json(await deps.sync.syncNow());
  });
}
