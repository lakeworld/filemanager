import { describe, it, expect } from 'vitest'
import {
  BATCH_LIMIT,
  planBatchPaths,
  summarizeBatchData,
  missingDraftFields,
  mergePickedPaths,
  mergeBatchSummary,
  type BatchDraft,
} from '../../src/renderer/src/pages/invoices/batchIdentify'

/**
 * 发票批量识别纯函数（PLAN 轨 B B4）：paths 构造/结果分类/字段体检，node 直测。
 * 对应插件 com.qihe.cloud v0.4.1 invoice.identifyFiles 契约形状。
 */

describe('planBatchPaths（入参校验 + ≤10 截断）', () => {
  it('12 条 → capped 10 + ignored 2', () => {
    const r = planBatchPaths(Array.from({ length: 12 }, (_, i) => `f${i}`))
    expect(r).toEqual({ ok: true, capped: Array.from({ length: 10 }, (_, i) => `f${i}`), ignored: 2 })
  })

  it('≤10 不截断 → ignored 0', () => {
    const r = planBatchPaths(['a', 'b'])
    expect(r.ok && r.ignored).toBe(0)
    expect(r.ok && r.capped).toEqual(['a', 'b'])
  })

  it('非数组 → 错误（不 throw）', () => {
    const r = planBatchPaths('nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('数组')
  })

  it('含非字符串 / 含空白串 → 错误', () => {
    expect(planBatchPaths([1] as unknown as string[]).ok).toBe(false)
    expect(planBatchPaths(['a', '  ']).ok).toBe(false)
  })
})

describe('summarizeBatchData（结果分类）', () => {
  const result = ({
    fields = {},
    sourcePath = '/tmp/a.pdf',
    warnings = [],
  }: { fields?: Record<string, unknown>; sourcePath?: string; warnings?: string[] } = {}) => ({ fields, sourcePath, warnings })

  it('成功条目归一化进 drafts（含 sourcePath + warnings），failed/ignored 透传', () => {
    const s = summarizeBatchData({
      results: [
        result({ fields: { number: 'A1', amount: 100, seller: '甲方', buyer: '乙方', date: '2026-08-01' }, warnings: ['x'] }),
        result({ fields: { number: 'A2', seller: '甲2' }, sourcePath: '/tmp/b.pdf' }),
      ],
      failed: [{ sourcePath: '/tmp/bad.pdf', error: { code: 'MODEL_ERROR', message: '坏文件' } }],
      ignored: 2,
    })
    expect(s.drafts).toHaveLength(2)
    expect(s.drafts[0].fields.number).toBe('A1')
    expect(s.drafts[0].fields.amount).toBe(100)
    expect(s.drafts[0].sourcePath).toBe('/tmp/a.pdf')
    expect(s.drafts[0].warnings).toEqual(['x'])
    expect(s.failed).toEqual([{ sourcePath: '/tmp/bad.pdf', message: '坏文件' }])
    expect(s.ignored).toBe(2)
  })

  it('sourcePath 空/非串条目跳过；failed 缺 message 兜底', () => {
    const s = summarizeBatchData({
      results: [result({ sourcePath: '' }), result({ sourcePath: 42 as unknown as string })],
      failed: [{ sourcePath: '/tmp/x.pdf', error: {} }],
      ignored: 'nope',
    })
    expect(s.drafts).toHaveLength(0)
    expect(s.failed[0].message).toBe('识别失败')
    expect(s.ignored).toBe(0)
  })

  it('非对象 results/failed / 空 data → 空摘要', () => {
    expect(summarizeBatchData(null)).toEqual({ drafts: [], failed: [], ignored: 0 })
    expect(summarizeBatchData({ results: 'x', failed: null })).toEqual({ drafts: [], failed: [], ignored: 0 })
  })
})

describe('missingDraftFields（建票必填体检）', () => {
  const draft = (fields: Record<string, unknown>): BatchDraft => ({ fields, sourcePath: '/tmp/a.pdf', warnings: [] })

  it('齐全 → 空缺项', () => {
    expect(missingDraftFields(draft({ number: 'A1', amount: 1, seller: '甲', buyer: '乙' }))).toEqual([])
  })

  it('缺号码/金额/开票方/购买方 → 逐个列出', () => {
    const missing = missingDraftFields(draft({ number: '', amount: null, seller: '  ', buyer: undefined }))
    expect(missing).toEqual(['发票号码', '金额', '开票方', '购买方'])
  })
})

describe('BATCH_LIMIT', () => {
  it('= 10（与插件契约一致）', () => {
    expect(BATCH_LIMIT).toBe(10)
  })
})

describe('mergePickedPaths（v2.5.6 选文件去重 + 截断）', () => {
  it('重复路径去重，保序（已有在前）', () => {
    const r = mergePickedPaths(['/a.pdf', '/b.pdf'], ['/b.pdf', '/c.pdf'])
    expect(r).toEqual({ paths: ['/a.pdf', '/b.pdf', '/c.pdf'], overflow: 0 })
  })

  it('合并后超 10 → 截断 + overflow 计数', () => {
    const existing = Array.from({ length: 8 }, (_, i) => `/e${i}`)
    const incoming = Array.from({ length: 5 }, (_, i) => `/n${i}`)
    const r = mergePickedPaths(existing, incoming)
    expect(r.paths).toHaveLength(10)
    expect(r.overflow).toBe(3)
  })

  it('空白串/非字符串/非数组防御跳过', () => {
    expect(mergePickedPaths(['/a'], ['  ', 1 as unknown as string, '/b']).paths).toEqual(['/a', '/b'])
    expect(mergePickedPaths(['/a'], null).paths).toEqual(['/a'])
  })
})

describe('mergeBatchSummary（v2.5.6 暂存区幂等合并）', () => {
  const ok = (p: string): BatchDraft => ({
    fields: { number: 'A1', amount: 1, seller: '甲', buyer: '乙' },
    sourcePath: p,
    warnings: [],
  })

  it('重试成功：替换同路径草稿 + 从失败列表摘掉', () => {
    const prev = { drafts: [ok('/a')], failed: [{ sourcePath: '/b', message: '坏' }], ignored: 0 }
    const next = { drafts: [ok('/b')], failed: [], ignored: 0 }
    const m = mergeBatchSummary(prev, next)
    expect(m.drafts.map((d) => d.sourcePath)).toEqual(['/a', '/b'])
    expect(m.failed).toEqual([])
  })

  it('重试仍失败：更新失败信息；已成功路径不被失败覆盖', () => {
    const prev = { drafts: [ok('/a')], failed: [{ sourcePath: '/b', message: '坏1' }], ignored: 1 }
    const next = { drafts: [], failed: [{ sourcePath: '/b', message: '坏2' }, { sourcePath: '/a', message: '不应出现' }], ignored: 0 }
    const m = mergeBatchSummary(prev, next)
    expect(m.failed).toEqual([{ sourcePath: '/b', message: '坏2' }])
    expect(m.drafts).toHaveLength(1)
    expect(m.ignored).toBe(0)
  })
})
