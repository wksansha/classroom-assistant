import type { Express } from "express";
import type { Persistence } from "../persistence";
import { createSubmission, type SubmissionDeps } from "../controllers/submissionController";
import { logEvent } from "../logger";

export function registerSubmissionRoutes(app: Express, deps: SubmissionDeps & { persistence: Persistence }) {
  app.post("/api/submissions", (req, res) => {
    const r = createSubmission(deps, req.body);
    if (!r.ok) {
      logEvent({ event: "api.submission_rejected", level: "warn", data: { error: r.error } });
      return res.status(r.status).json({ error: r.error });
    }
    return res.status(r.created ? 201 : 200).json({ submission: r.submission });
  });
  app.get("/api/submissions/exercise/:exerciseId", (req, res) =>
    res.json(deps.persistence.getSubmissionsByExercise(req.params.exerciseId)));
  app.get("/api/submissions/student/:studentId", (req, res) =>
    res.json(deps.persistence.getSubmissionsByStudent(req.params.studentId)));
}
