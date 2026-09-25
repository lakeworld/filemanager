import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
// v2.5.8 D9：34 处原生 select → SearchSelect，selectOption 一律走本助手（只换定位，不改断言语义）
import { pickOption } from './helpers/searchSelect'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 设置页标签树折叠（v2.4.7 F8）：有子标签的顶层标签默认收起，点箭头展开。
 * 覆盖：默认收起 → 点击展开 → 再点收起；以及新建子标签后父级自动展开（评审 P1 修复点）。
 */
test.describe('设置页标签树折叠', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('tag-collapse') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-tags-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
    // 建父标签 + 子标签（两个用例共用，避免测试间依赖）
    const p = await page.evaluate(() => (window as any).qihebox.tags.create('折叠父', '#3b82f6', null))
    expect(p.success).toBe(true)
    const c = await page.evaluate(() => (window as any).qihebox.tags.create('折叠子', '#ef4444', '折叠父'))
    expect(c.success).toBe(true)
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
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  /** 进入设置页（侧边栏「设置」入口为 button，非 link）——v2.6.1 起标签树住「标签」页签，落页后先切过去 */
  const openSettings = async () => {
    await page.getByRole('button', { name: /设置/ }).first().click()
    await page.getByRole('heading', { name: '设置' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: '标签', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: '标签管理' })).toBeVisible({ timeout: 10000 })
  }

  const childRow = (parent: string) => page.getByText(`└ ${parent}/`, { exact: false })

  test('顶层标签默认收起，点箭头展开/收起', async () => {
    await openSettings()

    // 默认收起：子标签行不可见
    await expect(childRow('折叠父')).toHaveCount(0)

    // 点展开箭头 → 子标签可见
    await page.locator('button[title="展开子标签"]').click()
    await expect(page.getByText('折叠子', { exact: true })).toBeVisible()
    await expect(page.locator('button[title="收起子标签"]')).toHaveCount(1)

    // 再点收起 → 子标签隐藏（所有「└ 折叠父/」前缀行消失）
    await page.locator('button[title="收起子标签"]').click()
    await expect(childRow('折叠父')).toHaveCount(0)
  })

  test('新建子标签后父级自动展开（评审 P1 修复点）', async () => {
    await openSettings()
    // 在设置页顶部表单选择父级新建子标签（表单入口：「作为 折叠父 的子标签」）
    await page.getByPlaceholder('标签名称').fill('折叠孙')
    // v2.5.7（A3）：新建表单新增「标签域」选择（与「标签父级」两个下拉）——显式按 label 定位父级
    // v2.5.8 D9：两处都换成 SearchSelect（触发器是 button，旧的 combobox 说法已不适用）
    await pickOption(page, page.getByLabel('标签父级'), '折叠父')
    await page.getByRole('button', { name: '+ 添加' }).click()

    // 父级应自动展开：子标签行可见，且包含刚新建的「折叠孙」
    await expect(page.getByText('折叠孙', { exact: true }).first()).toBeVisible()
    await expect(childRow('折叠父')).toHaveCount(2) // 折叠子 + 折叠孙
  })
})
