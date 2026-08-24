/**
 * 日期选择器快捷项（v2.5.5 打磨）：纯函数，node 直测。
 * 依当前时刻计算快捷日期 → YYYY-MM-DD（本地时区，与 DatePicker toDateKey 同口径）。
 */
export type DateQuickPickMode = "today" | "monthStart" | "monthEnd" | "yearStart";

/** YYYY-MM-DD（本地时区） */
function toKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateQuickPick(mode: DateQuickPickMode, now: Date): string {
  switch (mode) {
    case "today":
      return toKey(now);
    case "monthStart":
      return toKey(new Date(now.getFullYear(), now.getMonth(), 1));
    case "monthEnd":
      // 下月第 0 天 = 本月最后一天（天然处理 28/29/30/31 与闰年二月）
      return toKey(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    case "yearStart":
      return toKey(new Date(now.getFullYear(), 0, 1));
  }
}
