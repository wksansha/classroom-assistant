import type { Request, Response } from "express";
import type { SSEMessage, TeacherSnapshot } from "@classroom/shared";

export interface TeacherHub {
  handleStream(req: Request, res: Response): void;
  publish(snapshot: TeacherSnapshot): void;
  startHeartbeat(): void;
  clientCount(): number;
}

export function createTeacherHub(getSnapshot: () => TeacherSnapshot): TeacherHub {
  const clients = new Set<Response>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function send(res: Response, msg: SSEMessage) {
    try {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  return {
    handleStream(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 连接即推全量快照：中途打开页面/断线重连不缺历史
      send(res, { type: "snapshot", data: getSnapshot() });
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },

    publish(snapshot) {
      // V1：全量重算快照作为 update 推送（20 人规模 <10KB，字段级增量留待性能需要）
      const payload = `data: ${JSON.stringify({ type: "update", data: snapshot })}\n\n`;
      for (const client of clients) {
        try {
          client.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    },

    startHeartbeat() {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        for (const client of clients) {
          try { client.write(": ping\n\n"); } catch { clients.delete(client); }
        }
      }, 25_000);
    },

    clientCount: () => clients.size,
  };
}
