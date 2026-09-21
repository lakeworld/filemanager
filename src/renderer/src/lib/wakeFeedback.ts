import { WAKE_SEARCH_ACCELERATOR_LABEL } from '../../../shared/appSettings'
/**
 * 全局唤醒快捷键（v2.5.9/A6-1）的用户侧反馈判据——**纯函数**，可单测。
 *
 * 契约：`appSettings.set` 返回的是主进程**实际持久化后的全量值**（`stores/appSettings` 直接把它
 * 写进信号），而主进程在注册失败时会把 `globalWakeShortcut` 如实退回 false。
 * ⇒ 「我请求开」与「盘上现在是开」这两者不一致，就是"没注册上"的**唯一可信信号**，
 *   不需要新开一条状态广播通道（PLAN 明确不为本键单建广播），也不会出现
 *   "界面说开着、系统里没注册"这种按不动的开关。
 */
export type WakeOutcome = 'occupied' | 'registered'

/**
 * @param requested 用户这一次点下去想要的值（只有 patch 带这个键时才有值）
 * @param effective 写回之后主进程实际生效并持久化的值
 * @returns 'occupied' = 要开却没开上（被占用/系统不支持）；'registered' = 确实开上了；null = 与本题无关
 */
export function wakeOutcome(requested: boolean | undefined, effective: boolean): WakeOutcome | null {
  if (requested !== true) return null // 关它、或本次 patch 不涉及唤醒键
  return requested === effective ? 'registered' : 'occupied'
}

/** 给用户看的那一句（文案住 lib 便于单测钉住，不让它散在 JSX 里） */
export const WAKE_OCCUPIED_HINT = `未能注册：${WAKE_SEARCH_ACCELERATOR_LABEL} 可能已被系统或其它程序占用。开关已保持关闭，释放该组合键后可再试一次。`
