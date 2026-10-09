import winston from "winston";

const { combine, timestamp, errors, printf } = winston.format;
// 统一输出风格：`level {"event":...各字段...,"timestamp":...,"service":...}` 单行 JSON
// winston 把对象参数整体放进 message 字段；这里把对象 message 摊平到顶层
const consoleFormat = printf(({ level, message, ...rest }) => {
  const fields = typeof message === "object" && message !== null
    ? { ...(message as Record<string, unknown>), ...rest }
    : { message, ...rest };
  return `${level} ${JSON.stringify(fields)}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { service: "classroom-server" },
  format: combine(errors({ stack: true })),
  transports: [
    new winston.transports.Console({
      format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }), consoleFormat),
    }),
  ],
});

export type LogEvent = {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  data?: Record<string, unknown>;
  durationMs?: number;
};

/**
 * 结构化事件日志的唯一入口：
 * - timestamp / service 由 winston（timestamp 格式 + defaultMeta）统一注入
 * - 事件名最后写入，保证不被 data 里的同名键覆盖
 */
export function logEvent(event: LogEvent): void {
  const { event: eventName, level = "info", data = {}, durationMs } = event;
  logger[level]({
    ...data,
    ...(durationMs !== undefined ? { durationMs } : {}),
    event: eventName,
  });
}
