import { test, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const OUT_DIR = process.env.QIHE_SHOT_DIR || path.join(os.tmpdir(), 'v258-time-fields')
const TAG = process.env.QIHE_SHOT_TAG || 'x'

/**
 * v2.5.8 A3 时间本地化取证探针（诊断用，**不进默认套件**：probe-* 通配排除）。
 * 用途：挂账 W-02——详情页 `创建于/更新于/确认于` 直出 ISO(UTC) 原文，改前/改后同机位对比。
 * 覆盖四面：客户详情 / 供应商详情 / 报价详情（含 confirmed_at）/ 产品集卡片 created_at。
 * 跑法：QIHE_SHOT_DIR=<目录> QIHE_SHOT_TAG=before npx playwright test --config=playwright.probe.config.ts tests/e2e/probe-time-fields.spec.ts
 */
test.describe('详情页时间字段取证（probe，不入默认套件）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    await fsp.mkdir(OUT_DIR, { recursive: true })
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('probe-time-fields') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-time-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      const api = (window as any).qihebox
      await api.clients.create({ name: '走查客户' })
      await api.clients.update({ name: '走查客户', notes: '取证备注' }) // 触发 updated_at 落值
      await api.suppliers.create({ name: '走查供应商' })
      await api.suppliers.update({ name: '走查供应商', notes: '取证备注' })
      await api.productSets.create({ name: '走查系列' })
      await api.quotes.create({
        date: '2026-09-05',
        lines: [{ product: '走查品', qty: 1, unit_price: 1, amount: 1 }],
      })
    })
    // 草稿→已确认：触发 confirmed_at 落值（单号经 readFirstQuoteNo 从列表读；Node 侧上下文）
    const no = await readFirstQuoteNo()
    console.log(`[tmprobe] tag=${TAG} 报价单号=${no}`)
    if (no) {
      await page.evaluate(async (no) => {
        await (window as any).qihebox.quotes.setStatus(no, '已确认')
      }, no)
    }
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

  // IPC 统一 ApiResult 信封 {ok,data}——取值须解 .data（beforeAll 置确认态与 test 体取单号共用）
  const readFirstQuoteNo = (): Promise<string> =>
    page.evaluate(async () => {
      const res = await (window as any).qihebox.quotes.list()
      const list = Array.isArray(res?.data) ? res.data : []
      return list[0]?.quotation_no ?? ''
    })

  const goto = async (url: string): Promise<void> => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // v2.5.7 补丁：hash 路由下 goto 去 fragment 不重载，复位 + reload 取干净挂载
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
    await page.waitForTimeout(700)
  }

  const timeText = (): Promise<string> =>
    page.evaluate(() => {
      const leaves = [...document.querySelectorAll('p, td, div')].filter((e) => e.children.length === 0)
      const labeled = leaves.find(
        (e) => /创建于|确认于/.test(e.textContent ?? '') && /\d{4}/.test(e.textContent ?? ''),
      )
      if (labeled) return labeled.textContent?.trim() ?? '(空)'
      // 产品集卡片：created_at 无文案标签，按年份兜底匹配
      const bare = leaves.find((e) => /^\d{4}-\d{2}-\d{2}/.test(e.textContent?.trim() ?? ''))
      return bare?.textContent?.trim() ?? '(未找到时间行)'
    })

  test('四面时间字段渲染文本 + 截图留档', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const no = await readFirstQuoteNo()

    await goto('/clients/' + encodeURIComponent('走查客户'))
    console.log(`[tmprobe] tag=${TAG} 客户详情：${await timeText()}`)
    await page.screenshot({ path: path.join(OUT_DIR, `client-${TAG}.png`), timeout: 12000 }).catch(() => {})

    await goto('/suppliers/' + encodeURIComponent('走查供应商'))
    console.log(`[tmprobe] tag=${TAG} 供应商详情：${await timeText()}`)
    await page.screenshot({ path: path.join(OUT_DIR, `supplier-${TAG}.png`), timeout: 12000 }).catch(() => {})

    await goto('/quotes/' + encodeURIComponent(no))
    console.log(`[tmprobe] tag=${TAG} 报价详情（${no}）：${await timeText()}`)
    await page.screenshot({ path: path.join(OUT_DIR, `quote-${TAG}.png`), timeout: 12000 }).catch(() => {})

    await goto('/product-sets')
    console.log(`[tmprobe] tag=${TAG} 产品集列表卡片：${await timeText()}`)
    await page.screenshot({ path: path.join(OUT_DIR, `productset-${TAG}.png`), timeout: 12000 }).catch(() => {})

    console.log(`[tmprobe] 截图已写 ${OUT_DIR}（tag=${TAG}）`)
  })
})
