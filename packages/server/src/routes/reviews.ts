import type { Express } from "express";
import { requestReview, type ReviewRequestDeps } from "../controllers/reviewController";
import { logEvent } from "../logger";

export function registerReviewRoutes(app: Express, deps: ReviewRequestDeps) {
  app.post("/api/reviews/request", async (req, res) => {
    try {
      const r = await requestReview(deps, req.body);
      if (!r.ok) {
        logEvent({ event: "api.review_rejected", level: "warn", data: { error: r.error } });
        return res.status(r.status).json({ error: r.error });
      }
      return res.json({ review: r.review, submissionId: r.submissionId });
    } catch (err) {
      logEvent({ event: "api.review_error", level: "error", data: { error: String(err) } });
      if (res.headersSent) return;
      return res.status(500).json({ error: "服务器内部错误" });
    }
  });
}
