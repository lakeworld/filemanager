/**
 * T8 renderer 内存 soak（v2.5.3）：反复路由/预览/滚动/插件往返，采集 post-GC heap、DOM 与 renderer working set。
 * - 标记 @soak：默认被 playwright.config.ts 排除；以 `npm run test:memory-soak`（playwright.memory-soak.config.ts）运行；
 *   独立配置禁用 trace/video/screenshot，诊断产物不占用被测进程内存。
 * - 启动参数 `--js-flags=--expose-gc`（仅诊断 launch，不进 PROD_ARGS / builder / autostart 三处同步面）。
 * - 预热 3 轮 + 正式 20 轮；断言：正式轮 heap/DOM 无持续增长（趋势比 ≤1.25）、虚拟列表图片 ≤100、
 *   正式轮 heap/nodes 中位不超冻结基线（tests/e2e/fixtures/soak-memory.baseline.json）、无 crash/pageerror。
 * - 输出 JSON：memory-soak-results/memory-soak-<timestamp>.json（.gitignore 已排除，不进公开仓库）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, CDPSession } from '@playwright/test'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { collectRendererMetrics, probeCdpCapabilities } from './helpers/memoryMetrics'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const WARMUP_ROUNDS = 3
const FORMAL_ROUNDS = 20
/** soak 插件夹具：hello + conformance.full（scripts/build-*-plugin 构建产物；npm run pretest 前置构建） */
const HELLO_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')
const CONFORMANCE_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.conformance.full.qbox')
/** 冻结基线：v2.5.3 T8 首测 3 次独立运行中位数 ×1.25（见 scripts/summarize-memory-runs.mjs thresholdSuggestion） */
const BASELINE_FILE = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'soak-memory.baseline.json')

test.describe('renderer 内存 soak（@soak，v2.5.3 T8）', () => {
  let app: ElectronApplication
  let page: Page
  let cdp: CDPSession
  let wsDir = ''
  let pluginRoutes: string[] = []
  const pageErrors: string[] = []
  const rounds: Array<Record<string, unknown>> = []

  test.beforeAll(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-soak-'))
    await buildSoakFixture(wsDir)

    app = await electron.launch({
      args: ['.', '--no-sandbox', '--js-flags=--expose-gc'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })

    // 打开工作区
    await page.evaluate(async (dir) => {
      const r = await (window as any).qihebox.workspace.open(dir)
      if (!r?.success) throw new Error('打开工作区失败: ' + JSON.stringify(r))
    }, wsDir)
    // 夹具子目录「增补/证书/文档」不在默认子夹配置：经 config API 登记（契约：建档后、等索引前配置第五图片子目录等）
    await configureExtraSubfolders(page)
    // 安装 soak 插件（hello + conformance.full）：插件页往返需要真实插件路由；安装失败 fail-closed
    pluginRoutes = await installSoakPlugins(page)
    // 说明：Dashboard 首载统计在 10000 文件工作区下需极长时间（探针实测 >120s，既有问题，本轮不修），
    // soak 不以 Dashboard 为就绪锚点：整页加载后直接进入 /images（应用恢复路由也会记住它，避免每轮触发 Dashboard 统计）
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(() => {
      window.history.pushState({}, '', '/images')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByRole('heading', { name: '图包库', level: 1 })).toBeVisible({ timeout: 30000 })
    // 索引就绪：轮询文件列表直到指定叶子目录出现条目（索引快照构建完成）
    await waitForIndexReady(page)

    cdp = await app.context().newCDPSession(page)
    const probe = await probeCdpCapabilities(cdp)
    const missing = Object.keys(probe.errors).filter((k) => !(probe as unknown as Record<string, boolean>)[k])
    expect(missing, `CDP 能力缺失，无法完成内存诊断：${JSON.stringify(probe.errors)}`).toHaveLength(0)
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  test('soak：预热3+正式20 轮，heap/DOM 无持续增长、虚拟列表 ≤100 图片、无 crash', async () => {
    let fullJsonWritten = false
    try {
      // 整页加载只做一次；轮次内全部 SPA 导航（测真实累积状态，不做 reload 复位）
      await page.goto(INDEX_URL)
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
      await page.evaluate(() => {
        window.history.pushState({}, '', '/images')
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await expect(page.getByRole('heading', { name: '图包库', level: 1 })).toBeVisible({ timeout: 30000 })
      for (let round = 1; round <= WARMUP_ROUNDS + FORMAL_ROUNDS; round += 1) {
        const formal = round > WARMUP_ROUNDS
        const { metrics, gridImageCount, parked } = await runOneRound(round, formal)
        // 每轮健康检查：页面仍响应（无 renderer crash）
        await page.evaluate(() => 1)
        expect(
          gridImageCount,
          `第 ${round} 轮虚拟列表图片数 ${gridImageCount} 超限 100`,
        ).toBeLessThanOrEqual(100)
        rounds.push({
          round,
          formal,
          ...metrics,
          virtualImageCount: gridImageCount,
          // v2.5.3 T5：隐藏沉降 10s 后的无强制 GC 采样（业务增量释放口径）
          parked: { heapUsedBytes: parked.heapUsedBytes, nodes: parked.nodes },
          pageErrors: [...pageErrors],
        })
      }

      const formalRounds = rounds.filter((r) => r.formal) as Array<Record<string, number>>
      expect(formalRounds.length, '正式轮必须完整采集 20 轮（fail-closed）').toBe(FORMAL_ROUNDS)

      const heap = formalRounds.map((r) => r.heapUsedBytes as number)
      const nodes = formalRounds.map((r) => r.nodes as number)
      // v2.5.3 T5：隐藏沉降后（无强制 GC，自然释放）的 heap/DOM 趋势——卸载不得随轮次累积滞留
      const parkedHeap = formalRounds.map((r) => (r.parked as unknown as { heapUsedBytes: number }).heapUsedBytes)
      const parkedNodes = formalRounds.map((r) => (r.parked as unknown as { nodes: number }).nodes)
      const firstHalf = (arr: number[]) => arr.slice(0, Math.floor(arr.length / 2))
      const secondHalf = (arr: number[]) => arr.slice(Math.floor(arr.length / 2))
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
      const heapTrend = secondHalf(heap).length ? mean(secondHalf(heap)) / mean(firstHalf(heap)) : 1
      const nodesTrend = secondHalf(nodes).length ? mean(secondHalf(nodes)) / mean(firstHalf(nodes)) : 1
      const parkedHeapTrend = secondHalf(parkedHeap).length ? mean(secondHalf(parkedHeap)) / mean(firstHalf(parkedHeap)) : 1
      const parkedNodesTrend = secondHalf(parkedNodes).length ? mean(secondHalf(parkedNodes)) / mean(firstHalf(parkedNodes)) : 1
      expect(
        heapTrend,
        `heap 后半程均值/前半程 = ${heapTrend.toFixed(3)}（>1.25 判定为持续增长）`,
      ).toBeLessThanOrEqual(1.25)
      expect(
        nodesTrend,
        `DOM nodes 后半程均值/前半程 = ${nodesTrend.toFixed(3)}（>1.25 判定为持续增长）`,
      ).toBeLessThanOrEqual(1.25)
      expect(
        parkedHeapTrend,
        `parked（隐藏沉降后）heap 后半程均值/前半程 = ${parkedHeapTrend.toFixed(3)}（>1.25 判定为卸载后滞留累积）`,
      ).toBeLessThanOrEqual(1.25)
      expect(
        parkedNodesTrend,
        `parked（隐藏沉降后）DOM nodes 后半程均值/前半程 = ${parkedNodesTrend.toFixed(3)}（>1.25 判定为卸载后滞留累积）`,
      ).toBeLessThanOrEqual(1.25)
      // 冻结基线（fail-closed：先运行 scripts/summarize-memory-runs.mjs 生成建议值并冻结于 fixtures/soak-memory.baseline.json）
      const baseline = JSON.parse(
        await fsp.readFile(BASELINE_FILE, 'utf-8'),
      ) as { heapMedianBytes: number; nodesMedian: number }
      const heapMedian = median(heap)
      const nodesMedian = median(nodes)
      expect(
        heapMedian,
        `正式轮 heap 中位 ${heapMedian} B 超冻结基线 ${baseline.heapMedianBytes} B（${BASELINE_FILE}）`,
      ).toBeLessThanOrEqual(baseline.heapMedianBytes)
      expect(
        nodesMedian,
        `正式轮 DOM nodes 中位 ${nodesMedian} 超冻结基线 ${baseline.nodesMedian}（${BASELINE_FILE}）`,
      ).toBeLessThanOrEqual(baseline.nodesMedian)
      expect(pageErrors, 'soak 期间不得出现 pageerror').toHaveLength(0)

      const outDir = path.join(ROOT, 'memory-soak-results')
      await fsp.mkdir(outDir, { recursive: true })
      const outFile = path.join(outDir, `memory-soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      await fsp.writeFile(
        outFile,
        JSON.stringify(
          {
            schemaVersion: 1,
            startedAt: new Date(),
            workspace: wsDir,
            warmupRounds: WARMUP_ROUNDS,
            formalRounds: FORMAL_ROUNDS,
            pluginRoutes,
            summary: {
              heapTrend: Number(heapTrend.toFixed(4)),
              nodesTrend: Number(nodesTrend.toFixed(4)),
              parkedHeapTrend: Number(parkedHeapTrend.toFixed(4)),
              parkedNodesTrend: Number(parkedNodesTrend.toFixed(4)),
              firstHalfHeapMean: Math.round(mean(firstHalf(heap))),
              secondHalfHeapMean: Math.round(mean(secondHalf(heap))),
              maxNodes: Math.max(...nodes),
              maxVirtualImages: Math.max(...formalRounds.map((r) => (r.virtualImageCount as number) ?? 0)),
              heapMedian,
              nodesMedian,
              parkedHeapMedian: median(parkedHeap),
              parkedNodesMedian: median(parkedNodes),
              frozenBaseline: { heapMedianBytes: baseline.heapMedianBytes, nodesMedian: baseline.nodesMedian },
            },
            rounds,
          },
          null,
          2,
        ),
      )
      await test.info().attach('memory-soak.json', { body: await fsp.readFile(outFile), contentType: 'application/json' })
      fullJsonWritten = true
      console.log(`[memory-soak] 结果已写 ${outFile}`)
    } finally {
      // 仅当全量 JSON 未写出时落盘已采集轮次（诊断可复现；成功路径不重复写）
      if (rounds.length > 0 && !fullJsonWritten) {
        const outDir = path.join(ROOT, 'memory-soak-results')
        await fsp.mkdir(outDir, { recursive: true }).catch(() => {})
        const outFile = path.join(outDir, `memory-soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        await fsp
          .writeFile(
            outFile,
            JSON.stringify(
              { schemaVersion: 1, partial: true, startedAt: new Date(), workspace: wsDir, pluginRoutes, rounds },
              null,
              2,
            ),
          )
          .catch(() => {})
        console.log(`[memory-soak] 部分结果已写 ${outFile}`)
      }
    }
  })

  // —— 单轮流程（v2.5.3 T8 修订：纯 SPA 导航，不 reload）——
  async function spaTo(url: string): Promise<void> {
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, url)
  }

  async function runOneRound(round: number, formal: boolean) {
    let gridImageCount = 0
    // 1. 图片文件网格：进入 集01/图包/主图，虚拟网格滚动到底（触发懒加载/卸载，滚底采样全量渲染计数）再回顶；预览开/关
    await spaTo('/files/image/集01/主图')
    // 等待缩略图出现（万图工作区下主进程索引构建会延迟缩略图 IPC；等不到则跳过滚动）
    await page
      .waitForFunction(() => document.querySelectorAll('.vscroll img').length > 0, null, { timeout: 15000 })
      .catch(() => {})
    const scroller = page.locator('.vscroll').first()
    try {
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(300)
      // 滚底采样：虚拟化正常时应为视口量级（≈20-50）；若虚拟化完全失效会全量渲染 150 张 → 超 100 断言失败
      gridImageCount = await page.locator('.vscroll img[src^="qihebox://thumb/"]').count()
      await page.waitForTimeout(150)
      await scroller.evaluate((el) => {
        el.scrollTop = 0
      })
      await page.waitForTimeout(150)
      const first = page.locator('.vscroll img[src^="qihebox://thumb/"]').first()
      if (await first.count()) {
        await first.dblclick({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(200)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(120)
      }
    } catch {
      // 网格未就绪则跳过滚动（不视为失败）
    }
    // 1.5 PDF 预览开/关（产品集/证书 页：PdfPreview 解码 + 关闭释放；卡片缺失则跳过）
    await spaTo('/files/cert/集01/证书')
    await page.waitForTimeout(400)
    const pdfCard = page.getByText('证书.pdf').first()
    if (await pdfCard.count()) {
      try {
        await pdfCard.dblclick({ timeout: 5000 })
        await page.waitForTimeout(600)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      } catch { /* 预览未打开不视为失败 */ }
    }
    // 1.6 Markdown 预览开/关（产品集/文档 页：MarkdownPreview createEffect 重载与卸载 setHtml('') 释放；卡片缺失则跳过）
    await spaTo('/files/doc/集01/文档')
    await page.waitForTimeout(400)
    const mdCard = page.getByText('说明.md').first()
    if (await mdCard.count()) {
      try {
        await mdCard.dblclick({ timeout: 5000 })
        await page.waitForTimeout(400)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      } catch { /* 预览未打开不视为失败 */ }
    }
    // 1.7 视频预览开/关（v2.5.3 T5：file_type='video' 网格，<video> 解码 seek 到中段再关闭；卡片缺失则跳过）
    await spaTo('/files/video/集01/素材')
    await page.waitForTimeout(400)
    const videoCard = page.locator('.vscroll [data-file-name^="视频"]').first()
    if (await videoCard.count()) {
      try {
        await videoCard.dblclick({ timeout: 5000 })
        await page.waitForFunction(() => !!document.querySelector('video[src]'), null, { timeout: 5000 }).catch(() => {})
        await page.evaluate(() => {
          const v = document.querySelector('video[src]') as HTMLVideoElement | null
          if (v && v.duration && Number.isFinite(v.duration)) v.currentTime = v.duration / 2 // seek 触发解码
        }).catch(() => {})
        await page.waitForTimeout(300)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(150)
      } catch { /* 预览未打开不视为失败 */ }
    }
    // 2. 路由往返（集卡/证书/搜索/客户/发票/设置）
    for (const route of ['/product-sets', '/certs', '/search', '/clients', '/invoices', '/settings']) {
      await spaTo(route)
      await page.waitForTimeout(120)
    }
    // 3. 插件页往返（hello + conformance.full；安装失败已在 beforeAll fail-closed）
    if (pluginRoutes.length > 0) {
      const routesToVisit = formal ? pluginRoutes.slice(0, 3) : pluginRoutes.slice(0, 1)
      for (const r of routesToVisit) {
        try {
          await spaTo(r)
          await page.waitForTimeout(300)
        } catch {
          pageErrors.push(`plugin route failed: ${r}`)
        }
      }
    }
    // 4. 回到图包集卡页
    await spaTo('/images')
    await page.waitForTimeout(150)
    const metrics = await collectRendererMetrics(app, page, cdp)
    // 5. v2.5.3 T5：重资源隐藏 → parked（业务层卸载）→ 沉降 10s → 无强制 GC 采样（自然释放）→ 恢复
    //    （设计 §7.2：post-GC 趋势与增量释放分开报告；增量释放只用无强制 GC 数据）
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    await page.waitForTimeout(10_000) // 沉降 10s：卸载后自然释放（不强制 GC）
    const parked = await collectRendererMetrics(app, page, cdp, { forceGc: false })
    await page.evaluate(() => (window as any).qihebox.window.show())
    // 恢复 = 直接 show（2026-08-19 热修：FrameWitness 隐藏预检废止）+ 显示后白屏自检兜底
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    await page.waitForTimeout(300)
    return { metrics, gridImageCount, parked }
  }

  async function waitForIndexReady(p: Page): Promise<void> {
    // 轮询文件列表直到索引快照可列出夹具叶子目录（集20/图包/增补 150 图）
    for (let i = 0; i < 200; i++) {
      try {
        const r = await p.evaluate(async () => {
          const res = await (window as any).qihebox.files.list({
            product_set: '集20',
            file_type: 'image',
            media_type: 'image',
            sub_folder: '增补',
          })
          return res?.success === true && Array.isArray(res.data) && res.data.length > 0
        })
        if (r) return
      } catch {
        // 接口未就绪
      }
      await p.waitForTimeout(300)
    }
    throw new Error('工作区索引在 60s 内未就绪')
  }
})

// —— 夹具：20 产品集 × 5 子文件夹 × 150 图（15000 条目，硬链接复用内容）+ 500 客户 + md + 最小 PDF + 视频 ——
async function buildSoakFixture(ws: string): Promise<void> {
  // 真实最小 JPEG（sharp 生成；伪 JPEG 无法解码 → 缩略图生成失败 → 网格只显示占位符）
  const sharp = (await import('sharp')).default
  const thumbSrc = path.join(ws, '.thumb-src.jpg')
  await fsp.writeFile(
    thumbSrc,
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 120, b: 80 } } }).jpeg().toBuffer(),
  )
  // v2.5.3 T5：视频预览重资源（seek-fast.mp4 拷贝，每产品集一份，FilePreviewModal <video> 解码）
  const videoSrc = path.join(ROOT, 'tests', 'e2e', 'fixtures', 'seek-fast.mp4')
  // 使用 hard link 复用内容（不放大写盘）
  const subfolders = ['主图', '详情页', '白底图', '素材', '增补']
  for (let s = 1; s <= 20; s++) {
    const setDir = path.join(ws, '产品集', `集${String(s).padStart(2, '0')}`)
    const imgDir = path.join(setDir, '图包')
    for (const sub of subfolders) {
      const d = path.join(imgDir, sub)
      await fsp.mkdir(d, { recursive: true })
      // 每子文件夹 150 图：虚拟化完全失效时全量渲染 150 张会击穿「≤100」断言（100 图时代恒真退化）
      for (let i = 1; i <= 150; i++) {
        const dst = path.join(d, `图片${s}-${i}.jpg`)
        try {
          await fsp.link(thumbSrc, dst)
        } catch {
          await fsp.copyFile(thumbSrc, dst)
        }
      }
    }
    // v2.5.3 T5：素材子夹放视频（file_type='video' 语义，Image 网格同目录）
    try {
      await fsp.copyFile(videoSrc, path.join(imgDir, '素材', `视频${s}.mp4`))
    } catch {
      /* 视频夹具缺失则跳过（不视为失败） */
    }
    // 每个产品集 1 个证书 pdf + 1 个文档 md
    await fsp.mkdir(path.join(setDir, '证书'), { recursive: true }).catch(() => {})
    await fsp.writeFile(path.join(setDir, '证书', '证书.pdf'), minimalPdf())
    await fsp.mkdir(path.join(setDir, '文档'), { recursive: true }).catch(() => {})
    await fsp.writeFile(path.join(setDir, '文档', '说明.md'), `# ${s}\n\n说明内容 ${s}\n`)
  }
  // 500 客户
  for (let c = 1; c <= 500; c++) {
    const dir = path.join(ws, '客户', `客户${String(c).padStart(3, '0')}`, '沟通')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '沟通.md'), `# 客户${c}`)
  }
  await fsp.rm(thumbSrc, { force: true })
}

function minimalPdf(): string {
  return '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n150\n%%EOF\n'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 把夹具目录「增补/证书/文档」登记为配置内的子文件夹（契约要求经 config API 配置，不依赖
 * 「扫描全部子目录」的宽松实现）：config.get 返回 ApiResult 或直出对象，防御式取值后全量 update。
 */
async function configureExtraSubfolders(p: Page): Promise<void> {
  const ok = await p.evaluate(async () => {
    const get = await (window as any).qihebox.config.get()
    const cfg = get && typeof get === 'object' && !Array.isArray(get) && 'image_subfolders' in get ? get : (get?.data ?? null)
    if (!cfg || typeof cfg !== 'object') throw new Error('读取工作区 config 失败: ' + JSON.stringify(get))
    const append = (arr: unknown, name: string): string[] => Array.from(new Set([...(Array.isArray(arr) ? (arr as string[]) : []), name]))
    const updated = {
      ...cfg,
      image_subfolders: append(cfg.image_subfolders, '增补'),
      cert_subfolders: append(cfg.cert_subfolders, '证书'),
      doc_subfolders: append(cfg.doc_subfolders, '文档'),
    }
    const upd = await (window as any).qihebox.config.update(updated)
    if (upd && typeof upd === 'object' && upd.success === false) throw new Error('更新 config 失败: ' + JSON.stringify(upd))
    return true
  })
  if (!ok) throw new Error('配置夹具子文件夹（增补/证书/文档）失败')
}

/**
 * 安装 soak 插件（hello + conformance.full）并等待插件路由可用（fail-closed）：
 * 插件页往返是 T8 契约内容（插件静态 import 缓存常驻是遗留观察项），不允许静默跳过。
 */
async function installSoakPlugins(p: Page): Promise<string[]> {
  await p.evaluate(async () => {
    const r = await (window as any).qihebox.settings.setDevMode(true)
    if (r && typeof r === 'object' && r.success === false) throw new Error('开启开发者模式失败')
  })
  for (const qbox of [HELLO_QBOX, CONFORMANCE_QBOX]) {
    if (!fs.existsSync(qbox)) {
      throw new Error(`soak 插件产物缺失：${qbox}（先运行 npm run pretest 构建插件夹具）`)
    }
    const ok = await p.evaluate(async (filePath) => {
      const ins = await (window as any).qihebox.plugins.install({ filePath })
      return ins?.success === true
    }, qbox)
    if (!ok) throw new Error(`soak 插件安装失败：${qbox}`)
  }
  for (let i = 0; i < 40; i++) {
    const routes = await p
      .evaluate(async () => {
        const r = await (window as any).qihebox.plugins.list()
        const items = r?.data ?? (Array.isArray(r) ? r : [])
        return (items as Array<{ pages?: Array<{ path?: string }> }>)
          .flatMap((pl) => (pl.pages ?? []).map((pg) => pg.path))
          .filter((p): p is string => typeof p === 'string' && p.startsWith('/plugin/'))
      })
      .catch(() => [] as string[])
    if (routes.length > 0) return routes
    await p.waitForTimeout(500)
  }
  throw new Error('soak 插件安装后 20s 内未见插件路由（pluginRoutes 为空，fail-closed）')
}