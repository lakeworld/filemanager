/**
 * 仪表盘单测（v2.4.0）：产品集/文件统计、checkExpiringCerts 30 天窗口边界。
 */
import { describe, expect, it, vi } from 'vitest'
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

  it('checkExpiringCerts 探活并发闸 ≤8（v2.5.2：Promise.all 全量 → 8 并发 worker）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    const dir = path.join(ws, '产品集', '系列A', '证书', '3C')
    await fsp.mkdir(dir, { recursive: true })
    const names: string[] = []
    for (let i = 0; i < 20; i++) {
      const name = `并发${i}.jpg`
      names.push(name)
      const p = path.join(dir, name)
      await fsp.writeFile(p, 'x')
      await box.metadata.update({ file_path: p, expiry_date: dateInDays(3) })
    }

    // 并发峰值测量：mock stat 计数 in-flight（node 内置模块单例——dashboard.ts 的 fsp 同一对象，spy 生效）
    let inFlight = 0
    let peak = 0
    const orig = fsp.stat.bind(fsp)
    const spy = vi
      .spyOn(fsp, 'stat')
      .mockImplementation((async (p: Parameters<typeof orig>[0]) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          return await orig(p)
        } finally {
          inFlight--
        }
      }) as typeof fsp.stat)
    try {
      const expiring = await box.dashboard.checkExpiringCerts()
      expect(expiring.length).toBe(20) // 全部命中（布尔数组语义不变）
      expect(peak).toBeLessThanOrEqual(8) // 并发闸生效
    } finally {
      spy.mockRestore()
    }
  })

  it('M5 统计：供应商目录扫描口径（回收站中供应商不计）+ 笔记三域聚合按 0 容错', async () => {
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
    // 未建笔记 → 三域聚合按 0（目录缺失容错，v2.5.8 用户拍板：统计卡「报价」→「笔记」）
    expect(stats.total_notes).toBe(0)
  })

  it('M5 统计：笔记数（三域「笔记」子文件夹 .md 聚合计数，非 .md 不计）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 三域各落 1 篇笔记（core/notes 三域口径：产品集/<名>/文档/笔记、客户/<名>/笔记、供应商/<名>/笔记）
    const psNote = path.join(ws, '产品集', '系列A', '文档', '笔记')
    const custNote = path.join(ws, '客户', '张三', '笔记')
    const supNote = path.join(ws, '供应商', '李四', '笔记')
    for (const d of [psNote, custNote, supNote]) await fsp.mkdir(d, { recursive: true })
    await fsp.writeFile(path.join(psNote, '产品修订.md'), '# 产品修订')
    await fsp.writeFile(path.join(custNote, '拜访纪要.md'), '# 拜访纪要')
    await fsp.writeFile(path.join(supNote, '打样记录.md'), '# 打样记录')
    // 干扰：非 .md 文件不计数
    await fsp.writeFile(path.join(supNote, '不是笔记.txt'), 'x')

    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_notes).toBe(3)
  })

  it('P1-4 dashboardStats：集间 8 并发统计与串行旧行为一致；expiring_certs 恒 0（独立 IPC 通道承担）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })
    await box.workspace.productSetCreate({ name: '系列C' })

    // 直接写文件（不经导入，验证纯扫描路径）：A 图包 2 + 证书 1；B 图包 1；C 证书 2
    const setDir = (ps: string, type: string, sub: string): string => path.join(ws, '产品集', ps, type, sub)
    for (const [ps, type, sub, files] of [
      ['系列A', '图包', '主图', ['a1.jpg', 'a2.jpg']],
      ['系列A', '证书', '3C', ['c1.jpg']],
      ['系列B', '图包', '主图', ['b1.jpg']],
      ['系列C', '证书', '3C', ['c2.jpg', 'c3.jpg']],
    ] as [string, string, string, string[]][]) {
      const d = setDir(ps, type, sub)
      await fsp.mkdir(d, { recursive: true })
      for (const n of files) await fsp.writeFile(path.join(d, n), 'x')
    }
    // 一张 5 天后到期的证书：旧行为（dashboardStats 内嵌 checkExpiringCerts）会报 1，新行为恒 0
    await box.metadata.update({ file_path: path.join(setDir('系列C', '证书', '3C'), 'c3.jpg'), expiry_date: dateInDays(5) })

    const stats = await box.dashboard.dashboardStats()
    // 与「串行 + 含 expiring 检查」旧行为一致的统计数字（并发计数不变）
    expect(stats.total_product_sets).toBe(3)
    expect(stats.total_images).toBe(3)
    expect(stats.total_certs).toBe(3)
    expect(stats.recent_files).toHaveLength(5) // 6 个文件 → 最近 5 条
    // 契约字段保留恒 0；到期检查仍由独立通道提供（checkExpiringCerts 方法本身不受影响）
    expect(stats.expiring_certs).toBe(0)
    const expiring = await box.dashboard.checkExpiringCerts()
    expect(expiring.map(([, fn]) => fn)).toContain('c3.jpg')
  })
})
