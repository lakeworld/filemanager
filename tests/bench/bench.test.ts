/**
 * 性能基准（core 层）：生成标准工作区（200 产品集 / 2000 文件）测量关键指标。
 * 运行：npm run bench（vitest 环境，直接测 TS core，含真实 sharp 缩略图）
 * 输出：控制台 + 追加 docs/PERF.md
 *
 * 说明：core 层指标（node）≈ Electron 主进程能力（主进程即 node 运行时），
 * 可反映扫描/搜索/导入/缩略图真实耗时。
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
const PERF_FILE = path.resolve(__dirname, '..', '..', 'docs', 'PERF.md')

function timeMs(): number {
  return performance.now()
}

describe('性能基准', () => {
  it('200 产品集 × 10 文件 关键指标', async () => {
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

    const workspace = new WorkspaceService(base)
    const box = new BoxService(new SharpThumbnailService(workspace), workspace)
    await box.workspace.create(ws)
    const lines: string[] = [`## ${new Date().toISOString().slice(0, 10)}（core 层，${process.env.XDG_CURRENT_DESKTOP ?? ''}）`, `- 工作区：${SETS} 产品集 × ${FILES_PER_SET} 文件`]

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

    // 3. 搜索
    t = timeMs()
    const sres = await box.search.search('图_5')
    const searchMs = timeMs() - t
    expect(sres.files.length).toBeGreaterThan(0)
    lines.push(`- **搜索(2000文件)**: ${searchMs.toFixed(0)}ms（命中 ${sres.files.length}）`)

    // 4. 产品集列表（含 countFiles 缓存）
    t = timeMs()
    await box.workspace.productSetList()
    const listMs = timeMs() - t
    lines.push(`- **产品集列表(200)**: ${listMs.toFixed(0)}ms`)

    // 5. 导入 100 文件（含真实 sharp 缩略图，用 PNG）
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

    // 6. 内存（node 进程）
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
    lines.push(`- **进程内存(RSS)**: ${rss}MB`)

    console.log('[bench]', lines.join('\n[bench] '))
    await fsp.mkdir(path.dirname(PERF_FILE), { recursive: true })
    await fsp.appendFile(PERF_FILE, `\n${lines.join('\n')}\n`)
    console.log(`[bench] 已追加 ${PERF_FILE}`)

    await fsp.rm(base, { recursive: true, force: true })
  }, 120000)
})
