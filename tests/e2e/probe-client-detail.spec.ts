import { test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const OUT_DIR = process.env.QIHE_SHOT_DIR || path.join(os.tmpdir(), 'v258-client-detail')
const TAG = process.env.QIHE_SHOT_TAG || 'x'

/**
 * v2.5.8 A3 客户详情时间本地化取证探针（诊断用，**不进默认套件**：probe-* 通配排除）。
 * 用途：挂账 W-02——详情页 `创建于/更新于` 直出 ISO(UTC) 原文，改前/改后同机位对比。
 * 跑法：QIHE_SHOT_DIR=<目录> QIHE_SHOT_TAG=before npx playwright test --config=playwright.probe.config.ts tests/e2e/probe-client-detail.spec.ts
 */
test.describe('客户详情时间字段取证（probe，不入默认套件）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    await fsp.mkdir(OUT_DIR, { recursive: true })
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      const api = (window as any).qihebox.clients
      await api.create({ name: '走查客户' })
      await api.update({ name: '走查客户', notes: '取证备注' }) // 触发 updated_at 落值
    })
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

  test('详情页 创建于/更新于 渲染文本 + 截图留档', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, '/clients/' + encodeURIComponent('走查客户'))
    await page.waitForTimeout(700)
    const timeLine = await page.evaluate(() => {
      const els = [...document.querySelectorAll('p')]
      const el = els.find((e) => e.textContent?.includes('创建于'))
      return el?.textContent?.trim() ?? '(未找到创建于行)'
    })
    console.log(`[clprobe] tag=${TAG} 时间行原文：${timeLine}`)
    await page.screenshot({ path: path.join(OUT_DIR, `client-detail-${TAG}.png`), timeout: 12000 }).catch(() => {})
    console.log(`[clprobe] 截图已写 ${OUT_DIR}（tag=${TAG}）`)
  })
})
