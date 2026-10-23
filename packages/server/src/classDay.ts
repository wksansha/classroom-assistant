/** 当天窗口起点：服务器本地时区 00:00（spec dashboard-v2 §4）。
 * 部署要求 TZ=Asia/Shanghai——UTC 服务器上北京时间 16-24 点的课会被归到"昨天" */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
