import { describe, it, expect } from 'vitest'
import {
  filterInvoices,
  filterInbound,
  currentOrphans,
  filterOrphansByQuery,
  inDateRange,
  inAmountRange,
  matchesHasFile,
} from '../../src/renderer/src/pages/invoices/filterUtils'
import type { InvoiceRecord, InboundRecord } from '../../src/renderer/src/types'

function inv(partial: Partial<InvoiceRecord>): InvoiceRecord {
  return {
    number: 'INV',
    date: '2026-08-01',
    amount: 100,
    seller: '开票方',
    buyer: '购买方',
    status: '待报销',
    file_path: '发票/2026/a.pdf',
    created_at: '',
    updated_at: '',
    ...partial,
  }
}

function inb(partial: Partial<InboundRecord>): InboundRecord {
  return {
    id: 'RK-001',
    date: '2026-08-01',
    supplier: '供应商A',
    file_path: '入库/2026/b.pdf',
    created_at: '',
    updated_at: '',
    ...partial,
  }
}

/**
 * 发票/入库筛选纯函数（PLAN-v2.5.5 §一 任务4，B3 任务 C）：
 * 组合筛选（状态/客户/待办/搜索 + 日期范围/金额范围/有无归档文件）+ 孤儿数据注入（未建档）。
 */
describe('发票/入库筛选纯函数（B3 任务 C）', () => {
  it('filterInvoices：状态 + 客户 + 待办 + 搜索组合', () => {
    const rows = [
      inv({ number: 'A1', status: '待报销', customer: '客户X', due_date: '2026-08-20', seller: '开票方甲' }),
      inv({ number: 'B2', status: '已报销', customer: '客户X', buyer: '购方乙' }),
      inv({ number: 'C3', status: '待报销', customer: '客户Y' }),
    ]
    expect(filterInvoices(rows, { status: '待报销' }).map((r) => r.number)).toEqual(['A1', 'C3'])
    expect(filterInvoices(rows, { customer: '客户X' }).map((r) => r.number)).toEqual(['A1', 'B2'])
    expect(filterInvoices(rows, { dueSoonOnly: true }).map((r) => r.number)).toEqual(['A1'])
    // 搜索命中 号码/开票方/购买方（小写包含）
    expect(filterInvoices(rows, { query: '开票方甲' }).map((r) => r.number)).toEqual(['A1'])
    expect(filterInvoices(rows, { query: '购方乙' }).map((r) => r.number)).toEqual(['B2'])
    // 全条件叠加
    expect(filterInvoices(rows, { status: '待报销', customer: '客户X' }).map((r) => r.number)).toEqual(['A1'])
  })

  it('filterInvoices：日期范围（YYYY-MM-DD 字典序含两端）', () => {
    const rows = [
      inv({ number: 'D1', date: '2026-08-01' }),
      inv({ number: 'D2', date: '2026-08-15' }),
      inv({ number: 'D3', date: '2026-09-01' }),
    ]
    expect(filterInvoices(rows, { dateFrom: '2026-08-15', dateTo: '2026-09-01' }).map((r) => r.number)).toEqual(['D2', 'D3'])
    expect(filterInvoices(rows, { dateTo: '2026-08-15' }).map((r) => r.number)).toEqual(['D1', 'D2'])
    expect(filterInvoices(rows, { dateFrom: '2026-09-02' }).map((r) => r.number)).toEqual([])
    expect(inDateRange('2026-08-15', '2026-08-15', '2026-08-15')).toBe(true)
  })

  it('filterInvoices：金额范围（含两端；非有限金额不命中）', () => {
    const rows = [inv({ number: 'M1', amount: 0 }), inv({ number: 'M2', amount: 100 }), inv({ number: 'M3', amount: 500.5 })]
    expect(filterInvoices(rows, { amountMin: 100, amountMax: 500.5 }).map((r) => r.number)).toEqual(['M2', 'M3'])
    expect(filterInvoices(rows, { amountMin: 0, amountMax: 0 }).map((r) => r.number)).toEqual(['M1'])
    expect(inAmountRange(100, 0, 200)).toBe(true)
    expect(inAmountRange(NaN, 0, 200)).toBe(false)
    expect(inAmountRange(300, 0, 200)).toBe(false)
  })

  it('filterInvoices：有无归档文件（file_path 非空 / 空）', () => {
    const rows = [
      inv({ number: 'F1', file_path: '发票/2026/a.pdf' }),
      inv({ number: 'F2', file_path: '' }),
    ]
    expect(filterInvoices(rows, { hasFile: 'yes' }).map((r) => r.number)).toEqual(['F1'])
    expect(filterInvoices(rows, { hasFile: 'no' }).map((r) => r.number)).toEqual(['F2'])
    expect(matchesHasFile('', 'no')).toBe(true)
    expect(matchesHasFile('', 'yes')).toBe(false)
    expect(matchesHasFile('x', undefined)).toBe(true)
  })

  it('filterInbound：日期/金额/归档/搜索组合（无状态客户待办）', () => {
    const rows = [
      inb({ id: 'RK-1', date: '2026-08-01', amount: 10, supplier: '供应商A' }),
      inb({ id: 'RK-2', date: '2026-08-20', amount: 200, supplier: '供应商B' }),
      inb({ id: 'RK-3', date: '2026-09-01', amount: 300, supplier: '供应商A', file_path: '' }),
    ]
    expect(filterInbound(rows, { dateFrom: '2026-08-20', dateTo: '2026-09-01' }).map((r) => r.id)).toEqual(['RK-2', 'RK-3'])
    expect(filterInbound(rows, { amountMin: 200, amountMax: 300 }).map((r) => r.id)).toEqual(['RK-2', 'RK-3'])
    expect(filterInbound(rows, { hasFile: 'no' }).map((r) => r.id)).toEqual(['RK-3'])
    expect(filterInbound(rows, { query: '供应商A' }).map((r) => r.id)).toEqual(['RK-1', 'RK-3'])
    // 金额为空（undefined）的入库单在金额区间过滤下被排除（NaN 不命中）
    expect(filterInbound([inb({ id: 'RK-0', amount: undefined })], { amountMin: 0 })).toEqual([])
  })

  it('currentOrphans：孤儿数据注入——已登记（补建）的退出，未登记的保留', () => {
    const orphans = ['发票/2026/a.pdf', '发票/2026/b.pdf', '发票/2025/old.pdf']
    // 台账已登记 a.pdf → 只保留 b.pdf 与跨年 old.pdf
    expect(currentOrphans(orphans, ['发票/2026/a.pdf'])).toEqual(['发票/2026/b.pdf', '发票/2025/old.pdf'])
    // 全登记 → 空
    expect(currentOrphans(orphans, orphans)).toEqual([])
    // 无登记 → 原样
    expect(currentOrphans(orphans, [])).toEqual(orphans)
  })

  it('filterOrphansByQuery：孤儿文件名/路径字面量搜索', () => {
    const orphans = ['发票/2026/a.pdf', '发票/2025/b.pdf']
    expect(filterOrphansByQuery(orphans, 'a.pdf')).toEqual(['发票/2026/a.pdf'])
    expect(filterOrphansByQuery(orphans, '2025')).toEqual(['发票/2025/b.pdf'])
    expect(filterOrphansByQuery(orphans, '')).toEqual(orphans)
  })
})
