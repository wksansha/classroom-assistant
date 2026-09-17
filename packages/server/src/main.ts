import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./index";

const PORT = Number(process.env.PORT) || 3000;
const dist = path.resolve(__dirname, "..", "..", "dashboard", "dist");

const { app, hub } = createApp({ staticDir: fs.existsSync(dist) ? dist : undefined });
hub.startHeartbeat();

app.listen(PORT, () => {
  console.log(`[Server] AI 助教服务器运行在 http://localhost:${PORT}`);
  console.log(`[Server] SSE: http://localhost:${PORT}/api/stream/teacher`);
  console.log(`[Server] 仪表盘: ${fs.existsSync(dist) ? `http://localhost:${PORT}/` : "未检测到 dashboard/dist（先 pnpm --filter @classroom/dashboard build）"}`);
});