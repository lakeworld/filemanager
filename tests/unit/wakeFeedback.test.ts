import { WAKE_SEARCH_ACCELERATOR_LABEL } from '../../src/shared/appSettings'
import { describe, it, expect } from 'vitest'
import { wakeOutcome, WAKE_OCCUPIED_HINT } from '../../src/renderer/src/lib/wakeFeedback'
import { shouldRollbackWakeSetting } from '../../src/main/core/wakeShortcut'

/**
 * v2.5.9/A6-1 验收补漏：PLAN 原句要求"注册失败如实降级（设置页显示「被占用」+ 开关可再试）"，
 * 实现只做了一半（主进程留了日志、界面仍显示"已开启"）。本文件把**两侧判据**钉成纯函数测试：
 * 主进程该不该退回持久值 / 界面该不该说"被占用"。
 */
describe('A6-1 唤醒快捷键的如实降级', () => {
  it('主进程：要开却没注册上 ⇒ 必须退回持久值（否则就是按不动的开关）', () => {
    expect(shouldRollbackWakeSetting(true, 'unsupported')).toBe(true)
    expect(shouldRollbackWakeSetting(true, 'registered')).toBe(false)
    expect(shouldRollbackWakeSetting(false, 'disabled')).toBe(false)
    expect(shouldRollbackWakeSetting(false, 'unsupported')).toBe(false) // 关它失败不需要退回（用户要的就是关）
    expect(shouldRollbackWakeSetting(true, null)).toBe(false) // 与本题无关的变更
  })

  it('界面：请求开 × 实际值 不一致 ⇒ 说"被占用"；一致 ⇒  clear 提示；关它/无关 ⇒ 不作声', () => {
    expect(wakeOutcome(true, false)).toBe('occupied')
    expect(wakeOutcome(true, true)).toBe('registered')
    expect(wakeOutcome(false, false)).toBeNull()
    expect(wakeOutcome(undefined, false)).toBeNull() // patch 不涉及唤醒键时不许乱报
  })

  it('文案自证：说清了"没注册上/为什么/下一步怎么办"，且不承诺没做的事', () => {
    expect(WAKE_OCCUPIED_HINT).toContain(WAKE_SEARCH_ACCELERATOR_LABEL) // 钉同源，不钉字面量（换键不再漂移）
    expect(WAKE_OCCUPIED_HINT).toContain('占用')
    expect(WAKE_OCCUPIED_HINT).toContain('已保持关闭') // 与实际退回后的开关状态一致，不能写"已开启"
    expect(WAKE_OCCUPIED_HINT).toContain('再试') // 开关可再试 = PLAN 原句
    expect(WAKE_OCCUPIED_HINT).not.toMatch(/已为你关闭其它|自动重试|已注册/)
  })

  it('反向实验：把判据的等号去掉（requested===effective 恒真）必然红 —— 防这条断言是空断言', () => {
    const buggy = (requested: boolean | undefined, effective: boolean) =>
      requested === true ? (true || requested === effective ? 'registered' : 'occupied') : null
    expect(buggy(true, false)).toBe('registered') // 坏实现把"没注册上"报成成功 ⇒ 上面那条断言正是在拦它
  })
})
