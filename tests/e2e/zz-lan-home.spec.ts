import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LAN_QBOX = '/home/lake/Nutstore Files/我的坚果云/启禾/qihe-plugins/dist/com.qihe.lan.qbox'

// 本地验证用（依赖外部 LAN qbox，不纳入公开 CI）：LAN 4 页合并 1 tab —— tab 切换 + 状态保留（常驻渲染）
test('LAN Home 容器：4 tab 切换内容即时正确', async () => {
  // v2.5.2：注释承诺「不纳入公开 CI」未落实——qbox 产物在内部插件仓，公开 CI 拿不到（同 zz-cross-plugin）
  test.skip(!!process.env.CI, '依赖内部插件仓 .qbox 产物，公开 CI 不可用——本地验证')
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
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.lan').catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), LAN_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/plugin/lan')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    // 默认设备页
    await expect(page.getByRole('heading', { name: '局域网设备' })).toBeVisible({ timeout: 15000 })
    // 关键回归：子页 createEffect 必须真的执行（此前 server Solid 空实现时 __devEffect 为 undefined）
    expect(await page.evaluate(() => (window as any).__devEffect)).toBeGreaterThan(0)
    // 聊天
    await page.getByRole('button', { name: '💬 聊天' }).click()
    await expect(page.getByRole('heading', { name: 'LAN 聊天' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: '局域网设备' })).not.toBeVisible()
    // DESIGN-chat-ui 两栏骨架：左栏会话列表 + 右栏消息区/输入区
    await expect(page.getByPlaceholder('🔍 过滤会话…')).toBeVisible()
    await expect(page.getByText('── 发起新会话 ──')).toBeVisible()
    await expect(page.getByText('选择左侧会话开始聊天')).toBeVisible()
    await expect(page.getByPlaceholder('输入消息…（Enter 发送）')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect(page.getByRole('button', { name: '对话' })).toBeVisible()
    await expect(page.getByRole('button', { name: '群', exact: true })).toBeVisible()
    // 传输
    await page.getByRole('button', { name: '📤 传输' }).click()
    await expect(page.getByRole('heading', { name: '传输' })).toBeVisible()
    // 远程浏览
    await page.getByRole('button', { name: '📁 远程浏览' }).click()
    await expect(page.getByRole('heading', { name: '远程浏览' })).toBeVisible()
    // 切回设备：状态保留（常驻渲染，组件未卸载）
    await page.getByRole('button', { name: '🖥️ 设备' }).click()
    await expect(page.getByRole('heading', { name: '局域网设备' })).toBeVisible()
    expect(errs).toEqual([])
  } finally {
    // 清场：卸载 LAN（共享 e2e userData，不清理会让后续 conformance install 撞「插件已安装」）
    try {
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.lan')
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
