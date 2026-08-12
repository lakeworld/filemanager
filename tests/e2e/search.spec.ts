import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 搜索页空状态引导 e2e（v2.4.9 打磨 M6，PLAN §3.6）：
 * 1. 未输入 → 引导：可搜索范围（产品集 / 客户 / 文件 + 客户、供应商、发票、入库、报价区文件本体）+ 可命中示例
 *    （示例用真实可命中词；供应商名/报价单号不参与全局搜索匹配，不用它们）
 * 2. 输词零结果 → 「无匹配」提示（换词），与未输入引导区分两种文案
 * 基建参照 quotes.spec.ts（QIHEBOX_E2E=1 独立 userData；gotoRoute 回初始入口重跑应用启动流同步 currentWorkspace）。
 */
test.describe('搜索页空状态引导 e2e（v2.4.9 M6）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，reload 需回初始入口 */
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护
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

  /** 回初始入口重跑应用启动流（同步 currentWorkspace），再导航到指定路由（pushState + popstate） */
  const gotoRoute = async (route: string) => {
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, route)
  }

  test('未输入 → 空状态引导：可搜索范围 + 可命中示例可见', async () => {
    await gotoRoute('/search')
    // 引导标题（EmptyState h3）
    await expect(page.getByRole('heading', { name: '搜索产品集、客户和文件' })).toBeVisible({ timeout: 15000 })
    // 可搜索范围：产品集 / 客户 / 文件 + 客户、供应商、发票、入库、报价区文件本体
    await expect(page.getByText(/可搜索：产品集名、客户名/)).toBeVisible()
    await expect(page.getByText(/客户、供应商、发票、入库、报价区/)).toBeVisible()
    // 可命中示例（真实可命中词；不出现供应商名/报价单号）
    await expect(page.getByText(/试试搜：夏季T恤/)).toBeVisible()
  })

  test('输词零结果 → 「无匹配」提示（换词），未输入引导消失', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-search-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await gotoRoute('/search')
    // 等待工作区同步完成（doSearch 前置条件：currentWorkspace 非空）
    await page.waitForFunction(
      async () => {
        const r = await (window as any).qihebox.workspace.current()
        return r.success && !!r.data
      },
      null,
      { timeout: 10000 },
    )
    // 先确认未输入态引导可见
    await expect(page.getByText(/试试搜：夏季T恤/)).toBeVisible({ timeout: 15000 })

    // 输一个不可能命中的词 → 搜索 → 「无匹配」文案（提示换词），引导同时消失
    const searchInput = page.getByPlaceholder('输入关键词搜索...')
    await searchInput.fill('绝对命不中的关键词xyzzy')
    await searchInput.press('Enter')
    await expect(page.getByText(/无匹配/)).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/试试搜：夏季T恤/)).not.toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
