/**
 * 全局唤醒搜索快捷键（v2.5.9 A6-1）——**可 node 直测的纯逻辑**。
 *
 * 不 import electron：真正的 `globalShortcut` 由调用方注入（薄壳在 `src/main/index.ts`），
 * 于是"开关 → 注册/注销/降级"这套判断能在单测里跑全分支，不靠起 Electron。
 * 同款先例：`core/autoLaunch.ts`（纯函数 + 平台薄壳分离）。
 */

/**
 * 唤醒搜索的全局加速键：常量真相在 `shared/appSettings.ts`（设置页展示与主进程注册同读一处），
 * 这里再导出一次只是让"快捷键的纯逻辑"自成一个可直测单元，调用方不必知道它住在 shared。
 */
export { WAKE_SEARCH_ACCELERATOR } from '../../shared/appSettings'
import { WAKE_SEARCH_ACCELERATOR as ACCEL } from '../../shared/appSettings'

/** 注册结果：registered = 已生效；disabled = 用户关着；unsupported = 系统/他人占用导致注册失败（已如实降级） */
export type WakeShortcutStatus = 'registered' | 'disabled' | 'unsupported'

/** 主进程注入的能力（单测里用假实现，生产里是 electron 的 globalShortcut） */
export interface WakeShortcutPort {
  isRegistered: (accel: string) => boolean
  register: (accel: string) => boolean
  unregister: (accel: string) => void
}

/**
 * 把开关状态应用成一次注册/注销动作（幂等）。
 *
 * 为什么不做"注册失败就重试"：全局热键失败几乎都是被别的程序占了，重试只会持续占用 CPU；
 * 而且失败**必须如实回报**（返回 unsupported + 由薄壳写日志），否则设置页会留一个按不动的开关。
 */
export function applyWakeShortcut(enabled: boolean, port: WakeShortcutPort): WakeShortcutStatus {
  if (!enabled) {
    if (port.isRegistered(ACCEL)) port.unregister(ACCEL)
    return 'disabled'
  }
  if (port.isRegistered(ACCEL)) return 'registered'
  return port.register(ACCEL) ? 'registered' : 'unsupported'
}

/**
 * 设置变更时的调和：只有**开关翻转**才动系统注册（开着再保存一次不该注销重注册——
 * 注销/注册之间存在一个"按键失灵"的窗口，且会丢别的程序刚让出来的占用机会）。
 * 返回 null = 本次变更与快捷键无关，调用方什么都不用做。
 */
export function reconcileWakeShortcut(
  prevEnabled: boolean,
  nextEnabled: boolean,
  port: WakeShortcutPort,
): WakeShortcutStatus | null {
  if (prevEnabled === nextEnabled) return null
  return applyWakeShortcut(nextEnabled, port)
}

/**
 * 用户要求开启、但系统层面没注册上 ⇒ 必须把**持久值退回 false**。
 *
 * 为什么这是硬要求而不是"记个日志就行"（v2.5.9/A6-1 验收原句：注册失败要「如实降级」；
 * 评审 Spec 轴抓到本批只留了痕、没降级）：设置页的开关是**受控**的，显示的是磁盘上的值。
 * 不退回，界面就会长期显示"已开启"而系统里什么都没注册——用户按键没反应、又看不到任何异常，
 * 正是本仓最怕的「按不动的开关」。退回后开关自己弹回关，调用方还能据状态说一句"被占用"。
 */
export function shouldRollbackWakeSetting(nextEnabled: boolean, status: WakeShortcutStatus | null): boolean {
  return nextEnabled === true && status === 'unsupported'
}
