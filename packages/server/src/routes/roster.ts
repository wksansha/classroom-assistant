import type { Express } from "express";
import type { Persistence } from "../persistence";
import { parseRosterText, validateIdentity } from "../controllers/rosterController";
import { logEvent } from "../logger";

export function registerRosterRoutes(app: Express, deps: { persistence: Persistence }) {
  app.post("/api/roster", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const entries = parseRosterText(text);
    if (entries.length === 0) return res.status(400).json({ error: "名册为空或格式无法解析" });
    deps.persistence.replaceRoster(entries);
    logEvent({ event: "api.roster_imported", level: "info", data: { count: entries.length } });
    res.json({ ok: true, count: entries.length });
  });
  app.get("/api/roster", (_req, res) => res.json(deps.persistence.getRoster()));
  app.post("/api/identity/validate", (req, res) => {
    const r = validateIdentity(deps.persistence, req.body ?? {});
    if (!r.ok) return res.status(400).json({ code: r.code, message: r.message });
    res.json({ ok: true, studentName: r.studentName });
  });
}
