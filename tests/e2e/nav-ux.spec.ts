import { WAKE_SEARCH_ACCELERATOR } from '../../src/shared/appSettings'
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 导航体验 e2e（v2.5.9 A6-2 / A6-3）：
 * - A6-3：新建产品集成功后**直接进该产品集详情**（此前停在列表页，用户得自己再找一遍）；
 * - A6-2：搜索提交把现场写回 URL（`/search?q=…`，replace 不堆历史）+ 顶栏「← 后退」`navigate(-1)`，
 *   让「搜到 → 打开 → 退回搜索结果」这条动线闭合。
 *
 * ⚠ 预填链边界（A6-3）不放这里：它在 `create-prefill.spec.ts` 的 productSet 用例里就地断言
 * （插件连续建多条时**必须**留在列表页，跳详情会断 `advancePrefill` 链）。
 */
test.describe('导航体验（v2.5.9 A6-2/A6-3）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('nav-ux') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-navux-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
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

  /** 读当前 hash 路由（HashRouter：真实路径在 `location.hash` 里） */
  const currentRoute = () => page.evaluate(() => window.location.hash)

  test('A6-3：手动新建产品集 ⇒ 直接进入该产品集详情（URL 不再是列表页）', async () => {
    await page.evaluate(() => { window.location.hash = '#/product-sets' })
    await expect(page.getByRole('heading', { name: '产品集', exact: true }).first()).toBeVisible({ timeout: 15000 })

    await page.getByRole('button', { name: /新建产品集/ }).first().click()
    const dlg = page.locator('[role="dialog"][aria-label="新建产品集"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await dlg.locator('input[placeholder="如：夏季T恤系列"]').fill('导航用例集A')
    await dlg.getByRole('button', { name: '确认创建' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })

    // 直入详情：路由带名字，且详情页渲染出该集标题
    await expect.poll(currentRoute, { timeout: 10000 }).toContain('/product-sets/')
    await expect.poll(currentRoute).toContain(encodeURIComponent('导航用例集A'))
  })

  test('A6-1：主进程广播唤醒事件 ⇒ 落到搜索页且光标进输入框', async () => {
    // 先在别的路由上（模拟"用户在看产品集时按了唤醒热键"）
    await page.evaluate(() => { window.location.hash = '#/product-sets' })
    await expect(page.getByRole('heading', { name: '产品集', exact: true }).first()).toBeVisible({ timeout: 15000 })

    // 主进程侧广播（真实链路 = globalShortcut 回调 → show/focus → 本事件；这里只验后半段：
    // 事件到达渲染层后的导航 + 聚焦。前半段的注册/注销由 A6-1 单测 + 设置开关用例覆盖）
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('qihebox:event:window:wake-search')
    })

    await expect.poll(currentRoute, { timeout: 10000 }).toContain('/search')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ''), { timeout: 10000 })
      .toBe('search-page-input')
  })

  test('A6-1：设置里开启 ⇒ 主进程真注册；关闭 ⇒ 真注销（默认关）', async () => {
    // Playwright 的 app.evaluate：pageFunction 第一参 = electron 模块，第二参 = 传进去的 arg。
    // ⚠ 原写法把键位钉成字面量 `'Control+Alt+K'`：换键之后它会**永远去查一把没人注册的键**，
    //  于是"关态未注册"这条断言静默常真 = 假绿。改成引用常量，才是真在查我们注册的那把。
    const isRegistered = () =>
      app.evaluate(
        (electronModule: typeof import('electron'), accel: string) =>
          electronModule.globalShortcut.isRegistered(accel),
        WAKE_SEARCH_ACCELERATOR,
      )

    // 默认关：不得"升级后自动占用系统按键"
    const settings = await page.evaluate(async () => (window as any).qihebox.appSettings.get())
    expect(settings.data.globalWakeShortcut).toBe(false)
    expect(await isRegistered()).toBe(false)

    await page.evaluate(async () => { await (window as any).qihebox.appSettings.set({ globalWakeShortcut: true }) })
    await expect.poll(isRegistered, { timeout: 10000 }).toBe(true)

    await page.evaluate(async () => { await (window as any).qihebox.appSettings.set({ globalWakeShortcut: false }) })
    await expect.poll(isRegistered, { timeout: 10000 }).toBe(false)
  })

  test('A6-2：搜索提交写回 URL；顶栏「← 后退」把现场带回来', async () => {
    // 准备一条可搜到的数据（走 IPC，不经 UI，避免用例耦合建库流程）
    await page.evaluate(async () => {
      await (window as any).qihebox.productSets.create({ name: '导航搜索目标B', tags: [], notes: '' })
    })

    await page.evaluate(() => { window.location.hash = '#/search' })
    await expect(page.getByRole('heading', { name: '搜索', exact: true }).first()).toBeVisible({ timeout: 15000 })

    const input = page.getByPlaceholder('输入关键词搜索...')
    await input.fill('导航搜索目标B')
    await input.press('Enter')
    // ① URL 写回（replace）——搜索条件从"只活在信号里"变成可恢复的入口
    await expect.poll(currentRoute, { timeout: 10000 }).toContain('q=')
    await expect.poll(currentRoute).toContain(encodeURIComponent('导航搜索目标B'))

    const card = page.locator('.card', { hasText: '导航搜索目标B' }).first()
    await card.waitFor({ timeout: 15000 })
    await card.click()
    await expect.poll(currentRoute, { timeout: 10000 }).toContain('/product-sets/')

    // ② 顶栏后退回到搜索结果页（路由带 q，结果仍在）
    await page.getByRole('button', { name: '后退' }).click()
    await expect.poll(currentRoute, { timeout: 10000 }).toContain('/search')
    await expect(page.locator('.card', { hasText: '导航搜索目标B' }).first()).toBeVisible({ timeout: 15000 })
  })
})