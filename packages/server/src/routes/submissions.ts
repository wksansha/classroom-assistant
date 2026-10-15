import type { Express } from "express";
import type { SSEMessage } from "@classroom/shared";
import type { Persistence } from "../persistence";
import { handleNotify } from "../controllers/notifyController";

export function registerSubmissionRoutes(app: Express, deps: { persistence: Persistence; publish: (msg: SSEMessage) => void }) {
  app.post("/api/submissions/notify", (req, res) => {
    const r = handleNotify(deps, req.body);
    return res.status(r.status).json(r.body);
  });
  app.get("/api/submissions/exercise/:exerciseId", (req, res) =>
    res.json(deps.persistence.getSubmissionsByExercise(req.params.exerciseId)));
  app.get("/api/submissions/student/:studentId", (req, res) =>
    res.json(deps.persistence.getSubmissionsByStudent(req.params.studentId)));
}
