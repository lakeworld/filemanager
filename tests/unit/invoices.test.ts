import { describe, it, expect, vi } from 'vitest'
import { buildTestBox } from './helpers'
import ExcelJS from 'exceljs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { BoxService } from '../../src/main/core'
import type { InvoiceCreateRequest } from '../../src/main/core/invoices'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-invoices-'))
}

async function writeFile(p: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
}

/** 相对今天的偏移日期（YYYY-MM-DD），待办窗口边界测试用 */
function todayOffsetDays(days: number): string {
  const t = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** 建一条发票（先归档一个随机源文件，再 create），over 覆盖任意字段 */
async function addInvoice(
  box: BoxService,
  ws: string,
  over: Partial<InvoiceCreateRequest> = {},
): Promise<Awaited<ReturnType<BoxService['invoices']['create']>>> {
  const src = path.join(ws, `.tmp-${Math.random().toString(36).slice(2)}.pdf`)
  await writeFile(src, 'pdf')
  const rel = await box.invoices.archiveFile(src, over.date ?? '2026-08-11')
  return box.invoices.create({
    number: 'INV-001',
    date: '2026-08-11',
    amount: 100,
    seller: '开票方A',
    buyer: '购买方B',
    status: '待报销',
    file_path: rel,
    ...over,
  })
}

describe('发票台账（PLAN §6）', () => {
  it('创建：必填校验（号码/日期/金额/开票方/购买方/状态/文件）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await writeFile(path.join(ws, 'inv.pdf'))
    const rel = await box.invoices.archiveFile(path.join(ws, 'inv.pdf'), '2026-08-11')
    const base: InvoiceCreateRequest = { number: 'X1', date: '2026-08-11', amount: 100, seller: 'A', buyer: 'B', status: '待报销', file_path: rel }

    await expect(box.invoices.create({ ...base, number: '' })).rejects.toThrow('发票号码不能为空')
    await expect(box.invoices.create({ ...base, date: '' })).rejects.toThrow('开票日期无效')
    await expect(box.invoices.create({ ...base, date: '2026-02-30' })).rejects.toThrow('开票日期无效')
    await expect(box.invoices.create({ ...base, amount: Number.NaN })).rejects.toThrow('金额无效')
    await expect(box.invoices.create({ ...base, seller: '  ' })).rejects.toThrow('开票方不能为空')
    await expect(box.invoices.create({ ...base, buyer: '' })).rejects.toThrow('购买方不能为空')
    await expect(box.invoices.create({ ...base, status: '已核销' as never })).rejects.toThrow('状态无效')
    await expect(box.invoices.create({ ...base, file_path: '' })).rejects.toThrow('请选择发票文件')

    const rec = await box.invoices.create(base)
    expect(rec.number).toBe('X1')
    expect(rec.amount).toBe(100)
    expect(rec.created_at).toBeTruthy()
  })

  it('日期归一化：写入为 YYYY-MM-DD', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const rec = await addInvoice(box, ws, { number: 'N1', date: '2026/8/11' })
    expect(rec.date).toBe('2026-08-11')
  })

  it('查重：创建命中即拒绝并带已有记录摘要（状态/日期/文件）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await addInvoice(box, ws, { number: 'DUP' })
    let err: Error | null = null
    try {
      await addInvoice(box, ws, { number: 'DUP' })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('发票号码 DUP 已存在')
    expect(err!.message).toContain('状态：待报销')
    expect(err!.message).toContain('日期：2026-08-11')
    expect(err!.message).toContain('文件：发票/2026/')
  })

  it('查重三入口同函数 checkNumber：命中返回记录、排除自身、未命中 null', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await addInvoice(box, ws, { number: 'C1' })
    expect(await box.invoices.checkNumber('C1')).not.toBeNull()
    expect(await box.invoices.checkNumber('C1', 'C1')).toBeNull()
    expect(await box.invoices.checkNumber('NONE')).toBeNull()
    await expect(box.invoices.checkNumber('')).rejects.toThrow('发票号码不能为空')
  })

  it('update：字段更新 + updated_at 刷新 + 换号查重（排除自身）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const created = await addInvoice(box, ws, { number: 'A1' })
    await addInvoice(box, ws, { number: 'B1' })

    // 更新不存在的记录 → 报错
    await expect(box.invoices.update({ number: 'NOPE' })).rejects.toThrow('发票不存在')
    // 换号撞已有号码 → 查重拒绝
    await expect(box.invoices.update({ number: 'A1', newNumber: 'B1' })).rejects.toThrow('已存在')
    // 号码不变（newNumber 省略或同号）→ 通过
    const up = await box.invoices.update({ number: 'A1', amount: 200, seller: '新开票方', status: '已报销' })
    expect(up.amount).toBe(200)
    expect(up.seller).toBe('新开票方')
    expect(up.status).toBe('已报销')
    expect(up.updated_at).not.toBe(created.updated_at)
    expect(up.created_at).toBe(created.created_at)
    // 换绑文件 + 改日期
    const src2 = path.join(ws, 'another.pdf')
    await writeFile(src2, 'y')
    const rel2 = await box.invoices.archiveFile(src2, '2026-09-01')
    const up2 = await box.invoices.update({ number: 'A1', newNumber: 'A1', file_path: rel2, date: '2026-09-01' })
    expect(up2.file_path).toBe(rel2)
    expect(up2.date).toBe('2026-09-01')
    // 清空可选字段
    const up3 = await box.invoices.update({ number: 'A1', customer: '旧客户' })
    expect(up3.customer).toBe('旧客户')
    const up4 = await box.invoices.update({ number: 'A1', customer: '  ' })
    expect(up4.customer).toBeUndefined()
    // 换号成功
    const up5 = await box.invoices.update({ number: 'A1', newNumber: 'A2' })
    expect(up5.number).toBe('A2')
    expect(await box.invoices.checkNumber('A1')).toBeNull()
    expect(await box.invoices.checkNumber('A2')).not.toBeNull()
  })

  it('setStatus：枚举校验 + 状态流转', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const created = await addInvoice(box, ws, { number: 'S1' })
    await expect(box.invoices.setStatus('S1', '非法' as never)).rejects.toThrow('状态无效')
    await expect(box.invoices.setStatus('NOPE', '已报销')).rejects.toThrow('发票不存在')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-11T10:00:01.000Z'))
      const r = await box.invoices.setStatus('S1', '已报销')
      expect(r.status).toBe('已报销')
      expect(r.updated_at).not.toBe(created.updated_at)
    } finally {
      vi.useRealTimers()
    }
  })

  it('archiveFile：归档到 发票/<YYYY>/、原文件名 + 冲突序号、支持工作区外源文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const src = path.join(ws, 'inv.pdf')
    await writeFile(src, 'a')
    const rel1 = await box.invoices.archiveFile(src, '2026-08-11')
    const rel2 = await box.invoices.archiveFile(src, '2026-08-11')
    expect(rel1).toBe('发票/2026/inv.pdf')
    expect(rel2).toBe('发票/2026/inv_1.pdf')
    await expect(fsp.stat(path.join(ws, rel1))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, rel2))).resolves.toBeTruthy()

    // 工作区外源文件（UI 对话框选本地文件场景）
    const outside = await tmp()
    const src2 = path.join(outside, '外.pdf')
    await writeFile(src2, 'x')
    const rel3 = await box.invoices.archiveFile(src2, '2026-08-11')
    expect(rel3).toBe('发票/2026/外.pdf')

    // 非法日期 / 源不存在
    await expect(box.invoices.archiveFile(src, 'bad-date')).rejects.toThrow('开票日期无效')
    await expect(box.invoices.archiveFile(path.join(ws, 'nope.pdf'), '2026-08-11')).rejects.toThrow('归档源文件不存在')
  })

  it('file_path 校验：须位于 发票/ 区且文件真实存在；相对与绝对路径均可', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await writeFile(path.join(ws, 'inv.pdf'))
    const rel = await box.invoices.archiveFile(path.join(ws, 'inv.pdf'), '2026-08-11')
    const base: InvoiceCreateRequest = { number: 'X1', date: '2026-08-11', amount: 100, seller: 'A', buyer: 'B', status: '待报销', file_path: rel }

    // 发票区外路径（产品集内文件）拒绝
    const psFile = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    await writeFile(psFile)
    await expect(box.invoices.create({ ...base, file_path: psFile })).rejects.toThrow('必须归档在 发票/ 目录下')
    // 文件不存在拒绝
    await expect(box.invoices.create({ ...base, file_path: '发票/2026/不存在.pdf' })).rejects.toThrow('发票文件不存在')
    // 绝对路径等价
    const recAbs = await box.invoices.create({ ...base, number: 'ABS', file_path: path.join(ws, rel) })
    expect(recAbs.file_path).toBe(rel)
  })

  it('list：过滤（状态/客户/待办/搜索）+ 开票日期降序排序', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await addInvoice(box, ws, { number: 'INV-A', date: '2026-08-11', seller: '甲公司', buyer: '乙公司' })
    await addInvoice(box, ws, { number: 'INV-B', date: '2026-07-01', seller: '丙公司', buyer: '乙公司', customer: 'C1', status: '已报销' })
    await addInvoice(box, ws, { number: 'INV-C', date: '2026-09-01', seller: '丁公司', buyer: '戊公司', customer: 'C2' })

    expect((await box.invoices.list()).map((r) => r.number)).toEqual(['INV-C', 'INV-A', 'INV-B']) // 日期降序
    expect((await box.invoices.list({ status: '已报销' })).map((r) => r.number)).toEqual(['INV-B'])
    expect((await box.invoices.list({ customer: 'C2' })).map((r) => r.number)).toEqual(['INV-C'])
    expect((await box.invoices.list({ query: '丙公司' })).map((r) => r.number)).toEqual(['INV-B']) // 开票方子串
    expect((await box.invoices.list({ query: '戊公司' })).map((r) => r.number)).toEqual(['INV-C']) // 购买方子串
    expect((await box.invoices.list({ query: 'INV-B' })).map((r) => r.number)).toEqual(['INV-B']) // 号码子串
    expect(await box.invoices.list({ query: '不存在' })).toHaveLength(0)
  })

  it('待办窗口：29 天在窗内、31 天窗外、已入账排除、无 due_date 排除、已过期 30 天内仍提醒', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await addInvoice(box, ws, { number: 'D1', due_date: todayOffsetDays(29), status: '待报销' })
    await addInvoice(box, ws, { number: 'D2', due_date: todayOffsetDays(31), status: '待报销' })
    await addInvoice(box, ws, { number: 'D3', due_date: todayOffsetDays(29), status: '已入账' })
    await addInvoice(box, ws, { number: 'D4', due_date: todayOffsetDays(-10), status: '待报销' })
    await addInvoice(box, ws, { number: 'D5', status: '待报销' })

    const due = await box.invoices.list({ dueSoonOnly: true })
    expect(due.map((r) => r.number).sort()).toEqual(['D1', 'D4'])
  })

  it('exportXlsx：导出内容（表头 + 数据行）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await addInvoice(box, ws, { number: 'E1', code: 'CODE1', customer: '张三', notes: '备注', due_date: '2026-08-20' })

    const xlsxPath = path.join(ws, 'invoices-export.xlsx')
    await box.invoices.exportXlsx(xlsxPath, await box.invoices.list())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const sheet = wb.worksheets[0]
    expect(sheet.name).toBe('发票台账')
    expect(sheet.getCell('A1').value).toBe('发票号码')
    expect(sheet.getCell('D1').value).toBe('金额（元）')
    expect(sheet.getCell('A2').value).toBe('E1')
    expect(sheet.getCell('B2').value).toBe('CODE1')
    expect(sheet.getCell('C2').value).toBe('2026-08-11')
    expect(sheet.getCell('D2').value).toBe(100)
    expect(sheet.getCell('E2').value).toBe('开票方A')
    expect(sheet.getCell('H2').value).toBe('张三')
    expect(sheet.getCell('J2').value).toBe('备注')
    await expect(box.invoices.exportXlsx('', [])).rejects.toThrow('路径不能为空')
  })

  it('remove：账物分离——默认不删文件；deleteFile 文件进回收站；文件缺失不阻塞记录删除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 默认：记录删除，文件保留
    const rec = await addInvoice(box, ws, { number: 'DEL' })
    const absFile = path.join(ws, rec.file_path)
    await box.invoices.remove('DEL')
    expect(await box.invoices.list()).toHaveLength(0)
    await expect(fsp.stat(absFile)).resolves.toBeTruthy()

    // deleteFile：文件走回收站（file 单条目）
    const rec2 = await addInvoice(box, ws, { number: 'DEL2' })
    const absFile2 = path.join(ws, rec2.file_path)
    await box.invoices.remove('DEL2', { deleteFile: true })
    await expect(fsp.stat(absFile2)).rejects.toThrow()
    const trash = await box.trash.list()
    expect(trash).toHaveLength(1)
    expect(trash[0].kind).toBe('file')

    // 文件已缺失时 deleteFile 不阻塞记录删除
    const rec3 = await addInvoice(box, ws, { number: 'DEL3' })
    await fsp.rm(path.join(ws, rec3.file_path))
    await expect(box.invoices.remove('DEL3', { deleteFile: true })).resolves.toBeUndefined()

    await expect(box.invoices.remove('NOPE')).rejects.toThrow('发票不存在')
  })

  it('标签引用源：listTagEntries/saveTagEntries + tags rename/delete 自动传播', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('工作标签', '#ff0000')
    await addInvoice(box, ws, { number: 'TAG1', tags: ['工作标签'] })
    expect((await box.invoices.listTagEntries())[0].tags).toEqual(['工作标签'])

    // tags.rename 经引用源传播
    await box.tags.rename('工作标签', '工作标签2')
    expect((await box.invoices.listTagEntries())[0].tags).toEqual(['工作标签2'])
    // tags.delete 清引用
    await box.tags.delete('工作标签2')
    expect((await box.invoices.listTagEntries())[0].tags).toEqual([])

    // 直接回写（去重 + 空数组删字段）
    await box.invoices.saveTagEntries([{ name: 'TAG1', tags: ['a', 'b', 'a'] }])
    expect((await box.invoices.listTagEntries())[0].tags).toEqual(['a', 'b'])
    await box.invoices.saveTagEntries([{ name: 'TAG1', tags: [] }])
    expect((await box.invoices.listTagEntries())[0].tags).toEqual([])
  })

  it('v2.5（P1-C1）：台账损坏 → 备份原文件（.corrupt-<ts>）并降级为空', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const p = path.join(ws, '.qihefilemanager', 'invoices.json')
    const corrupt = '{"invoices": {"INV-1": '
    await fsp.writeFile(p, corrupt)
    // 损坏 → list 不崩且返回空
    expect(await box.invoices.list()).toEqual([])
    // 原文件内容已在 .corrupt-* 留证
    const dir = path.join(ws, '.qihefilemanager')
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('invoices.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(corrupt)
  })

  it('v2.5（P1-C2）：客户重命名级联发票 customer 引用（BoxService.renameCustomer）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    await addInvoice(box, ws, { number: 'CUST-1', customer: '张三' })
    await box.renameCustomer('张三', '李四')
    expect((await box.invoices.list()).find((r) => r.number === 'CUST-1')?.customer).toBe('李四')
  })

  it('未打开工作区时所有入口报错', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    await expect(box.invoices.list()).rejects.toThrow('未打开工作区')
    await expect(box.invoices.archiveFile('/tmp/x.pdf', '2026-08-11')).rejects.toThrow('未打开工作区')
  })
})
