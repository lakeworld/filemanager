import { describe, it, expect } from 'vitest'
import { fmtLocalTime } from '../../src/renderer/src/utils/datetime'

/**
 * v2.5.8 A3 追加批：详情页时间本地化 util 单测。
 * 本地时区敏感用例用带时区偏移的固定日期构造，避免依赖运行机器时区。
 */
describe('fmtLocalTime', () => {
  it('ISO(UTC) 串 → 本地 YYYY-MM-DD HH:mm:ss（用固定偏移验证换算）', () => {
    // 构造：本地时间 2026-09-05 08:00:00 → UTC ISO，回读应还原同一本地时刻
    const d = new Date(2026, 8, 5, 8, 0, 0)
    expect(fmtLocalTime(d.toISOString())).toBe('2026-09-05 08:00:00')
  })

  it('带毫秒与 Z 后缀的 ISO 正常解析', () => {
    const d = new Date(2026, 0, 2, 23, 4, 5)
    expect(fmtLocalTime(d.toISOString())).toBe('2026-01-02 23:04:05')
  })

  it('workspace formatTime 本地串（YYYY-MM-DD HH:mm:ss）回读值不变', () => {
    expect(fmtLocalTime('2026-08-31 12:34:56')).toBe('2026-08-31 12:34:56')
  })

  it('纯日期串（YYYY-MM-DD）原样保留（Date 按 UTC 解析会换算日界，不冒充本地化）', () => {
    expect(fmtLocalTime('2026-08-31')).toBe('2026-08-31')
  })

  it('不可解析串原样兜底不吞值', () => {
    expect(fmtLocalTime('abc')).toBe('abc')
  })

  it('空值（可选字段/老数据缺键）→ 空串', () => {
    expect(fmtLocalTime(undefined)).toBe('')
    expect(fmtLocalTime(null)).toBe('')
    expect(fmtLocalTime('')).toBe('')
  })
})
