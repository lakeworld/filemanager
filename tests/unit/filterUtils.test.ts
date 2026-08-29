import { describe, it, expect } from 'vitest'
import {
  filterInvoices,
  filterInbound,
  filterQuotes,
  currentOrphans,
  filterOrphansByQuery,
  inDateRange,
  inAmountRange,
  matchesHasFile,
} from '../../src/renderer/src/pages/invoices/filterUtils'
import type { InvoiceRecord, InboundRecord, QuoteRecord } from '../../src/renderer/src/types'

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

describe('filterQuotes（v2.5.5 打磨：报价筛选对齐发票）', () => {
  const q = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
    quotation_no: 'Q-1',
    date: '2026-08-15',
    total_amount: 100,
    status: '草稿',
    file_path: '报价/2026/Q-1.pdf',
    lines: [],
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
    ...over,
  })

  it('状态 / 客户 过滤', () => {
    const rows = [
      q({ quotation_no: 'Q-1', status: '草稿', customer: '客户甲' }),
      q({ quotation_no: 'Q-2', status: '已确认', customer: '客户乙' }),
    ]
    expect(filterQuotes(rows, { status: '已确认' }).map((r) => r.quotation_no)).toEqual(['Q-2'])
    expect(filterQuotes(rows, { customer: '客户甲' }).map((r) => r.quotation_no)).toEqual(['Q-1'])
  })

  it('搜索命中 单号/客户（不区分大小写）', () => {
    const rows = [
      q({ quotation_no: 'QJ-001', customer: '湖州山水' }),
      q({ quotation_no: 'QJ-002', customer: '上海启禾' }),
    ]
    expect(filterQuotes(rows, { query: 'QJ-00' }).map((r) => r.quotation_no)).toEqual(['QJ-001', 'QJ-002'])
    expect(filterQuotes(rows, { query: '湖州' }).map((r) => r.quotation_no)).toEqual(['QJ-001'])
    expect(filterQuotes(rows, { query: 'zzz' })).toEqual([])
  })

  it('日期区间 / 金额区间（total_amount）/ 有无归档 叠加', () => {
    const rows = [
      q({ quotation_no: 'Q-1', date: '2026-08-01', total_amount: 10, file_path: '报价/2026/Q-1.pdf' }),
      q({ quotation_no: 'Q-2', date: '2026-08-20', total_amount: 200, file_path: '报价/2026/Q-2.pdf' }),
      q({ quotation_no: 'Q-3', date: '2026-09-01', total_amount: 300, file_path: '' }),
    ]
    expect(filterQuotes(rows, { dateFrom: '2026-08-20', dateTo: '2026-09-01' }).map((r) => r.quotation_no)).toEqual(['Q-2', 'Q-3'])
    expect(filterQuotes(rows, { amountMin: 200, amountMax: 300 }).map((r) => r.quotation_no)).toEqual(['Q-2', 'Q-3'])
    expect(filterQuotes(rows, { hasFile: 'no' }).map((r) => r.quotation_no)).toEqual(['Q-3'])
    expect(filterQuotes(rows, { hasFile: 'yes' }).map((r) => r.quotation_no)).toEqual(['Q-1', 'Q-2'])
    // 全条件叠加：8/20 起 + 金额 ≥200 + 有归档 → 仅 Q-2
    expect(filterQuotes(rows, { dateFrom: '2026-08-20', amountMin: 200, hasFile: 'yes' }).map((r) => r.quotation_no)).toEqual(['Q-2'])
  })

  it('无筛选条件 → 原样返回', () => {
    const rows = [q(), q({ quotation_no: 'Q-2' })]
    expect(filterQuotes(rows, {}).map((r) => r.quotation_no)).toEqual(['Q-1', 'Q-2'])
  })
})

describe('区间倒挂归一化（v2.5.7 D2：from>to / min>max 自动交换边界）', () => {
  it('inDateRange：from>to 倒挂与正序等价（[a,b] 与 [b,a] 同一区间）', () => {
    // 边界命中：恰好等于交换后 from/to 都算在内
    expect(inDateRange('2026-08-10', '2026-08-20', '2026-08-10')).toBe(true)
    expect(inDateRange('2026-08-20', '2026-08-20', '2026-08-10')).toBe(true)
    // 区间内
    expect(inDateRange('2026-08-15', '2026-08-20', '2026-08-10')).toBe(true)
    // 区间外
    expect(inDateRange('2026-08-09', '2026-08-20', '2026-08-10')).toBe(false)
    expect(inDateRange('2026-08-21', '2026-08-20', '2026-08-10')).toBe(false)
    // 与正序完全一致
    expect(inDateRange('2026-08-15', '2026-08-10', '2026-08-20')).toBe(inDateRange('2026-08-15', '2026-08-20', '2026-08-10'))
  })

  it('inAmountRange：min>max 倒挂与正序等价', () => {
    // 边界命中
    expect(inAmountRange(10, 20, 10)).toBe(true)
    expect(inAmountRange(20, 20, 10)).toBe(true)
    // 区间内
    expect(inAmountRange(15, 20, 10)).toBe(true)
    // 区间外
    expect(inAmountRange(9, 20, 10)).toBe(false)
    expect(inAmountRange(21, 20, 10)).toBe(false)
    // 与正序完全一致；NaN 仍不命中
    expect(inAmountRange(15, 10, 20)).toBe(inAmountRange(15, 20, 10))
    expect(inAmountRange(NaN, 20, 10)).toBe(false)
  })

  it('单边 / 相等边界不受倒挂逻辑影响', () => {
    // 单边：只有 from 或只有 to（无倒挂触发；边界判定原样）
    expect(inDateRange('2026-08-15', '2026-08-20', undefined)).toBe(false)
    expect(inDateRange('2026-08-25', undefined, '2026-08-20')).toBe(false)
    expect(inDateRange('2026-08-25', '2026-08-20', undefined)).toBe(true)
    expect(inDateRange('2026-08-10', undefined, '2026-08-20')).toBe(true)
    expect(inAmountRange(30, 20, undefined)).toBe(true)
    expect(inAmountRange(10, 20, undefined)).toBe(false)
    // 相等边界（min===max）：倒挂判定不触发
    expect(inDateRange('2026-08-15', '2026-08-15', '2026-08-15')).toBe(true)
    expect(inAmountRange(15, 15, 15)).toBe(true)
    expect(inAmountRange(14, 15, 15)).toBe(false)
  })

  it('组合筛选透传：倒挂日期/金额在 filterInvoices/filterQuotes 中生效', () => {
    const q2 = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
      quotation_no: 'Q-1',
      date: '2026-08-15',
      total_amount: 15,
      status: '草稿',
      file_path: '报价/2026/Q-1.pdf',
      lines: [],
      created_at: '2026-08-15T00:00:00.000Z',
      updated_at: '2026-08-15T00:00:00.000Z',
      ...over,
    })
    const rows = [
      inv({ number: 'D-A', date: '2026-08-10', amount: 10 }),
      inv({ number: 'D-B', date: '2026-08-15', amount: 15 }),
      inv({ number: 'D-C', date: '2026-08-20', amount: 20 }),
    ]
    // 日期倒挂：from=08-20, to=08-10 → 区间 [08-10, 08-20]
    expect(filterInvoices(rows, { dateFrom: '2026-08-20', dateTo: '2026-08-10' }).map((r) => r.number)).toEqual(['D-A', 'D-B', 'D-C'])
    // 金额倒挂：min=20, max=10
    expect(filterInvoices(rows, { amountMin: 20, amountMax: 10 }).map((r) => r.number)).toEqual(['D-A', 'D-B', 'D-C'])
    expect(filterInvoices(rows, { amountMin: 14, amountMax: 16 }).map((r) => r.number)).toEqual(['D-B'])
    expect(filterInvoices(rows, { amountMin: 16, amountMax: 14 }).map((r) => r.number)).toEqual(['D-B'])
    // 报价页同样透传
    const qrows = [q2()]
    expect(filterQuotes(qrows, { dateFrom: '2026-09-01', dateTo: '2026-08-01' }).map((r) => r.quotation_no)).toEqual(['Q-1'])
  })
})
