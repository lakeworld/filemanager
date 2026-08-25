import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { compareArchiveDirs } from '../../src/main/core/orphans'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-orphans-'))
}

async function writeFile(p: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

/**
 * 孤儿档案比对（PLAN-v2.5.5 §二 修复3，B1 任务 C）：
 * 扫 发票/、入库/、报价/ 目录全部文件相对路径 vs 各台账 file_path 集合 → 差集。
 * 历史孤儿（含 2026-08-24 用户误删那张——文件仍在 发票/<YYYY>/、台账无记录）必须能扫出。
 */
describe('孤儿档案比对（PLAN §二 修复3）', () => {
  it('目录有文件 + 台账无 file_path → 扫出孤儿（三区）', async () => {
    const ws = await tmp()
    await writeFile(path.join(ws, '发票', '2026', 'a.pdf'))
    await writeFile(path.join(ws, '入库', '2026', 'b.pdf'))
    await writeFile(path.join(ws, '报价', '2026', 'c.pdf'))
    // ledger 全空 → 全部为孤儿（与台账 list() 无记录的差集口径一致）
    const r = await compareArchiveDirs(ws, { invoice: [], inbound: [], quote: [] })
    expect(r.invoice).toEqual(['发票/2026/a.pdf'])
    expect(r.inbound).toEqual(['入库/2026/b.pdf'])
    expect(r.quote).toEqual(['报价/2026/c.pdf'])
  })

  it('台账已登记 file_path → 不报；同目录孤儿 → 只报差集', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 建一张已登记发票（archiveFile 落盘 + create 登记）
    const src = path.join(ws, '.tmp-inv.pdf')
    await writeFile(src)
    const rel = await box.invoices.archiveFile(src, '2026-08-11')
    await box.invoices.create({
      number: 'INV-001', date: '2026-08-11', amount: 100,
      seller: '开票方A', buyer: '购买方B', status: '待报销', file_path: rel,
    })
    // 台账已登记该文件 → 不报
    const r = await compareArchiveDirs(ws, { invoice: [rel], inbound: [], quote: [] })
    expect(r.invoice).toEqual([])
    // 台账全空口径（如调用方未登记）→ 该文件是孤儿
    const r2 = await compareArchiveDirs(ws)
    expect(r2.invoice).toEqual([rel])
    // 同目录额外孤儿文件（直接写盘，不走台账）→ 差集只报它
    await writeFile(path.join(ws, '发票', '2026', 'orphan.pdf'))
    const r3 = await compareArchiveDirs(ws, { invoice: [rel], inbound: [], quote: [] })
    expect(r3.invoice).toEqual(['发票/2026/orphan.pdf'])
  })

  it('跨年目录全部计入', async () => {
    const ws = await tmp()
    await writeFile(path.join(ws, '发票', '2025', 'old.pdf'))
    await writeFile(path.join(ws, '发票', '2026', 'new.pdf'))
    const r = await compareArchiveDirs(ws, { invoice: ['发票/2026/new.pdf'], inbound: [], quote: [] })
    expect(r.invoice).toEqual(['发票/2025/old.pdf'])
  })

  it('空目录 / 无目录 → 空数组', async () => {
    const ws = await tmp()
    const r = await compareArchiveDirs(ws)
    expect(r.invoice).toEqual([])
    expect(r.inbound).toEqual([])
    expect(r.quote).toEqual([])
    // 目录存在但为空
    await fsp.mkdir(path.join(ws, '发票', '2026'), { recursive: true })
    const r2 = await compareArchiveDirs(ws)
    expect(r2.invoice).toEqual([])
  })

  it('报价文档文件夹（目录名 = 台账单号）→ 跳过不报孤儿；同区普通孤儿仍报', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const rec = await box.quotes.create({
      quotation_no: 'QT-DOC-001',
      date: '2026-08-12',
      lines: [{ product: 'p', qty: 1, unit_price: 1, amount: 1 }],
    })
    // 模拟拖拽复制进文档文件夹（报价/<YYYY>/<单号>/）
    await writeFile(path.join(ws, '报价', '2026', 'QT-DOC-001', '报价单.pdf'))
    await writeFile(path.join(ws, '报价', '2026', 'QT-DOC-001', '合同.docx'))
    // 同区未登记文件（不属任何单号目录）仍为孤儿
    await writeFile(path.join(ws, '报价', '2026', 'orphan.pdf'))
    const r = await compareArchiveDirs(
      ws,
      { invoice: [], inbound: [], quote: [rec.file_path ?? ''] },
      new Set([rec.quotation_no]),
    )
    expect(r.quote).toEqual(['报价/2026/orphan.pdf'])
    // 不传 quoteNos → 文档文件夹文件会被计为孤儿（兼容旧口径；顺序与 readdir 一致，排序比较）
    const r2 = await compareArchiveDirs(ws, { invoice: [], inbound: [], quote: [rec.file_path ?? ''] })
    expect([...r2.quote].sort()).toEqual(
      ['报价/2026/QT-DOC-001/报价单.pdf', '报价/2026/QT-DOC-001/合同.docx', '报价/2026/orphan.pdf'].sort(),
    )
  })
})
