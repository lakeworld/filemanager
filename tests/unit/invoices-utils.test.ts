import { describe, it, expect } from 'vitest'
import {
  isDueSoon,
  nextStatusOf,
  statusChipClass,
  toDateKey,
  fmtMoney,
  fileTypeOf,
  baseNameOf,
  STATUSES,
} from '../../src/renderer/src/pages/invoices/utils'

describe('发票台账页 utils（v2.5.1 T3 波1 拆分，D11 例外条款）', () => {
  it('isDueSoon：30 天窗口内提醒、已入账/无日期/坏日期不提醒', () => {
    const now = Date.parse('2026-08-15T00:00:00+08:00')
    expect(isDueSoon({ status: '待报销', due_date: '2026-08-20' } as never, now)).toBe(true)
    expect(isDueSoon({ status: '待报销', due_date: '2026-09-20' } as never, now)).toBe(false)
    expect(isDueSoon({ status: '已入账', due_date: '2026-08-20' } as never, now)).toBe(false)
    expect(isDueSoon({ status: '待报销', due_date: '' } as never, now)).toBe(false)
    expect(isDueSoon({ status: '待报销', due_date: 'bad-date' } as never, now)).toBe(false)
  })

  it('nextStatusOf：顺序流转、末位不变', () => {
    expect(nextStatusOf('待报销')).toBe('已报销')
    expect(nextStatusOf('已报销')).toBe('已入账')
    expect(nextStatusOf('已入账')).toBe('已入账')
    expect(STATUSES).toEqual(['待报销', '已报销', '已入账'])
  })

  it('statusChipClass：语义色映射（T1 收敛）', () => {
    expect(statusChipClass('待报销')).toBe('bg-warning-50 text-warning-700')
    expect(statusChipClass('已报销')).toBe('bg-info-50 text-info-700')
    expect(statusChipClass('已入账')).toBe('bg-success-50 text-success-700')
  })

  it('toDateKey / fmtMoney / fileTypeOf / baseNameOf', () => {
    expect(toDateKey(new Date(2026, 7, 5))).toBe('2026-08-05')
    expect(fmtMoney(1234.5)).toBe('1,234.50')
    expect(fmtMoney(Number.NaN)).toBe('-')
    expect(fileTypeOf('a.jpg')).toBe('image')
    expect(fileTypeOf('b.pdf')).toBe('pdf')
    expect(fileTypeOf('c.mp4')).toBe('video')
    expect(fileTypeOf('d.xlsx')).toBe('other')
    expect(baseNameOf('发票/2026/a.pdf')).toBe('a.pdf')
  })
})
