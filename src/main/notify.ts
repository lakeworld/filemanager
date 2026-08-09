/**
 * 证书到期系统通知（v2.4.0）
 * 本模块为纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 设计：
 * - computeNotifiable：纯函数，从「30 天内到期证书」+「上次通知状态」算出本次应通知列表
 * - 每日去重：userData/notified.json 记录 { date: 'YYYY-MM-DD', keys: [产品集/文件名...] }，
 *   同一天同一证书不重复打扰；次日新状态自动复位，可再次通知
 * - 主进程装配层（index.ts）负责 new Notification 发送与 notified.json 落盘
 */
export interface NotifyState {
  /** 通知日期（本地时区 YYYY-MM-DD） */
  date: string
  /** 当日已通知过的证书 key（产品集/文件名） */
  keys: string[]
}

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，跨时区会错日，用本地时间计算） */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface NotifiableResult {
  /** 本次应通知的证书（按到期日升序） */
  toNotify: [string, string, string][]
  /** 写入 notified.json 的新状态（含本次已通知 keys） */
  nextState: NotifyState
}

/**
 * 计算本次可通知列表（纯函数）：
 * - 仅当 state.date 与「今天」一致时，keys 视为当天已通知（去重）；跨天一律重置
 * - 返回 toNotify（未通知过的）+ nextState（当天已通知 keys 全量，供落盘）
 */
export function computeNotifiable(
  expiring: [string, string, string][],
  state: NotifyState | null,
  now: Date = new Date(),
): NotifiableResult {
  const date = localDateString(now)
  const notifiedKeys = state && state.date === date ? new Set(state.keys) : new Set<string>()
  const toNotify: [string, string, string][] = []
  const keys: string[] = []
  for (const [productSet, fileName, expiry] of expiring) {
    const key = `${productSet}/${fileName}`
    if (notifiedKeys.has(key)) continue
    toNotify.push([productSet, fileName, expiry])
    keys.push(key)
  }
  return { toNotify, nextState: { date, keys: [...notifiedKeys, ...keys] } }
}
