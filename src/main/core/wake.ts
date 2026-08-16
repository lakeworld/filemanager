/**
 * 睡眠唤醒轮询判定（v2.5.2）
 * 背景：Windows 实测 powerMonitor resume/unlock-screen 从不触发（2026-08-16 用户日志；
 * electron#32576「Win11 suspend/resume 不触发」同症），「窗口可见时睡眠→唤醒白屏」的
 * 既有自愈链（window.ts recoverAfterWake）失去唯一入口。兜底：主进程轮询时钟跳变——
 * 系统睡眠时进程被冻结，唤醒后 Date.now() 突跳（Δ ≫ 轮询间隔）即判定刚经历睡眠，
 * 复用同一自愈链（L1 invalidate → 复检 → L2/L3/L4），不依赖 WMI 事件。
 *
 * 纯逻辑模块：不依赖 electron，可 node 直测（tests/unit/wake.test.ts）。
 */

/**
 * 是否判定为「刚经历系统睡眠」：Δ 严格大于 轮询间隔 × jumpFactor。
 * - 正常轮询偏差（调度抖动/系统时钟源同步）远小于 间隔×3，不会误触发；
 * - 严格大于：恰好 3×（如 90s 整）不判定，避免边界抖动；
 * - Δ < 0（系统时间被手动调前）不判定；
 * - jumpFactor 可配（默认 3），供环境/测试收紧或放宽。
 */
export function isSuspectedWake(deltaMs: number, pollIntervalMs: number, jumpFactor = 3): boolean {
  return deltaMs > pollIntervalMs * jumpFactor
}
