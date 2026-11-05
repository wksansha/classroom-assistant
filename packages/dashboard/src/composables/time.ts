export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtAgo(ts: number | null, now = Date.now()): string {
  if (ts === null || ts <= 0) return "—";   // 0 = 本节课无任何活动信号（纪元时间会产生天文数字）
  const m = Math.floor((now - ts) / 60_000);
  return m < 1 ? "刚刚" : `${m} 分钟前`;
}