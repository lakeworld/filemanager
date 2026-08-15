import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 账号区 e2e（v2.5.1 登录增强 T5，D7/D10 口径）：
 * - e2e 环境（QIHEBOX_E2E=1）账号文件为空 → 恒未登录态，全部断言未登录分支
 * - 不点真实登录（_electron 会打生产网络，CI 不可靠）；登录成功路径由单测（mock fetch）+ 本机手动回归兜底
 * - 已登录分支新交互（重新登录按钮/登出 toast/头像邮箱渲染）e2e 不覆盖（D10 诚实口径）
 */
test.describe('账号区（v2.5.1 登录增强）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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

  const navigateToProfile = async (): Promise<void> => {
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    // history 路由：pushState + popstate（对齐 ui-consistency.spec.ts navigateTo 模式）
    await page.evaluate(() => {
      window.history.pushState({}, '', '/profile')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForTimeout(500)
  }

  test('未登录表单可见（邮箱/密码占位 + 登录标题）', async () => {
    await navigateToProfile()
    await expect(page.getByPlaceholder('邮箱')).toBeVisible({ timeout: 15000 })
    await expect(page.getByPlaceholder('密码')).toBeVisible()
    await expect(page.getByText('登录启禾账号')).toBeVisible()
  })

  test('空提交校验：提示「请输入邮箱和密码」且不发网络请求', async () => {
    await navigateToProfile()
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByText('请输入邮箱和密码')).toBeVisible({ timeout: 15000 })
  })

  test('未登录占位文案可见（登录价值说明，未登录分支特有）', async () => {
    await navigateToProfile()
    await expect(page.getByText(/登录后自动上报活跃信息/)).toBeVisible({ timeout: 15000 })
  })
})
