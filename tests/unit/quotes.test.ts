/**
 * 报价单服务单测（v2.4.9 S3，对齐客迹 keji Quotation）
 * 覆盖（brief §八 11 组）：
 * 1. quotation_no 自动生成：QT-YYYYMMDD-序号 同日自增（001→002）、max+1、999 进位 4 位、冲突跳过（注入 store 测边界）
 * 2. 手输覆盖：合法 → 保存；与既有重名 → 拒绝；checkNumber 同发票口径
 * 3. 明细行校验：lines 空拒绝；qty<1 拒绝；unit_price<0 拒绝；日期严格 YYYY-MM-DD
 * 4. 金额一致性：amount = round2(qty×unit_price)、total_amount = round2(Σ)（round2 后相等断言）；外部注入不一致拒绝
 * 5. 状态机矩阵：草稿→已确认（写 confirmed_at）/已确认→修订中/修订中→草稿/修订中→已确认（刷新）；已确认→草稿 拒绝；已确认时 update lines 拒绝
 * 6. date 落 报价/<YYYY>/ 归档（年份取 date；冲突加序号；file_path 区属校验）
 * 7. 客户 rename → 报价 customer 级联更新（BoxService.renameCustomer 编排：clients 与 quotes 同步）
 * 8. 客户删除 → 报价记录保留字面值（不删记录不报错）
 * 9. quote_ext 读取保留（API 面不含入参——类型层面保证；运行时传入被拒）
 * 10. 区域判别：interpretMetadataKeyRegion(ws, '报价/2026/xxx.pdf') → 'quote'
 * 11. Logger 注入断言：create/setStatus 调用 logger.info
 */
import { describe, it, expect, vi } from 'vitest'
import { buildTestBox } from './helpers'
import { WorkspaceService } from '../../src/main/core/workspace'
import { QuotesService, nextQuotationNo, round2 } from '../../src/main/core/quotes'
import { MemoryLogger } from '../../src/main/core/logger'
import { interpretMetadataKeyRegion } from '../../src/main/core/metadata'
import type { QuoteRecord } from '../../src/main/core/quotes'
import type { QuoteLine } from '../../src/shared/types'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-'))
}

async function writeFile(p: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

async function readQuotesStore(ws: string): Promise<{ quotes: Record<string, QuoteRecord> }> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', '报价.json'), 'utf-8'))
}

/** 明细行构造（amount 按 round2(qty×unit_price) 计算——写入时同法） */
function line(qty: number, unitPrice: number, over: Partial<Omit<QuoteLine, 'qty' | 'unit_price' | 'amount'>> = {}): QuoteLine {
  return { product: '品A', qty, unit_price: unitPrice, amount: round2(qty * unitPrice), ...over }
}

/** 最小合法记录（nextQuotationNo 注入 store 用；字段取合法默认值） */
function stub(no: string): QuoteRecord {
  return {
    quotation_no: no,
    date: '2026-08-11',
    lines: [{ product: 'x', qty: 1, unit_price: 1, amount: 1 }],
    total_amount: 1,
    status: '草稿',
    file_path: '',
    created_at: '',
    updated_at: '',
  }
}

describe('报价单服务（v2.4.9 S3）', () => {
  it('单号自动生成：QT-YYYYMMDD-序号 同日自增、max+1、999 进位 4 位、冲突跳过', async () => {
    // —— nextQuotationNo 纯函数（注入 store 测边界）——
    expect(nextQuotationNo({ quotes: {} }, '2026-08-11')).toBe('QT-20260811-001')
    expect(nextQuotationNo({ quotes: { 'QT-20260811-001': stub('QT-20260811-001') } }, '2026-08-11')).toBe('QT-20260811-002')
    // max+1（中间空号不补）
    expect(
      nextQuotationNo(
        { quotes: { 'QT-20260811-001': stub('QT-20260811-001'), 'QT-20260811-003': stub('QT-20260811-003') } },
        '2026-08-11',
      ),
    ).toBe('QT-20260811-004')
    // 999 进位 4 位继续（不截断不拒绝）
    expect(nextQuotationNo({ quotes: { 'QT-20260811-999': stub('QT-20260811-999') } }, '2026-08-11')).toBe('QT-20260811-1000')
    // 按日期分组：跨日互不影响
    expect(nextQuotationNo({ quotes: { 'QT-20260811-001': stub('QT-20260811-001') } }, '2026-08-12')).toBe('QT-20260812-001')
    // 手输占用序号 → 自动生成跳过（冲突 +1）
    expect(
      nextQuotationNo(
        { quotes: { 'QT-20260811-001': stub('QT-20260811-001'), 'QT-20260811-002': stub('QT-20260811-002') } },
        '2026-08-11',
      ),
    ).toBe('QT-20260811-003')

    // —— 服务层连续创建自增 ——
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const a = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)] })
    const b = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)] })
    expect(a.quotation_no).toBe('QT-20260811-001')
    expect(b.quotation_no).toBe('QT-20260811-002')
  })

  it('手输覆盖：合法 → 保存；与既有重名 → 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await box.quotes.create({ quotation_no: 'QT-20260811-001', date: '2026-08-11', lines: [line(1, 100)] })
    expect(rec.quotation_no).toBe('QT-20260811-001')
    // 与既有重名 → 拒绝
    await expect(
      box.quotes.create({ quotation_no: 'QT-20260811-001', date: '2026-08-11', lines: [line(1, 100)] }),
    ).rejects.toThrow('已存在')
    // 手输后自动生成继续递增（不撞手输单号）
    const b = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)] })
    expect(b.quotation_no).toBe('QT-20260811-002')
    // checkNumber 同发票口径：命中返回记录、排除自身、未命中 null
    expect(await box.quotes.checkNumber('QT-20260811-001')).not.toBeNull()
    expect(await box.quotes.checkNumber('QT-20260811-001', 'QT-20260811-001')).toBeNull()
    expect(await box.quotes.checkNumber('NOPE')).toBeNull()
  })

  it('明细行校验：lines 空拒绝；qty<1 拒绝；unit_price<0 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await expect(box.quotes.create({ date: '2026-08-11', lines: [] })).rejects.toThrow('报价明细不能为空')
    await expect(box.quotes.create({ date: '2026-08-11', lines: [line(0, 100)] })).rejects.toThrow('数量无效')
    await expect(box.quotes.create({ date: '2026-08-11', lines: [line(1, -0.01)] })).rejects.toThrow('单价无效')
    // 缺品名拒绝
    await expect(box.quotes.create({ date: '2026-08-11', lines: [{ product: '  ', qty: 1, unit_price: 10, amount: 10 }] })).rejects.toThrow(
      '品名',
    )
    // 日期严格 YYYY-MM-DD 格式 + 日历合法性
    await expect(box.quotes.create({ date: '2026/08/11', lines: [line(1, 10)] })).rejects.toThrow('报价日期无效')
    await expect(box.quotes.create({ date: '2026-02-30', lines: [line(1, 10)] })).rejects.toThrow('报价日期无效')
  })

  it('金额一致性：amount/total_amount 写入时 round2 计算；外部注入不一致拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 浮点陷阱：3 × 0.1 = 0.30000000000000004 → round2 后 0.3（断言 round2 后相等）
    const rec = await box.quotes.create({
      date: '2026-08-11',
      lines: [{ product: 'A', qty: 3, unit_price: 0.1, amount: 0.3 }],
    })
    expect(rec.lines[0].amount).toBe(0.3)
    expect(round2(rec.lines[0].amount)).toBe(round2(3 * 0.1))
    expect(rec.total_amount).toBe(0.3)
    expect(round2(rec.total_amount)).toBe(round2(rec.lines.reduce((s, l) => s + l.amount, 0)))

    // 多行合计
    const rec2 = await box.quotes.create({
      date: '2026-08-11',
      lines: [
        { product: 'A', qty: 1, unit_price: 10.5, amount: 10.5 },
        { product: 'B', qty: 2, unit_price: 3.25, amount: 6.5 },
      ],
    })
    expect(rec2.total_amount).toBe(17) // 10.5 + 6.5

    // 外部注入不一致 amount → 拒绝
    await expect(
      box.quotes.create({ date: '2026-08-11', lines: [{ product: 'A', qty: 2, unit_price: 10, amount: 999 }] }),
    ).rejects.toThrow('不一致')
    await expect(
      box.quotes.create({ date: '2026-08-11', lines: [{ product: 'A', qty: 2, unit_price: 10, amount: 20.5 }] }),
    ).rejects.toThrow('不一致')
    await expect(
      box.quotes.create({ date: '2026-08-11', lines: [{ product: 'A', qty: 2, unit_price: 10, amount: Number.NaN }] }),
    ).rejects.toThrow('不一致')

    // sku 保留、品名 trim
    const rec3 = await box.quotes.create({
      date: '2026-08-11',
      lines: [{ product: ' 品C ', sku: 'SKU-1', qty: 1, unit_price: 10, amount: 10 }],
    })
    expect(rec3.lines[0].product).toBe('品C')
    expect(rec3.lines[0].sku).toBe('SKU-1')
  })

  it('状态机矩阵：草稿→已确认（写 confirmed_at）/已确认→修订中/修订中→草稿/修订中→已确认（刷新）；已确认→草稿 拒绝；已确认 update lines 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const rec = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)] })
    expect(rec.status).toBe('草稿')
    expect(rec.confirmed_at).toBeUndefined()

    vi.useFakeTimers()
    try {
      // 草稿→已确认：写入 confirmed_at
      vi.setSystemTime(new Date('2026-08-11T10:00:00.000Z'))
      const confirmed = await box.quotes.setStatus(rec.quotation_no, '已确认')
      expect(confirmed.status).toBe('已确认')
      expect(confirmed.confirmed_at).toBe('2026-08-11T10:00:00.000Z')

      // 已确认→草稿 拒绝（须先转修订中）
      await expect(box.quotes.setStatus(rec.quotation_no, '草稿')).rejects.toThrow('不允许')
      // 已确认→修订中（回退纠错）
      await box.quotes.setStatus(rec.quotation_no, '修订中')
      // 修订中→草稿（重新草稿）
      await box.quotes.setStatus(rec.quotation_no, '草稿')
      expect((await box.quotes.get(rec.quotation_no))?.status).toBe('草稿')

      // 修订中→已确认（重确认，刷新 confirmed_at）
      vi.setSystemTime(new Date('2026-08-11T11:00:00.000Z'))
      await box.quotes.setStatus(rec.quotation_no, '已确认')
      vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'))
      await box.quotes.setStatus(rec.quotation_no, '修订中')
      vi.setSystemTime(new Date('2026-08-11T13:00:00.000Z'))
      const reconfirmed = await box.quotes.setStatus(rec.quotation_no, '已确认')
      expect(reconfirmed.confirmed_at).toBe('2026-08-11T13:00:00.000Z')
      expect(reconfirmed.confirmed_at).not.toBe(confirmed.confirmed_at)

      // 已确认时 update lines 拒绝（明细锁定）
      await expect(box.quotes.update({ quotation_no: rec.quotation_no, lines: [line(2, 100)] })).rejects.toThrow('锁定')
      // 已确认时 update 其他字段放行
      const ok = await box.quotes.update({ quotation_no: rec.quotation_no, notes: '备注' })
      expect(ok.notes).toBe('备注')
      // 同状态流转拒绝（矩阵对角线 —）
      await expect(box.quotes.setStatus(rec.quotation_no, '已确认')).rejects.toThrow('不允许')
    } finally {
      vi.useRealTimers()
    }
    // 非法枚举 / 不存在
    await expect(box.quotes.setStatus(rec.quotation_no, '非法' as never)).rejects.toThrow('状态无效')
    await expect(box.quotes.setStatus('NOPE', '已确认')).rejects.toThrow('不存在')
  })

  it('归档：date 年份落 报价/<YYYY>/；命名模板 + 冲突序号；file_path 区属校验', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const src = path.join(ws, 'q.pdf')
    await writeFile(src, 'pdf')
    const rel1 = await box.quotes.archiveFile(src, '2026-08-11')
    expect(rel1).toBe('报价/2026/q.pdf')
    const rel2 = await box.quotes.archiveFile(src, '2026-08-11')
    expect(rel2).toBe('报价/2026/q_1.pdf')
    await expect(fsp.stat(path.join(ws, rel1))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, rel2))).resolves.toBeTruthy()
    // 年份取 date：跨年归档
    const rel3 = await box.quotes.archiveFile(src, '2027-01-01')
    expect(rel3).toBe('报价/2027/q.pdf')
    // 工作区外源文件（UI 选本地文件场景）
    const outside = await tmp()
    const srcOut = path.join(outside, '外.pdf')
    await writeFile(srcOut, 'x')
    expect(await box.quotes.archiveFile(srcOut, '2026-08-11')).toBe('报价/2026/外.pdf')
    // 非法日期归档拒绝
    await expect(box.quotes.archiveFile(src, 'bad-date')).rejects.toThrow('报价日期无效')

    // create 带归档文件 → resolveArchivedFilePath 校验（相对/绝对路径均可）
    const rec = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], file_path: rel1 })
    expect(rec.file_path).toBe(rel1)
    const recAbs = await box.quotes.create({
      quotation_no: 'QT-20260811-003',
      date: '2026-08-11',
      lines: [line(1, 100)],
      file_path: path.join(ws, rel2),
    })
    expect(recAbs.file_path).toBe(rel2)
    // 报价区外路径 → 拒绝
    const psFile = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    await writeFile(psFile)
    await expect(box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], file_path: psFile })).rejects.toThrow(
      '必须归档在 报价/ 目录下',
    )
    // 文件不存在 → 拒绝
    await expect(
      box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], file_path: '报价/2026/nope.pdf' }),
    ).rejects.toThrow('不存在')
  })

  it('客户 rename → 报价 customer 级联更新（BoxService.renameCustomer 编排：clients 与 quotes 同步）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    const rec = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], customer: '张三' })

    await box.renameCustomer('张三', '李四')
    expect((await box.quotes.get(rec.quotation_no))?.customer).toBe('李四')
    // clients 侧同步（目录迁移 + 档案 key 迁移）
    expect((await box.clients.list()).map((c) => c.name)).toEqual(['李四'])
    // 无关记录不受影响（幂等）
    const rec2 = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], customer: '王五' })
    await box.renameCustomer('李四', '赵六')
    expect((await box.quotes.get(rec2.quotation_no))?.customer).toBe('王五')
  })

  it('客户删除 → 报价记录保留字面值（不删记录不报错）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    const rec = await box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], customer: '张三' })

    // 删除进回收站
    await box.deleteCustomer('张三')
    expect((await box.quotes.get(rec.quotation_no))?.customer).toBe('张三')
    expect(await box.quotes.list()).toHaveLength(1)
    // 彻底删除（purge）后报价记录仍在（字面值保留，UI 灰显是 S3b 的事）
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('customer')
    await box.trash.purge(entries[0].id)
    expect((await box.quotes.get(rec.quotation_no))?.customer).toBe('张三')
    expect(await box.quotes.list()).toHaveLength(1)
  })

  it('quote_ext 只读保留：API 面不含入参（类型层面保证）；运行时传入被拒；既有值 update 保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 运行时传入 quote_ext（TS 类型已禁止，JS 层防御）→ 拒绝
    await expect(
      box.quotes.create({ date: '2026-08-11', lines: [line(1, 100)], quote_ext: { confirmed_by: 'x' } } as never),
    ).rejects.toThrow('quote_ext')
    await expect(
      box.quotes.update({ quotation_no: 'QT-20260811-001', quote_ext: { a: 1 } } as never),
    ).rejects.toThrow('quote_ext')

    // 台账预置 quote_ext（v2.7 keji 写回形态）→ 读取保留 + update 原样保留
    const rec = await box.quotes.create({ quotation_no: 'QT-20260811-001', date: '2026-08-11', lines: [line(1, 100)] })
    const store = await readQuotesStore(ws)
    store.quotes['QT-20260811-001'].quote_ext = { confirmed_by: 'keji', expand: { product: 'x' }, keji_lines: [] }
    await fsp.writeFile(path.join(ws, '.qihefilemanager', '报价.json'), JSON.stringify(store, null, 2))
    const updated = await box.quotes.update({ quotation_no: 'QT-20260811-001', notes: '编辑后' })
    expect(updated.quote_ext).toEqual({ confirmed_by: 'keji', expand: { product: 'x' }, keji_lines: [] })
    expect((await box.quotes.get('QT-20260811-001'))?.quote_ext).toEqual({
      confirmed_by: 'keji',
      expand: { product: 'x' },
      keji_lines: [],
    })
  })

  it('区域判别：报价 key → quote；既有区域不受影响', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const wsPath = box.workspace.currentWorkspacePath()!

    expect(await interpretMetadataKeyRegion(wsPath, '报价/2026/x.pdf')).toBe('quote')
    expect(await interpretMetadataKeyRegion(wsPath, '报价/2027/y.pdf')).toBe('quote')
    expect(await interpretMetadataKeyRegion(wsPath, '报价/zzz.pdf')).toBe('quote')
    // 既有区域不受影响
    expect(await interpretMetadataKeyRegion(wsPath, '客户/张三/报价/a.pdf')).toBe('customer')
    expect(await interpretMetadataKeyRegion(wsPath, '发票/2026/f.pdf')).toBe('invoice')
    expect(await interpretMetadataKeyRegion(wsPath, '供应商/甲/合同/x.pdf')).toBe('supplier')
    expect(await interpretMetadataKeyRegion(wsPath, '入库/2026/r.pdf')).toBe('inbound')
    expect(await interpretMetadataKeyRegion(wsPath, '系列A/图包/主图/a.jpg')).toBe('productSet')
  })

  it('Logger 注入：create/setStatus 调用 logger.info（S6 core 接口）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const workspace = new WorkspaceService(home)
    await workspace.create(ws)
    const logger = new MemoryLogger()
    const quotes = new QuotesService(workspace, logger)
    const infoMsgs = (): string[] => logger.calls.filter((c) => c.level === 'info').map((c) => c.msg)

    const rec = await quotes.create({ date: '2026-08-11', lines: [line(1, 100)] })
    expect(infoMsgs()).toEqual([expect.stringContaining('创建')])

    await quotes.setStatus(rec.quotation_no, '已确认')
    expect(infoMsgs()).toEqual([expect.stringContaining('创建'), expect.stringContaining('状态流转')])
  })
})
