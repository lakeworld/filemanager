/**
 * 仪表盘单测（v2.4.0）：产品集/文件统计、checkExpiringCerts 30 天窗口边界。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dash-'))
}

/** 最小 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** n 天后的本地日期 YYYY-MM-DD（checkExpiringCerts 以本地 00:00 解析到期日） */
function dateInDays(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('仪表盘（DashboardService）', () => {
  it('统计：产品集 / 图片 / 证书 计数与最近文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    // 系列A 导入 2 张图（图包/主图）
    const img1 = path.join(ws, '..', 'i1.jpg')
    const img2 = path.join(ws, '..', 'i2.jpg')
    await fsp.writeFile(img1, PNG_1PX)
    await fsp.writeFile(img2, PNG_1PX)
    await box.files.importFiles({
      source_paths: [img1, img2],
      target_product_set: '系列A',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    // 系列B 导入 1 份证书（证书/3C 为默认子文件夹）
    const cert1 = path.join(ws, '..', 'c1.jpg')
    await fsp.writeFile(cert1, PNG_1PX)
    await box.files.importFiles({
      source_paths: [cert1],
      target_product_set: '系列B',
      target_folder: '3C',
      target_type: 'cert',
      sub_folder: '3C',
    })

    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_product_sets).toBe(2)
    expect(stats.total_images).toBe(2)
    expect(stats.total_certs).toBe(1)
    expect(stats.recent_files).toHaveLength(3)
  })

  it('checkExpiringCerts：30 天窗口边界 + 宽松日期解析 + 已删除文件不再提醒', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    const certDir = (ps: string, sub: string): string => path.join(ws, '产品集', ps, '证书', sub)
    await fsp.mkdir(certDir('系列A', '3C'), { recursive: true })
    await fsp.mkdir(certDir('系列B', '3C'), { recursive: true })
    const put = async (dir: string, name: string): Promise<string> => {
      const p = path.join(dir, name)
      await fsp.writeFile(p, 'x')
      return p
    }

    const fOk = await put(certDir('系列A', '3C'), 'ok.jpg')
    const fSlash = await put(certDir('系列A', '3C'), '斜杠日期.jpg')
    const fDeleted = await put(certDir('系列A', '3C'), '已删除.jpg')
    const f31 = await put(certDir('系列A', '3C'), '31天.jpg')
    const fNone = await put(certDir('系列A', '3C'), '无期限.jpg')
    const fBad = await put(certDir('系列B', '3C'), '格式坏.jpg')

    // 10 天后到期（标准格式）→ 命中
    await box.metadata.update({ file_path: fOk, expiry_date: dateInDays(10) })
    // YYYY/M/D 斜杠格式 → 写入归一化后命中（C1 宽松解析）
    const d10 = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    const slash = `${d10.getFullYear()}/${d10.getMonth() + 1}/${d10.getDate()}`
    await box.metadata.update({ file_path: fSlash, expiry_date: slash })
    // 删除进回收站 → 不再提醒（C2）
    await box.metadata.update({ file_path: fDeleted, expiry_date: dateInDays(5) })
    await box.files.fileDelete([fDeleted])
    // 31 天外、无期限、非法日期 → 全部跳过
    await box.metadata.update({ file_path: f31, expiry_date: dateInDays(31) })
    await box.metadata.update({ file_path: fNone, expiry_date: '' })
    await box.metadata.update({ file_path: fBad, expiry_date: '2026-13-99' })

    const expiring = await box.dashboard.checkExpiringCerts()
    const names = expiring.map(([, fn]) => fn)
    expect(names).toContain('ok.jpg')
    expect(names).toContain('斜杠日期.jpg')
    expect(names).not.toContain('已删除.jpg') // 文件已移入回收站 → 不提醒
    expect(names).not.toContain('31天.jpg')
    expect(names).not.toContain('无期限.jpg')
    expect(names).not.toContain('格式坏.jpg')
  })

  it('M5 统计：供应商目录扫描口径（回收站中供应商不计）+ 报价.json 缺失按 0', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 建 2 个供应商，删除 1 个进回收站（目录移出 供应商/，suppliers.json 条目保留——恢复即复原）
    await box.suppliers.create({ name: '供应商甲' })
    await box.suppliers.create({ name: '供应商乙' })
    await box.deleteSupplier('供应商乙')

    // 列表（目录扫描为实）只剩 1 个；档案仍保留 2 条 → 按 JSON 计数会把已回收供应商计入、与列表页矛盾
    const list = await box.suppliers.list()
    expect(list.map((s) => s.name)).toEqual(['供应商甲'])
    const info = await box.suppliers.loadSuppliersInfo()
    expect(Object.keys(info)).toContain('供应商乙')

    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_suppliers).toBe(1)
    // 未建报价 → 报价.json 缺失按 0（仿 invoiceTodos 容错）
    expect(stats.total_quotes).toBe(0)
    expect(stats.draft_quotes).toBe(0)
  })

  it('M5 统计：报价数与草稿报价数（报价.json 台账 status 计数）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.quotes.create({
      quotation_no: 'QT-M5-001',
      date: '2026-08-01',
      lines: [{ product: '品1', qty: 1, unit_price: 10, amount: 10 }],
    })
    await box.quotes.create({
      quotation_no: 'QT-M5-002',
      date: '2026-08-02',
      lines: [{ product: '品2', qty: 2, unit_price: 5, amount: 10 }],
    })
    await box.quotes.setStatus('QT-M5-002', '已确认')

    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_quotes).toBe(2)
    expect(stats.draft_quotes).toBe(1)
  })
})
