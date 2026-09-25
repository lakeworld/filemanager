/**
 * 渲染层共享常量（2.6.1/B16 回收站期限上屏）：保留期与剩余天数口径。
 * core 侧权威常量在 src/main/core/trash.ts TRASH_RETENTION_DAYS（cleanupExpired 的默认窗口），
 * 渲染层镜像用（渲染层不能 import core）；同源钉在 tests/unit/trash.test.ts——
 * 改 core 默认值而不同步这里 / 或界面上屏文案改硬编码数字 ⇒ 必红。
 */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 剩余可恢复天数：按「删除时间 + 保留期」算，与 core cleanupExpired 同一把尺子
 * （core：deletedAt + maxDays 天以前 = 过期清理；这里到 0 = 已到期）。
 * 向上取整的剩余整日：刚删除 = 30；跨过 29 天显示 1（不足 1 天按 1 天提示）；
 * 满 30 天起 0 = 到期，下次启动自动清理。删除时间无法解析时按 0（不虚报还有天数）。
 */
export function trashDaysLeft(deletedAt: string, now: number = Date.now()): number {
  const t = new Date(deletedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t + TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS));
}

/** 行内剩余天数文案（唯一出口：空态与行内都从这里取口径，别在组件里再拼一份） */
export function trashDaysLeftLabel(deletedAt: string, now?: number): string {
  const days = trashDaysLeft(deletedAt, now);
  return days > 0 ? `剩余 ${days} 天可恢复` : "已到期，重启后自动清理";
}
