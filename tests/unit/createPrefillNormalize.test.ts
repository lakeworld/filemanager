/**
 * createPrefillNormalize 单测（PLAN-v2.5.4 §4.1）。
 * 全业务 6 实体预填载荷归一化：已知键通过 / 未知键忽略 / trim / 枚举与类型校验 /
 * 批量上限 50 / 自然键去重。纯模块，不依赖 electron。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizePrefill,
  normalizePrefillBatch,
  normalizeEditPrefill,
  EDIT_NATURAL_KEY,
  PREFILL_BATCH_CAP,
  type CustomerPrefill,
  type InvoicePrefill,
  type QuotePrefill,
} from '../../src/renderer/src/stores/createPrefillNormalize'

describe('normalizePrefill: customer', () => {
  it('全字段通过', () => {
    const out = normalizePrefill('customer', {
      name: '张三贸易', alias: '张三', country: '中国', contact: '张三', source: '展会',
      type: '企业', phone: '13800000000', email: 'a@b.com', address: '上海',
      tags: ['重点', ' 老客户 '], notes: '备注', related_product_sets: ['套装A'],
    }) as CustomerPrefill
    expect(out).toEqual({
      name: '张三贸易', alias: '张三', country: '中国', contact: '张三', source: '展会',
      type: '企业', phone: '13800000000', email: 'a@b.com', address: '上海',
      tags: ['重点', '老客户'], notes: '备注', related_product_sets: ['套装A'],
    })
  })

  it('type 枚举：企业/个人保留，其他丢弃', () => {
    expect((normalizePrefill('customer', { name: 'a', type: '个人' }) as CustomerPrefill).type).toBe('个人')
    expect((normalizePrefill('customer', { name: 'a', type: '公司' }) as CustomerPrefill).type).toBeUndefined()
    expect((normalizePrefill('customer', { name: 'a', type: 123 }) as CustomerPrefill).type).toBeUndefined()
  })

  it('未知键忽略；字符串 trim；空串字段丢弃', () => {
    const out = normalizePrefill('customer', {
      name: '  张三  ', phone: '   ', hacker: 'x', email: 42,
    }) as CustomerPrefill
    expect(out.name).toBe('张三')
    expect(out.phone).toBeUndefined()
    expect(out.email).toBeUndefined()
    expect('hacker' in out).toBe(false)
  })

  it('tags/related_product_sets：只收数组、非字符串与空元素丢弃', () => {
    const out = normalizePrefill('customer', {
      name: 'a', tags: ['x', '', '  ', 1, null, ' y '], related_product_sets: 'not-array',
    }) as CustomerPrefill
    expect(out.tags).toEqual(['x', 'y'])
    expect(out.related_product_sets).toBeUndefined()
  })

  it('非对象输入返回空对象', () => {
    expect(normalizePrefill('customer', null)).toEqual({})
    expect(normalizePrefill('customer', 'str')).toEqual({})
    expect(normalizePrefill('customer', [1, 2])).toEqual({})
  })
})

describe('normalizePrefill: 其余实体', () => {
  it('productSet：name/tags/notes', () => {
    expect(normalizePrefill('productSet', { name: ' 套装 ', tags: ['t'], notes: 'n', extra: 1 })).toEqual({
      name: '套装', tags: ['t'], notes: 'n',
    })
  })

  it('supplier：全字段', () => {
    expect(normalizePrefill('supplier', {
      name: '供应商A', contact: '李四', phone: '139', email: 's@b.com', address: '广州',
      notes: 'n', tags: ['t'], related_product_sets: ['套装A'], bogus: true,
    })).toEqual({
      name: '供应商A', contact: '李四', phone: '139', email: 's@b.com', address: '广州',
      notes: 'n', tags: ['t'], related_product_sets: ['套装A'],
    })
  })

  it('quote：lines 非对象行丢弃、对象行非法键丢键、数值字符串转换', () => {
    const out = normalizePrefill('quote', {
      quotation_no: ' Q-001 ', date: '2026-08-20', customer: '张三贸易',
      lines: [
        { product: '毛巾', sku: 'T-1', qty: '2', unit_price: '9.9' },
        'junk',
        { product: '', qty: 'abc' },
        null,
      ],
      notes: 'n', file_path: '报价/2026/a.pdf', extra: 'x',
    }) as QuotePrefill
    expect(out.quotation_no).toBe('Q-001')
    expect(out.lines).toEqual([
      { product: '毛巾', sku: 'T-1', qty: 2, unit_price: 9.9 },
      {},
    ])
    expect('extra' in out).toBe(false)
  })

  it('invoice：amount 数值化、status 不在预填面', () => {
    const out = normalizePrefill('invoice', {
      number: ' INV-1 ', code: '011', date: '2026-08-20', amount: '123.45',
      seller: '销方', buyer: '购方', customer: '张三贸易', due_date: '2026-09-01',
      file_path: '发票/2026/x.pdf', tags: ['t'], notes: 'n', status: '已报销',
    }) as InvoicePrefill
    expect(out.number).toBe('INV-1')
    expect(out.amount).toBe(123.45)
    expect('status' in out).toBe(false)
    expect((normalizePrefill('invoice', { amount: 'abc' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: 0 }) as InvoicePrefill).amount).toBe(0)
  })

  it('inbound：全字段', () => {
    expect(normalizePrefill('inbound', {
      id: ' RK-1 ', date: '2026-08-20', supplier: '供应商A', supplier_id: '供应商A',
      product_set: '套装A', amount: '88', notes: 'n', file_path: '入库/2026/x.jpg',
    })).toEqual({
      id: 'RK-1', date: '2026-08-20', supplier: '供应商A', supplier_id: '供应商A',
      product_set: '套装A', amount: 88, notes: 'n', file_path: '入库/2026/x.jpg',
    })
  })

  it('非法 entity 抛 TypeError（编程错误早暴露）', () => {
    expect(() => normalizePrefill('bogus' as never, {})).toThrow(TypeError)
  })
})

describe('normalizePrefillBatch', () => {
  it('非数组输入包装为单条', () => {
    const out = normalizePrefillBatch('customer', { name: 'a' })
    expect(out).toEqual([{ name: 'a' }])
  })

  it('非对象条目跳过', () => {
    const out = normalizePrefillBatch('customer', [null, 'x', { name: 'a' }, 42])
    expect(out).toEqual([{ name: 'a' }])
  })

  it(`单批超 ${PREFILL_BATCH_CAP} 截断`, () => {
    const input = Array.from({ length: PREFILL_BATCH_CAP + 10 }, (_, i) => ({ name: `c${i}` }))
    const out = normalizePrefillBatch('customer', input)
    expect(out).toHaveLength(PREFILL_BATCH_CAP)
  })

  it('自然键去重：保留先出现者；缺键条目保留', () => {
    const out = normalizePrefillBatch('customer', [
      { name: 'a', contact: 'first' },
      { name: ' b ' },
      { name: 'a', contact: 'second' },
      { contact: 'no-name' },
      { name: 'b' },
    ])
    expect(out).toEqual([
      { name: 'a', contact: 'first' },
      { name: 'b' },
      { contact: 'no-name' },
    ])
  })

  it('自然键按实体区分：invoice=number / inbound=id / quote=quotation_no', () => {
    expect(normalizePrefillBatch('invoice', [{ number: 'n1' }, { number: 'n1' }, { number: 'n2' }])).toHaveLength(2)
    expect(normalizePrefillBatch('inbound', [{ id: 'r1' }, { id: 'r1' }])).toHaveLength(1)
    expect(normalizePrefillBatch('quote', [{ quotation_no: 'q1' }, { quotation_no: 'q1' }])).toHaveLength(1)
  })

  it('空数组返回空数组', () => {
    expect(normalizePrefillBatch('customer', [])).toEqual([])
  })
})

// —— v2.5.4（弹一 C-6）：编辑预填归一化（单条制；建议改动；未知键忽略；非法 entity 抛错）——
describe('normalizeEditPrefill（v2.5.4 C-6）', () => {
  it('单条归一化：已知键通过 + trim + 未知键忽略（与 create 同 schema）', () => {
    expect(normalizeEditPrefill('customer', { contact: ' 新联系人 ', phone: '138', bogus: 1 })).toEqual({
      contact: '新联系人',
      phone: '138',
    })
  })

  it('可含自然键（编辑建议改动可覆盖 name/number 等）或不含（仅改其他字段）', () => {
    expect(normalizeEditPrefill('quote', { quotation_no: 'BJ-9', notes: '改备注' })).toEqual({
      quotation_no: 'BJ-9',
      notes: '改备注',
    })
    expect(normalizeEditPrefill('supplier', { address: '深圳' })).toEqual({ address: '深圳' })
  })

  it('非法 entity 抛 TypeError（编辑预填不静默）', () => {
    expect(() => normalizeEditPrefill('nope' as never, { name: 'x' })).toThrow(TypeError)
  })

  it('非对象输入 → 空建议（无字段覆盖）', () => {
    expect(normalizeEditPrefill('invoice', 'x')).toEqual({})
    expect(normalizeEditPrefill('invoice', null)).toEqual({})
  })

  it('EDIT_NATURAL_KEY 映射与 create 一致（customer/supplier=name、quote=quotation_no、invoice=number、inbound=id）', () => {
    expect(EDIT_NATURAL_KEY.customer).toBe('name')
    expect(EDIT_NATURAL_KEY.quote).toBe('quotation_no')
    expect(EDIT_NATURAL_KEY.invoice).toBe('number')
    expect(EDIT_NATURAL_KEY.inbound).toBe('id')
    expect(EDIT_NATURAL_KEY.productSet).toBe('name')
  })
})
