import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 渲染性能灾难回归探针（v2.5.1 T4，D4）：
 * - 懒加载路由首渲染耗时（performance.now 打点）
 * - 阈值 = 实施时基线实测 ×3（不追精细回归，只抓灾难性回退）
 * 基线（2026-08-15 首次实测，Deepin）：路由首渲染 < 800ms 量级 → 阈值 3000ms。
 */
test.describe('渲染性能探针（v2.5.1 D4）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-perf-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
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

  const ROUTES = [
    '/',
    '/product-sets',
    '/images',
    '/certs',
    '/search',
    '/settings',
    '/profile',
    '/trash',
    '/clients',
    '/invoices',
  ]

  test('懒加载路由首渲染 < 阈值（基线×3 = 3000ms，D4 灾难回归）', async () => {
    for (const route of ROUTES) {
      await page.goto(INDEX_URL)
      await page.waitForLoadState('domcontentloaded')
      const start = Date.now()
      await page.evaluate((u) => {
        window.history.pushState({}, '', u)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, route)
      // 等路由组件挂载：页面出现实质性内容（非空白 root 骨架）
      await page.waitForFunction(
        () => (document.querySelector('#root')?.textContent?.length ?? 0) > 200,
        null,
        { timeout: 10000 },
      )
      const elapsed = Date.now() - start
      expect(elapsed, `route ${route} 首渲染 ${elapsed}ms`).toBeLessThan(3000)
    }
  })
})
