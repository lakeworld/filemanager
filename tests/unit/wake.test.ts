import { describe, it, expect } from 'vitest'
import { isSuspectedWake, parsePowerBroadcast, WakeSignalGate } from '../../src/main/core/wake'

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

/** 构造 wParam Buffer（低 32 位 = value，Windows native 值） */
function wParamBuffer(v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt32LE(v, 0)
  return b
}

describe('parsePowerBroadcast（Windows WM_POWERBROADCAST wParam 解析）', () => {
  it('PBT_APMSUSPEND(0x4) → suspend', () => {
    expect(parsePowerBroadcast(wParamBuffer(0x4))).toBe('suspend')
  })

  it('PBT_APMRESUMEAUTOMATIC(0x12) → resume', () => {
    expect(parsePowerBroadcast(wParamBuffer(0x12))).toBe('resume')
  })

  it('PBT_APMRESUMESUSPEND(0x7) → resume', () => {
    expect(parsePowerBroadcast(wParamBuffer(0x7))).toBe('resume')
  })

  it('其他 wParam / 空 / 畸形 → none', () => {
    expect(parsePowerBroadcast(wParamBuffer(0x0))).toBe('none')
    expect(parsePowerBroadcast(wParamBuffer(0x100))).toBe('none')
    expect(parsePowerBroadcast(Buffer.alloc(0))).toBe('none')
    expect(parsePowerBroadcast(Buffer.alloc(2))).toBe('none')
  })

  it('64 位 Buffer 取低 32 位（高 32 位不影响解析）', () => {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(0x4, 0)
    b.writeUInt32LE(0xffffffff, 4)
    expect(parsePowerBroadcast(b)).toBe('suspend')
  })
})

describe('WakeSignalGate（唤醒信号去重：同一 generation 只放行一次 resume）', () => {
  it('跨代重置：新 generation 后 resume 重新放行', () => {
    const gate = new WakeSignalGate()
    expect(gate.shouldDispatch(1, 'resume')).toBe(true)
    expect(gate.shouldDispatch(1, 'resume')).toBe(false) // 同代重复 → 去重
    expect(gate.shouldDispatch(1, 'none')).toBe(false) // none 永不放行
    expect(gate.shouldDispatch(2, 'resume')).toBe(true) // 新一代 → 放行
  })

  it('suspend 每次放行（记录可见态需即时），resume 同代只一次', () => {
    const gate = new WakeSignalGate()
    expect(gate.shouldDispatch(5, 'suspend')).toBe(true)
    expect(gate.shouldDispatch(5, 'suspend')).toBe(true) // 多次 suspend 都放行
    expect(gate.shouldDispatch(5, 'resume')).toBe(true)
    expect(gate.shouldDispatch(5, 'resume')).toBe(false)
  })

  it('none / 跨代 suspend 正常，reset 清空同代去重态', () => {
    const gate = new WakeSignalGate()
    expect(gate.shouldDispatch(3, 'none')).toBe(false)
    expect(gate.shouldDispatch(3, 'resume')).toBe(true)
    gate.reset()
    expect(gate.shouldDispatch(3, 'resume')).toBe(true) // reset 后同代重新放行
  })
})
