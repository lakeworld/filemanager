import { describe, it, expect } from 'vitest'
import { dateQuickPick, type DateQuickPickMode } from '../../src/renderer/src/lib/dateQuickPicks'

/** 日期快捷项（v2.5.5 打磨）：固定 `2026-08-24` 锚定时刻的确定性断言。 */
const NOW = new Date(2026, 7, 24, 10, 30, 0) // 2026-08-24 10:30

describe('dateQuickPick（日期快捷项）', () => {
  it('today → 当天', () => {
    expect(dateQuickPick('today', NOW)).toBe('2026-08-24')
  })

  it('monthStart → 当月 1 号', () => {
    expect(dateQuickPick('monthStart', NOW)).toBe('2026-08-01')
  })

  it('monthEnd → 当月最后一天（31 天月）', () => {
    expect(dateQuickPick('monthEnd', NOW)).toBe('2026-08-31')
  })

  it('monthEnd 正确处理 30 天月', () => {
    expect(dateQuickPick('monthEnd', new Date(2026, 8, 15))).toBe('2026-09-30')
  })

  it('monthEnd 正确处理闰年二月（2024-02-29）', () => {
    expect(dateQuickPick('monthEnd', new Date(2024, 1, 10))).toBe('2024-02-29')
  })

  it('monthEnd 正确处理平年二月（2026-02-28）', () => {
    expect(dateQuickPick('monthEnd', new Date(2026, 1, 10))).toBe('2026-02-28')
  })

  it('yearStart → 当年 1 月 1 号', () => {
    expect(dateQuickPick('yearStart', NOW)).toBe('2026-01-01')
  })

  it('今年 1 月 1 号那天 yearStart 仍正确', () => {
    expect(dateQuickPick('yearStart', new Date(2026, 0, 1))).toBe('2026-01-01')
  })

  it('时刻/月份单数不影响输出（补零）', () => {
    expect(dateQuickPick('today', new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05')
  })
})
