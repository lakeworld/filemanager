import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.QIHE_PLUGINS_DIST ?? ''
const ERP_QBOX = DIST ? path.join(DIST, 'com.qihe.erp.bridge.qbox') : ''
const PLUGIN_ID = 'com.qihe.erp.bridge'

// 本地验证用（依赖内部插件仓 .qbox，不纳入公开 CI）：ERP 桥接页——未登录 D24 门控 +
// 渲染器真实执行 + IPC 契约冒烟（status/subjects/queue/cloudOnly 在未登录态的行为）。
test('ERP 桥接页：未登录门控 + 渲染执行 + IPC 冒烟', async () => {
  test.skip(!!process.env.CI || !ERP_QBOX, '依赖内部插件仓 .qbox 产物，公开 CI 不可用——本地验证需 QIHE_PLUGINS_DIST')
  const app: ElectronApplication = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, QIHEBOX_E2E: '1' },
  })
  const page: Page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  try {
    await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), ERP_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/plugin/erp/bridge')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // 未登录门控：横幅①可见（D24）
    await expect(page.getByText('🔒 未登录：请到 我的→账号 登录启禾 OS 账号')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('heading', { name: 'ERP 桥接' })).toBeVisible()

    // 客户端渲染已由「横幅可见」证明（server Solid 空实现不会产出这些节点）——
    // __devEffect 是 LAN 渲染器的计数，erp-bridge 无此全局，故不以此断言。

    // IPC 冒烟（未登录态）：status / subjects / queue / cloudOnly
    const status = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'status', {}), PLUGIN_ID)
    expect(status.success).toBe(true)
    expect(status.data.loggedIn).toBe(false)
    expect(status.data.pluginVersion).toBe('0.4.0')
    expect(status.data.autoPush).toBe(false) // R11 默认关
    expect(status.data.queueDepth).toBe(0)
    expect(status.data.deadCount).toBe(0)
    expect(status.data.cloudOnlyCount).toBe(0)

    const subjects = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'subjects', {}), PLUGIN_ID)
    expect(subjects.data.ok).toBe(false)
    expect(subjects.data.error).toBe('NOT_LOGGED_IN') // 未登录不发云请求

    const queue = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'queue.list', {}), PLUGIN_ID)
    expect(queue.data.items).toEqual([])
    const cloudOnly = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'cloudOnly.list', {}), PLUGIN_ID)
    expect(cloudOnly.data.items).toEqual([])

    expect(errs).toEqual([])
  } finally {
    try {
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID)
    } catch {
      /* 应用可能已退出 */
    }
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }
})
