import { test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const OUT_DIR = process.env.QIHE_SHOT_DIR || path.join(os.tmpdir(), 'v258-inv-toolbar')
const TAG = process.env.QIHE_SHOT_TAG || 'x'
const WIDTHS = [1440, 1024, 900, 768, 640]

/**
 * v2.5.8 A2 窄宽取证探针（诊断用，**不进默认套件**：playwright.config.ts probe-* 通配排除）。
 * 用途：发票筛选行窄宽防挤（挂账 W-01）改前/改后对比——数值（行内容溢出量 + 子项越界量）
 * + 截图同机位出档，交人工目视与 PLAN 验收。
 *
 * 跑法：QIHE_SHOT_DIR=<目录> QIHE_SHOT_TAG=before npx playwright test tests/e2e/probe-invoice-toolbar.spec.ts --reporter=line
 */
interface RowStat {
  gapToPage: number
  childOverhang: number
  swMinusCw: number
  childWidths: string
}

test.describe('发票筛选行窄宽取证（probe，不入默认套件）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    await fsp.mkdir(OUT_DIR, { recursive: true })
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-inv-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
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

  const goto = async (url: string): Promise<void> => {
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, url)
    await page.waitForTimeout(700)
  }

  test('多窄视口：筛选行溢出数值 + 截图留档', async () => {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 800 })
      await goto('/invoices')
      await page.waitForTimeout(300)
      const stats = await page.evaluate(() => {
        const root = [...document.querySelectorAll('div')].find(
          (d) => typeof d.className === 'string' && d.className.includes('mb-4') && d.className.includes('flex-col'),
        )
        const pageOverflow = document.documentElement.scrollWidth - window.innerWidth
        if (!root) return { pageOverflow, rows: null }
        const rows = [...(root as HTMLElement).children] as HTMLElement[]
        const stat = (row: HTMLElement): RowStat => {
          const rr = row.getBoundingClientRect()
          let overhang = 0
          for (const c of row.children) {
            const cr = c.getBoundingClientRect()
            overhang = Math.max(overhang, Math.round(cr.right - rr.right), Math.round(rr.left - cr.left))
          }
          return {
            gapToPage: Math.round(window.innerWidth - rr.right),
            childOverhang: overhang,
            swMinusCw: row.scrollWidth - row.clientWidth,
            childWidths: [...row.children].map((c) => Math.round(c.getBoundingClientRect().width)).join(','),
          }
        }
        return { pageOverflow, rows: rows.map(stat) }
      })
      console.log(`[invprobe] ${w}px pageOverflow=${stats.pageOverflow} rows=${JSON.stringify(stats.rows)}`)
      await page.screenshot({ path: path.join(OUT_DIR, `${w}-${TAG}.png`), timeout: 12000 }).catch(() => {})
    }
    console.log(`[invprobe] 截图已写 ${OUT_DIR}（tag=${TAG}）`)
  })
})
