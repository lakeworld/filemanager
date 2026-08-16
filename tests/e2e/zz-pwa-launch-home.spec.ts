import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZipEntry } from './conformance/helpers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLOUD_QBOX = '/home/lake/Nutstore Files/我的坚果云/启禾/qihe-plugins/dist/com.qihe.cloud.qbox'

// 本地验证用（依赖外部 cloud qbox，不纳入公开 CI）：启禾云一页双按钮 —— 标题 / 未登录横幅 / 双按钮禁用（未登录门控）
test('启禾云 Home：标题 + 未登录横幅 + 双按钮禁用（未登录门控）', async () => {
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
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.cloud').catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), CLOUD_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/plugin/cloud')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    // 页面标题
    await expect(page.getByRole('heading', { name: '启禾云' })).toBeVisible({ timeout: 15000 })
    // 防 server Solid 空实现回归：cloud 插件无 __devEffect 探针（该探针是 com.qihe.lan 私有实现），
    // 改用与插件仓构建自检同口径的产物断言——renderer/Home.js 不得含 server 版 solid 痕迹
    const homeJs = (await readZipEntry(CLOUD_QBOX, 'renderer/Home.js')).toString('utf8')
    expect(homeJs).not.toMatch(/createSignal2|createEffect2|solid-js\/dist\/server\.js/)
    // 未登录横幅（e2e 环境无账号种子，默认未登录）
    await expect(page.getByText('🔒 未登录：请到 我的→账号 登录启禾 OS 账号')).toBeVisible()
    // 一页双按钮：可见且未登录禁用
    const cangji = page.getByRole('button', { name: '打开仓迹' })
    const keji = page.getByRole('button', { name: '打开客迹' })
    await expect(cangji).toBeVisible()
    await expect(keji).toBeVisible()
    await expect(cangji).toBeDisabled()
    await expect(keji).toBeDisabled()
    expect(errs).toEqual([])
  } finally {
    // 清场：卸载 cloud（共享 e2e userData，不清理会让后续 install 撞「插件已安装」）
    try {
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.cloud')
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
