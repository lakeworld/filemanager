/**
 * 性能基准（core 层）：生成标准工作区（200 产品集 / 2000 文件 + 供应商/报价新根样本）测量关键指标。
 * 运行：npm run bench（vitest 环境，直接测 TS core，含真实 sharp 缩略图）
 * 输出：控制台 + 追加 docs/PERF.md
 *
 * 说明：core 层指标（node）≈ Electron 主进程能力（主进程即 node 运行时），
 * 可反映扫描/搜索/导入/缩略图真实耗时。
 *
 * v2.4.9（§6.2）：
 * - fixture 增补 供应商/供应商A/{合同,对账单,往来文件}/ 与 报价/2026/ 新根样本（含 PDF，%PDF- 魔数）
 * - 新指标：工作区索引全量 build（含供应商/报价区）、新根关键词搜索、发票/报价台账千级 CRUD
 * - 发票台账基准为首次记录（v2.4.7 起存在但无基准），报价以其为对照（同门禁 <10%）
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { WorkspaceService } from '../../src/main/core/workspace'
import { BoxService } from '../../src/main/core'
import { SharpThumbnailService } from '../../src/main/thumbnail'

const SETS = 200
const FILES_PER_SET = 10
const IMPORT_BATCH = 100
const LEDGER_SIZE = 1000
const PERF_FILE = path.resolve(__dirname, '..', '..', 'docs', 'PERF.md')

function timeMs(): number {
  return performance.now()
}

describe('性能基准', () => {
  it('200 产品集 × 10 文件 + 新根样本 关键指标', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-bench-'))
    const ws = path.join(base, 'bench-ws')
    await fsp.mkdir(path.join(ws, '产品集'), { recursive: true })
    for (let s = 1; s <= SETS; s++) {
      const dir = path.join(ws, '产品集', `系列${String(s).padStart(3, '0')}`, '图包', '主图')
      await fsp.mkdir(dir, { recursive: true })
      const writes = []
      for (let f = 1; f <= FILES_PER_SET; f++) {
        writes.push(fsp.writeFile(path.join(dir, `图_${f}.txt`), `产品图文件 ${s}-${f}`))
      }
      await Promise.all(writes)
    }

    // —— v2.4.9 新根样本：供应商/<名>/{合同,对账单,往来文件} + 报价/<YYYY>/（含 PDF，%PDF- 魔数即可，非合法结构）——
    const supplierRoot = path.join(ws, '供应商', '供应商A')
    for (const sub of ['合同', '对账单', '往来文件']) {
      await fsp.mkdir(path.join(supplierRoot, sub), { recursive: true })
    }
    await fsp.writeFile(path.join(supplierRoot, '合同', '供应商A采购合同.pdf'), '%PDF-1.4\n% qihebox bench fixture\n')
    await fsp.writeFile(path.join(supplierRoot, '合同', '供应商A合同补充条款.txt'), '补充条款')
    await fsp.writeFile(path.join(supplierRoot, '对账单', '供应商A对账单2026Q1.txt'), '对账单内容')
    await fsp.writeFile(path.join(supplierRoot, '往来文件', '供应商A往来函件.txt'), '往来内容')
    const quoteRoot = path.join(ws, '报价', '2026')
    await fsp.mkdir(quoteRoot, { recursive: true })
    await fsp.writeFile(path.join(quoteRoot, '报价单QT-2026001.pdf'), '%PDF-1.4\n% qihebox bench fixture\n')
    await fsp.writeFile(path.join(quoteRoot, '报价单QT-2026002.txt'), '报价内容')
    // 发票归档文件（发票台账 create 的 file_path 校验需真实存在）
    await fsp.mkdir(path.join(ws, '发票', '2026'), { recursive: true })
    await fsp.writeFile(path.join(ws, '发票', '2026', '发票归档样本.pdf'), '%PDF-1.4\n% qihebox bench fixture\n')

    const workspace = new WorkspaceService(base)
    const box = new BoxService(new SharpThumbnailService(workspace), workspace)
    await box.workspace.create(ws)
    const lines: string[] = [
      // 日期用本地时区（同 logger.ts dateStr 语义）：toISOString 是 UTC，本地 00:00–08:00 会差一天
      `## ${(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()}（core 层，${process.env.XDG_CURRENT_DESKTOP ?? ''}）`,
      `- 工作区：${SETS} 产品集 × ${FILES_PER_SET} 文件 + 供应商/报价 新根样本（含 PDF）`,
    ]

    // 1. Dashboard 首次扫描（冷缓存）
    let t = timeMs()
    const stats = await box.dashboard.dashboardStats()
    const first = timeMs() - t
    expect(stats.total_product_sets).toBe(SETS)
    expect(stats.total_images).toBe(SETS * FILES_PER_SET)
    lines.push(`- **dashboard 首次扫描**: ${first.toFixed(0)}ms`)

    // 2. 缓存命中（连续调用）
    t = timeMs()
    await box.dashboard.dashboardStats()
    await box.dashboard.dashboardStats()
    const cached = timeMs() - t
    lines.push(`- **dashboard 缓存命中(连调2次)**: ${cached.toFixed(0)}ms`)

    // 3. 搜索（2000 产品图文件；v2.4.9 起同步扫 供应商/报价 新根区）
    t = timeMs()
    const sres = await box.search.search('图_5')
    const searchMs = timeMs() - t
    expect(sres.files.length).toBeGreaterThan(0)
    lines.push(`- **搜索(2000文件+新根区)**: ${searchMs.toFixed(0)}ms（命中 ${sres.files.length}）`)

    // 4. 工作区索引全量 build（v2.4.9：含 供应商/报价 区逐目录快照；产品集/客户/发票/入库/供应商/报价 六区）
    t = timeMs()
    const builtDirs = await box.files.warmup()
    const indexBuildMs = timeMs() - t
    expect(builtDirs).toBeGreaterThan(0)
    lines.push(`- **工作区索引全量build(含新根区)**: ${indexBuildMs.toFixed(0)}ms（${builtDirs} 目录）`)

    // 5. 新根关键词搜索（供应商/报价区原件可被搜到，路径自明来源区域）
    t = timeMs()
    const sNew = await box.search.search('供应商A')
    const searchNewMs = timeMs() - t
    expect(sNew.files.length).toBeGreaterThan(0)
    lines.push(`- **搜索新根(供应商A/报价)**: ${searchNewMs.toFixed(0)}ms（命中 ${sNew.files.length}）`)

    // 6. 产品集列表（含 countFiles 缓存）
    t = timeMs()
    await box.workspace.productSetList()
    const listMs = timeMs() - t
    lines.push(`- **产品集列表(200)**: ${listMs.toFixed(0)}ms`)

    // 7. 导入 100 文件（含真实 sharp 缩略图，用 PNG）
    const srcDir = path.join(base, 'src-batch')
    await fsp.mkdir(srcDir, { recursive: true })
    const sharp = (await import('sharp')).default
    const pngBuf = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 90, g: 120, b: 160 } } })
      .png()
      .toBuffer()
    const writes = []
    for (let i = 0; i < IMPORT_BATCH; i++) {
      writes.push(fsp.writeFile(path.join(srcDir, `批_${i}.png`), pngBuf))
    }
    await Promise.all(writes)
    const srcPaths = (await fsp.readdir(srcDir)).map((f) => path.join(srcDir, f))

    t = timeMs()
    const imported = (await box.files.importFiles({
      source_paths: srcPaths,
      target_product_set: '系列001',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })).imported
    const importMs = timeMs() - t
    expect(imported).toHaveLength(IMPORT_BATCH)
    // v2.4.2（I4）：导入不再同步生成缩略图（异步后台），这里单独计时批量生成一次供参考
    t = timeMs()
    await Promise.all(imported.map((f) => box.ensureThumbnailFor(f.path, 'background').catch(() => '')))
    const thumbMs = timeMs() - t
    lines.push(`- **导入${IMPORT_BATCH}文件**: ${importMs.toFixed(0)}ms（缩略图批量生成 ${thumbMs.toFixed(0)}ms）`)

    // 8. 发票台账（v2.4.7）千级基准：首次记录，报价以其为对照（PLAN §6.2）
    const invFileRel = '发票/2026/发票归档样本.pdf'
    t = timeMs()
    for (let i = 0; i < LEDGER_SIZE; i++) {
      await box.invoices.create({
        number: `FP2026${String(i).padStart(5, '0')}`,
        date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        amount: 100 + i,
        seller: `供应商开票方${i % 10}`,
        buyer: '启禾测试采购方',
        status: '待报销',
        file_path: invFileRel,
      })
    }
    const invCreateMs = timeMs() - t
    t = timeMs()
    const invList = await box.invoices.list()
    const invListMs = timeMs() - t
    expect(invList).toHaveLength(LEDGER_SIZE)
    lines.push(`- **发票台账 create×${LEDGER_SIZE}**: ${invCreateMs.toFixed(0)}ms（list ${invListMs.toFixed(0)}ms）`)

    // 9. 报价台账（v2.4.9 S3）千级基准：对照发票（PLAN §6.2 报价 vs 发票回退 <10%）
    t = timeMs()
    for (let i = 0; i < LEDGER_SIZE; i++) {
      await box.quotes.create({
        date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        lines: [{ product: `产品${i % 50}`, qty: 1, unit_price: 100, amount: 100 }],
        customer: `客户${i % 20}`,
        notes: `报价批次 ${i}`,
      })
    }
    const qCreateMs = timeMs() - t
    t = timeMs()
    const qList = await box.quotes.list()
    const qListMs = timeMs() - t
    expect(qList).toHaveLength(LEDGER_SIZE)
    lines.push(`- **报价台账 create×${LEDGER_SIZE}**: ${qCreateMs.toFixed(0)}ms（list ${qListMs.toFixed(0)}ms）`)

    // 10. 内存（node 进程）
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
    lines.push(`- **进程内存(RSS)**: ${rss}MB`)

    console.log('[bench]', lines.join('\n[bench] '))
    await fsp.mkdir(path.dirname(PERF_FILE), { recursive: true })
    await fsp.appendFile(PERF_FILE, `\n${lines.join('\n')}\n`)
    console.log(`[bench] 已追加 ${PERF_FILE}`)

    await fsp.rm(base, { recursive: true, force: true })
  }, 180000)
})
