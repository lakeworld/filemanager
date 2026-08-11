/**
 * 证书到期系统通知（v2.4.0）
 * 本模块为纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 设计：
 * - computeNotifiable：纯函数，从「30 天内到期证书」+「上次通知状态」算出本次应通知列表
 * - 每日去重：userData/notified.json 记录 { date: 'YYYY-MM-DD', keys: [产品集/文件名...] }，
 *   同一天同一证书不重复打扰；次日新状态自动复位，可再次通知
 * - 主进程装配层（index.ts）负责 new Notification 发送与 notified.json 落盘
 *
 * v2.4.7（§6.4）：发票待办并入同一每日去重通道——
 * - computeNotifiable 增参 invoiceTodos（{ number, due_date }），去重 key 带前缀 `发票待办/` 防与证书 key 冲突
 * - invoiceToNotify 与证书 toNotify 一并返回，供装配层合并为一条系统通知
 * - composeDailyNotification：纯函数拼装合并消息体（证书部分文案与 v2.4.2 完全一致，
 *   发票部分为「N 张发票待办，最近 <日期>」；全部为空返回 null 不发通知）
 */
export interface NotifyState {
  /** 通知日期（本地时区 YYYY-MM-DD） */
  date: string
  /** 当日已通知过的 key（证书：产品集/文件名；v2.4.7 起含 发票待办/<号码>） */
  keys: string[]
}

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，跨时区会错日，用本地时间计算） */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** v2.4.7：发票待办（系统通知合并用的轻量形态；由装配层从 dashboard.invoiceTodos() 取数） */
export interface InvoiceTodoItem {
  /** 发票号码（去重主键） */
  number: string
  /** 待办日期（YYYY-MM-DD） */
  due_date: string
  /** 关联客户名（可空） */
  customer?: string
}

export interface NotifiableResult {
  /** 本次应通知的证书（按到期日升序） */
  toNotify: [string, string, string][]
  /** v2.4.7：本次应通知的发票待办（每日去重后，due_date 升序） */
  invoiceToNotify: InvoiceTodoItem[]
  /** 写入 notified.json 的新状态（含本次已通知 keys） */
  nextState: NotifyState
}

/**
 * 计算本次可通知列表（纯函数）：
 * - 仅当 state.date 与「今天」一致时，keys 视为当天已通知（去重）；跨天一律重置
 * - 返回 toNotify / invoiceToNotify（各自未通知过的）+ nextState（当天已通知 keys 全量，供落盘）
 * - v2.4.7：invoiceTodos 并入同一每日去重通道（key 前缀 `发票待办/` 防与证书 key 冲突），
 *   输出按 due_date 升序（最近到期在前，装配层消息体取「最近 <日期>」）
 */
export function computeNotifiable(
  expiring: [string, string, string][],
  state: NotifyState | null,
  now: Date = new Date(),
  invoiceTodos: InvoiceTodoItem[] = [],
): NotifiableResult {
  const date = localDateString(now)
  const notifiedKeys = state && state.date === date ? new Set(state.keys) : new Set<string>()
  const toNotify: [string, string, string][] = []
  const invoiceToNotify: InvoiceTodoItem[] = []
  const keys: string[] = []
  for (const [productSet, fileName, expiry] of expiring) {
    const key = `${productSet}/${fileName}`
    if (notifiedKeys.has(key)) continue
    toNotify.push([productSet, fileName, expiry])
    keys.push(key)
  }
  const sortedTodos = [...invoiceTodos].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
  for (const t of sortedTodos) {
    const key = `发票待办/${t.number}`
    if (notifiedKeys.has(key)) continue
    invoiceToNotify.push(t)
    keys.push(key)
  }
  return { toNotify, invoiceToNotify, nextState: { date, keys: [...notifiedKeys, ...keys] } }
}

/**
 * v2.4.7（§6.4）：合并证书 + 发票待办为一条系统通知消息（纯函数）。
 * - 证书部分文案与 v2.4.2 完全一致（toNotify 按到期日升序，取最早一条聚合）
 * - 发票部分为「N 张发票待办，最近 <日期>」（最近 = 到期日最早的一张）
 * - 仅发票时标题为「发票待办提醒」；有证书时标题保持「证书到期提醒」（证书部分不变）
 * - 全部为空返回 null（调用方不发通知）
 */
export function composeDailyNotification(
  certToNotify: [string, string, string][],
  invoiceToNotify: InvoiceTodoItem[],
): { title: string; body: string } | null {
  if (certToNotify.length === 0 && invoiceToNotify.length === 0) return null
  const lines: string[] = []
  if (certToNotify.length > 0) {
    const [firstPs, firstFile, firstExpiry] = certToNotify[0]
    lines.push(
      certToNotify.length === 1
        ? `产品集「${firstPs}」中 ${firstFile} 将于 ${firstExpiry} 到期，请及时处理`
        : `最早 ${firstPs}/${firstFile} 于 ${firstExpiry} 到期，另有 ${certToNotify.length - 1} 张将在 30 天内到期`,
    )
  }
  if (invoiceToNotify.length > 0) {
    // 防御性按 due_date 升序取「最近（最早）到期」（computeNotifiable 输出已升序，此处对任意调用方入参稳健）
    const earliest = [...invoiceToNotify].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))[0]
    lines.push(`${invoiceToNotify.length} 张发票待办，最近 ${earliest.due_date}`)
  }
  return {
    title: certToNotify.length > 0 ? '证书到期提醒' : '发票待办提醒',
    body: lines.join('\n'),
  }
}
