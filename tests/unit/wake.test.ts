import { describe, it, expect } from 'vitest'
import { isSuspectedWake } from '../../src/main/core/wake'

/**
 * 睡眠唤醒轮询判定（v2.5.2）
 * 背景：Windows 实测 powerMonitor resume/unlock-screen 从不触发（2026-08-16 日志；
 * electron#32576），「窗口可见时睡眠→唤醒白屏」的自愈链无入口。兜底：主进程轮询时钟跳变——
 * 系统睡眠时进程被冻结，唤醒后 Date.now() 突跳（Δ ≫ 轮询间隔）即判定刚经历睡眠。
 * 纯函数判据：Δ 严格大于 间隔 × jumpFactor。
 */
describe('isSuspectedWake（轮询时钟跳变判定）', () => {
  const POLL = 30_000 // 默认轮询间隔 30s

  it('正常轮询间隔（30s）→ 不触发', () => {
    expect(isSuspectedWake(30_000, POLL)).toBe(false)
  })

  it('睡眠 3 分钟（Δ=180s）→ 触发', () => {
    expect(isSuspectedWake(180_000, POLL)).toBe(true)
  })

  it('恰好边界（Δ = 3×间隔）→ 不触发（严格大于）', () => {
    expect(isSuspectedWake(90_000, POLL)).toBe(false)
  })

  it('时间回拨（Δ < 0，系统时间被调前）→ 不触发', () => {
    expect(isSuspectedWake(-5_000, POLL)).toBe(false)
    expect(isSuspectedWake(0, POLL)).toBe(false)
  })

  it('jumpFactor 可配（默认 3）', () => {
    // 间隔 10s、因子 2：Δ=25s 触发，Δ=15s 不触发
    expect(isSuspectedWake(25_000, 10_000, 2)).toBe(true)
    expect(isSuspectedWake(15_000, 10_000, 2)).toBe(false)
    expect(isSuspectedWake(20_000, 10_000, 2)).toBe(false) // 严格大于边界
  })
})
