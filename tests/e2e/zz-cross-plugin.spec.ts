import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGINS_DIST = process.env.QIHE_PLUGINS_DIST ?? ''

// 本地验证用（依赖外部 LAN/cloud qbox，不纳入公开 CI）：
// 跨插件互切回归（2026-08-16 用户报「切换会卡住」）——LAN ↔ 启禾云 ↔ 本体页 往返多轮，
// 断言内容即时替换、无 pageerror、无卡死在「插件页面加载中…」。
test('跨插件 tab 互切：LAN ↔ 启禾云 ↔ 设置 往返不卡住', async () => {
  // v2.5.2：注释承诺「不纳入公开 CI」未落实——qbox 产物在内部插件仓（qihe-plugins/dist），
  // 公开 CI checkout 拿不到 → 安装报「安装包不存在」。与崩溃模拟用例同款 skip 惯例。
  test.skip(!!process.env.CI || !PLUGINS_DIST, '依赖内部插件仓 .qbox 产物，公开 CI 不可用——本地验证需 QIHE_PLUGINS_DIST')
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
  const goto = async (p: string) => {
    await page.evaluate((path) => {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, p)
  }
  try {
    await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
    for (const id of ['com.qihe.lan', 'com.qihe.cloud']) {
      await page.evaluate(async (pid) => (window as any).qihebox.plugins.uninstall(pid), id).catch(() => {})
    }
    for (const f of ['com.qihe.lan.qbox', 'com.qihe.cloud.qbox']) {
      const ins = await page.evaluate(
        async (p) => (window as any).qihebox.plugins.install({ filePath: p }),
        path.join(PLUGINS_DIST, f),
      )
      expect(ins.success, `install ${f} err: ${String(ins.error)}`).toBe(true)
    }

    for (let round = 0; round < 3; round++) {
      // LAN（真实点击侧边栏插件项，与用户操作一致）
      await page.getByRole('button', { name: '🖥️ 局域网协作' }).click()
      await expect(page.getByRole('heading', { name: '局域网设备' })).toBeVisible({ timeout: 15000 })
      // 启禾云（跨插件切换）
      await page.getByRole('button', { name: '☁️ 启禾云' }).click()
      await expect(page.getByRole('heading', { name: '启禾云' })).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('heading', { name: '局域网设备' })).toHaveCount(0)
      // 本体页（设置）
      await goto('/settings')
      await expect(page.getByRole('heading', { name: '启禾云' })).toHaveCount(0)
      // 加载指示不得残留（卡死探针）
      await expect(page.getByText('插件页面加载中…')).toHaveCount(0)
    }
    expect(errs).toEqual([])
  } finally {
    for (const id of ['com.qihe.lan', 'com.qihe.cloud']) {
      try {
        await page.evaluate(async (pid) => (window as any).qihebox.plugins.uninstall(pid), id)
      } catch {
        /* 应用可能已退出 */
      }
    }
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }
})
