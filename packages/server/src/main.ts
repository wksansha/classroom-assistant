import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "./logger";
import { createApp } from "./index";

const PORT = Number(process.env.PORT) || 3000;
const dist = path.resolve(__dirname, "..", "..", "dashboard", "dist");

// DB_PATH 环境变量真正生效；缺省仍为 server 包下 data/assistant.db
const dbPath = process.env.DB_PATH || undefined;
const { app, hub } = createApp({ dbPath, staticDir: fs.existsSync(dist) ? dist : undefined });
hub.startHeartbeat();

app.listen(PORT, () => {
  const dashboardAvailable = fs.existsSync(dist);
  logEvent({ event: "server.startup", data: {
    port: PORT,
    dashboardAvailable,
    dashboardUrl: dashboardAvailable ? `http://localhost:${PORT}/` : null,
    sseUrl: `http://localhost:${PORT}/api/stream/teacher`,
    dbPath: dbPath ?? path.join(process.cwd(), "data", "assistant.db"),
    logLevel: process.env.LOG_LEVEL ?? "info",
  } });
  console.log(`[Server] AI 助教服务器运行在 http://localhost:${PORT}`);
  console.log(`[Server] SSE: http://localhost:${PORT}/api/stream/teacher`);
  console.log(`[Server] 仪表盘: ${dashboardAvailable ? `http://localhost:${PORT}/` : "未检测到 dashboard/dist（先 pnpm --filter @classroom/dashboard build）"}`);
});