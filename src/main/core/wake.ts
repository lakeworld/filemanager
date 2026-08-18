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

// —— v2.5.3 常驻轻壳：Windows WM_POWERBROADCAST 解析 + 唤醒信号去重（T1）——
// Windows 主入口用 BrowserWindow.hookWindowMessage(0x0218) 监听原生 WM_POWERBROADCAST；
// wParam 为 Buffer（native 值，取低 32 位）。同时保留 powerMonitor resume/unlock 交叉信号。
// 纯逻辑模块：不依赖 electron，可 node 直测。

export type PowerBroadcastKind = 'suspend' | 'resume' | 'none'

/** WM_POWERBROADCAST wParam 常量（Microsoft Power.m） */
export const PBT_APMSUSPEND = 0x0004 // 系统即将挂起
export const PBT_APMRESUMESUSPEND = 0x0007 // 从挂起恢复（系统仍挂起态？按文档为恢复信号之一）
export const PBT_APMRESUMEAUTOMATIC = 0x0012 // 从挂起自动恢复（每台机器恢复时均发送）

/**
 * 解析 WM_POWERBROADCAST 的 wParam Buffer → suspend / resume / none。
 * wParam 为 native 值 Buffer（64 位系统取低 32 位）。空/畸形 → none。
 * - PBT_APMSUSPEND(0x4) → suspend
 * - PBT_APMRESUMEAUTOMATIC(0x12) / PBT_APMRESUMESUSPEND(0x7) → resume
 */
export function parsePowerBroadcast(wParam: Buffer): PowerBroadcastKind {
  if (!wParam || wParam.length < 4) return 'none'
  let v: number
  try {
    v = wParam.readUInt32LE(0)
  } catch {
    return 'none'
  }
  if (v === PBT_APMSUSPEND) return 'suspend'
  if (v === PBT_APMRESUMEAUTOMATIC || v === PBT_APMRESUMESUSPEND) return 'resume'
  return 'none'
}

/**
 * 唤醒信号去重闸（同一恢复 generation 内只放行一次 resume 信号）。
 * 背景：Windows 原生广播 + powerMonitor resume/unlock 交叉信号可能对同一次系统唤醒
 * 重复触发；去重保证「同一 generation 只入队一次」，不建立独立定时器。
 * generation 由外部（状态机会话代数）传入；跨代自动重置。
 */
export class WakeSignalGate {
  private currentGen = -1
  private resumeSeen = false

  /** 是否应派发到统一唤醒入口；none 永不放行；同代重复 resume 不放行；suspend 每次放行 */
  shouldDispatch(gen: number, kind: PowerBroadcastKind): boolean {
    if (kind === 'none') return false
    if (gen !== this.currentGen) {
      this.currentGen = gen
      this.resumeSeen = false
    }
    if (kind === 'resume') {
      if (this.resumeSeen) return false
      this.resumeSeen = true
      return true
    }
    return true // suspend
  }

  /** 会话结束（隐藏/退出）时重置，防跨会话误去重 */
  reset(): void {
    this.currentGen = -1
    this.resumeSeen = false
  }
}
