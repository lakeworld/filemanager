/**
 * 详情页时间本地化（v2.5.8 A3 追加批/挂账 W-02）：
 * ISO(UTC) 串（metadata currentTimeString 来源）→ 本地 "YYYY-MM-DD HH:mm:ss"。
 * 兼容历史两种来源——workspace formatTime 本地串经 Date 解析回读值不变；
 * 纯日期串（YYYY-MM-DD）按日期语义原样保留（Date 会按 UTC 解析致日界换算，不冒充本地化）；
 * 空值（可选字段 confirmed_at / 老数据缺键）→ 空串；不可解析串原样兜底不吞值。
 */
export function fmtLocalTime(v: string | undefined | null): string {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
