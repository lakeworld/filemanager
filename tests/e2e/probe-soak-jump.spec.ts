/**
 * probe-soak-jump.spec.ts —— soak 中途一次性跳变归因探针（2026-08-31 发布轮 D-11 取证）
 *
 * 现象（两次独立完整 soak，均破同一道 parkedHeapTrend 阈值 1.329 / 1.393）：
 *   沉降后 heap 9.3 → 14.1MB、DOM nodes 1250 → 1729、JSEventListener 60 → 166，
 *   跳变落在第 8 / 第 9 正式轮（**落点轮次不稳定，量级逐字节复现**），此后 12 轮极差仅 0.11MB。
 *   门禁用的是前/后半程均值比：一次性台阶会被折算成「持续增长」，所以破阈值本身不证明泄漏。
 *
 * 本探针把 soak 单轮的 11 个步骤逐个拆开、每步后采样，并连跑 4 圈：
 *   ① 哪一步造出 +106 listeners / +479 nodes（归因）；
 *   ② 同一步重复 4 圈是否继续涨（台阶 = 一次性常驻，斜坡 = 每次挂载都残留 = P1 真缺陷）。
 * 另附 DOM 普查（tag.首类名 计数）逐样本留档，用于点名滞留子树。
 *
 * 运行：npx playwright test --config=playwright.probe.config.ts probe-soak-jump
 * 输出：tests/e2e/probe-results/soak-jump-<ts>.json（probe-results 已被 .gitignore 排除）
 * 注意：与 memory-soak / 默认 e2e 抢单实例锁，不得并行。
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
const E2E_USER_DATA = path.join(os.tmpdir(), 'qihebox-e2e-userdata')
const HELLO_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')
const CONFORMANCE_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.conformance.full.qbox')
const LAPS = 4
const SET = '探针系列'

interface Sample {
  lap: number
  step: string
  listeners: number
  nodes: number
  heapMB: number
  documents: number
  census: Record<string, number>
}

test.describe('soak 跳变归因（probe，不入默认套件）', () => {
  test('逐步采样 4 圈：定位台阶制造者，并判定台阶 or 斜坡', async () => {
    test.setTimeout(22 * 60 * 1000)
    // e2e userData 是固定共享目录：清掉插件残留，保证「首次触达」真的是首次
    await fsp.rm(path.join(E2E_USER_DATA, 'plugins'), { recursive: true, force: true })

    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-jump-'))
    await buildFixture(wsDir)
    const app: ElectronApplication = await electron.launch({
      args: ['.', '--no-sandbox', '--js-flags=--expose-gc'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    const page = await app.firstWindow()
    try {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 30000 })
      await page.evaluate(async (dir) => {
        const r = await (window as any).qihebox.workspace.open(dir)
        if (!r?.success) throw new Error('打开工作区失败: ' + JSON.stringify(r))
      }, wsDir)
      await page.goto(INDEX_URL)
      await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 30000 })
      // 不以 Dashboard 为就绪锚点（万文件下首载统计极慢，soak 同款处理）：直接进 /images
      await spaTo(page, '/images')
      await expect(page.getByRole('heading', { name: '图包库', level: 1 })).toBeVisible({ timeout: 60000 })

      const cdp = await app.context().newCDPSession(page)
      expect(Object.keys((await probeCdpCapabilities(cdp)).errors), 'CDP 能力缺失').toHaveLength(0)

      const samples: Sample[] = []
      const snap = async (lap: number, step: string): Promise<void> => {
        const m = await collectRendererMetrics(app, page, cdp)
        samples.push({
          lap,
          step,
          listeners: m.listeners,
          nodes: m.nodes,
          heapMB: +(m.heapUsedBytes / 2 ** 20).toFixed(2),
          documents: m.documents,
          census: await page.evaluate(() => {
            const c: Record<string, number> = {}
            for (const el of Array.from(document.getElementsByTagName('*'))) {
              const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
              const k = el.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 28) : '')
              c[k] = (c[k] || 0) + 1
            }
            return c
          }),
        })
      }

      await snap(0, 'baseline@/images')
      let pluginRoutes: string[] = []
      for (let lap = 1; lap <= LAPS; lap++) {
        await stepImageGrid(page)
        await snap(lap, '图网格+图片预览')
        await stepCardPreview(page, `/files/cert/${SET}/证书`, '证书.pdf')
        await snap(lap, 'PDF 预览')
        await stepCardPreview(page, `/files/doc/${SET}/文档`, '说明.md')
        await snap(lap, 'MD 预览/编辑')
        await stepCardPreview(page, `/files/video/${SET}/素材`, '视频')
        await snap(lap, '视频预览')
        for (const route of ['/product-sets', '/certs', '/search', '/clients', '/invoices', '/settings']) {
          await spaTo(page, route)
          await page.waitForTimeout(300)
          await snap(lap, '路由 ' + route)
        }
        if (pluginRoutes.length === 0) pluginRoutes = await installPluginsAndListRoutes(page)
        for (const r of pluginRoutes) {
          await spaTo(page, r)
          await page.waitForTimeout(400)
          await snap(lap, '插件页 ' + r)
        }
        await spaTo(page, '/images')
        await page.waitForTimeout(200)
        await snap(lap, '回图包集卡')
      }

      // 隐藏沉降（复现 soak 的 parked 口径：无强制 GC）
      await page.evaluate(() => (window as any).qihebox.window.hideToTray())
      await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
      await page.waitForTimeout(10_000)
      const parked = await collectRendererMetrics(app, page, cdp, { forceGc: false })
      await page.evaluate(() => (window as any).qihebox.window.show())

      const outDir = path.join(ROOT, 'tests', 'e2e', 'probe-results')
      await fsp.mkdir(outDir, { recursive: true })
      const outFile = path.join(outDir, `soak-jump-${Date.now()}.json`)
      await fsp.writeFile(outFile, JSON.stringify({ samples, parked, laps: LAPS }, null, 2))

      // 逐步增量（第 1 圈内）+ 每圈净增量（跨圈比较，判台阶/斜坡）
      const lines: string[] = [`[soak-jump] 明细：${outFile}`]
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]
        const b = samples[i]
        const dl = b.listeners - a.listeners
        const dn = b.nodes - a.nodes
        if (Math.abs(dl) > 5 || Math.abs(dn) > 40) {
          lines.push(`  lap${b.lap} ${b.step}: L ${a.listeners}→${b.listeners} (${dl >= 0 ? '+' : ''}${dl})  N ${a.nodes}→${b.nodes} (${dn >= 0 ? '+' : ''}${dn})  heap ${a.heapMB}→${b.heapMB}MB`)
          lines.push('    新增元素：' + topDiff(a.census, b.census))
        }
      }
      const stepNames = samples.filter((s) => s.lap === 1).map((s) => s.step)
      lines.push('  —— 同步骤跨圈对比（0 或负 = 一次性常驻；正 = 逐圈残留）——')
      const leakSteps: string[] = []
      for (const step of stepNames) {
        const seq = samples.filter((s) => s.step === step)
        const dl = seq[seq.length - 1].listeners - seq[0].listeners
        const dn = seq[seq.length - 1].nodes - seq[0].nodes
        if (dl > 2 || dn > 20) leakSteps.push(`${step}(+${dl}L/+${dn}N over ${seq.length} laps)`)
        lines.push(`  ${step}: 首圈 L${seq[0].listeners}/N${seq[0].nodes} → 末圈 L${seq[seq.length - 1].listeners}/N${seq[seq.length - 1].nodes}  Δ${dl >= 0 ? '+' : ''}${dl}L Δ${dn >= 0 ? '+' : ''}${dn}N`)
      }
      lines.push(`[soak-jump] 隐藏沉降后（无强制 GC）：L=${parked.listeners} N=${parked.nodes} heap=${(parked.heapUsedBytes / 2 ** 20).toFixed(2)}MB`)
      for (const l of lines) console.log(l)

      expect(leakSteps, `以下步骤逐圈累积（每次挂载都有残留，属真泄漏）：${leakSteps.join('; ')}`).toEqual([])
    } finally {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

function topDiff(before: Record<string, number>, after: Record<string, number>, n = 8): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const diffs = [...keys]
    .map((k) => [k, (after[k] || 0) - (before[k] || 0)] as [string, number])
    .filter(([, d]) => d !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
  return diffs.map(([k, d]) => `${k}${d > 0 ? '+' : ''}${d}`).join(' ') || '（无元素增减）'
}

async function spaTo(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    window.history.pushState({}, '', u)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, url)
}

/** soak 步骤 1 复刻：进图网格 → 等缩略图 → 滚到底 → 回顶 → 双击首图开预览 → Esc */
async function stepImageGrid(page: Page): Promise<void> {
  await spaTo(page, `/files/image/${SET}/主图`)
  await page
    .waitForFunction(() => document.querySelectorAll('.vscroll img[src^="qihebox://thumb/"]').length > 0, null, { timeout: 60000 })
    .catch(() => {})
  const scroller = page.locator('.vscroll').first()
  await scroller.evaluate((el) => void ((el as HTMLElement).scrollTop = el.scrollHeight)).catch(() => {})
  await page.waitForTimeout(300)
  await scroller.evaluate((el) => void ((el as HTMLElement).scrollTop = 0)).catch(() => {})
  await page.waitForTimeout(150)
  const first = page.locator('.vscroll img[src^="qihebox://thumb/"]').first()
  if (await first.count()) {
    await first.dblclick({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(250)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

/** soak 步骤 1.5/1.6/1.7 复刻：进入目录 → 双击目标卡片开预览 → Esc */
async function stepCardPreview(page: Page, route: string, text: string): Promise<void> {
  await spaTo(page, route)
  await page.waitForTimeout(400)
  const card = page.locator(`.vscroll [data-file-name^="${text}"]`).first()
  const target = (await card.count()) ? card : page.getByText(text, { exact: false }).first()
  if (!(await target.count())) return
  await target.dblclick({ timeout: 6000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  // 编辑器类预览可能需二次 Esc（Crepe 编辑态有自身焦点层）
  if (await page.locator('.ProseMirror').count()) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
}

async function installPluginsAndListRoutes(page: Page): Promise<string[]> {
  await page.evaluate(async () => {
    await (window as any).qihebox.settings.setDevMode(true)
  })
  for (const qbox of [HELLO_QBOX, CONFORMANCE_QBOX]) {
    if (!fs.existsSync(qbox)) throw new Error(`插件产物缺失：${qbox}（先 npm run pretest:memory-soak）`)
    const ok = await page.evaluate(async (filePath) => (await (window as any).qihebox.plugins.install({ filePath }))?.success === true, qbox)
    if (!ok) throw new Error(`插件安装失败：${qbox}`)
  }
  for (let i = 0; i < 40; i++) {
    const routes: string[] = await page.evaluate(async () => {
      const r = await (window as any).qihebox.plugins.list()
      const items = r?.data ?? (Array.isArray(r) ? r : [])
      return (items as Array<{ pages?: Array<{ path?: string }> }>)
        .flatMap((pl) => (pl.pages ?? []).map((pg) => pg.path))
        .filter((p): p is string => typeof p === 'string' && p.startsWith('/plugin/'))
    })
    if (routes.length > 0) return routes
    await page.waitForTimeout(500)
  }
  throw new Error('插件安装后 20s 内未见插件路由')
}

/** 小夹具：170 张真 JPEG（硬链复用；须能解码出缩略图）+ 证书/文档/视频/笔记 */
async function buildFixture(ws: string): Promise<void> {
  const sharp = (await import('sharp')).default
  const src = path.join(ws, '.thumb-src.jpg')
  await fsp.writeFile(
    src,
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 120, b: 80 } } }).jpeg().toBuffer(),
  )
  const setDir = path.join(ws, '产品集', SET)
  const imgDir = path.join(setDir, '图包')
  for (const sub of ['主图', '素材']) await fsp.mkdir(path.join(imgDir, sub), { recursive: true })
  for (let i = 1; i <= 170; i++) {
    const dst = path.join(imgDir, '主图', `图片${String(i).padStart(3, '0')}.jpg`)
    try {
      await fsp.link(src, dst)
    } catch {
      await fsp.copyFile(src, dst)
    }
  }
  await fsp.copyFile(path.join(ROOT, 'tests', 'e2e', 'fixtures', 'seek-fast.mp4'), path.join(imgDir, '素材', '视频1.mp4'))
  await fsp.mkdir(path.join(setDir, '证书'), { recursive: true })
  await fsp.writeFile(
    path.join(setDir, '证书', '证书.pdf'),
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n150\n%%EOF\n',
  )
  await fsp.mkdir(path.join(setDir, '文档'), { recursive: true })
  await fsp.writeFile(path.join(setDir, '文档', '说明.md'), `# ${SET}\n\n说明内容\n`)
  await fsp.mkdir(path.join(setDir, '文档', '笔记'), { recursive: true })
  await fsp.writeFile(path.join(setDir, '文档', '笔记', '编辑器.md'), '# 探针笔记\n\n- 甲\n- 乙\n')
  for (let c = 1; c <= 5; c++) {
    const dir = path.join(ws, '客户', `客户${String(c).padStart(3, '0')}`, '沟通')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '沟通.md'), `# 客户${c}`)
  }
  await fsp.rm(src, { force: true })
}
