/**
 * v2.5.9（悬案·就地改名）：在产品集文件区右键某个子文件夹 tab →「重命名这一个目录…」
 *
 * 钉三件事（少一件这个入口就是假的）：
 *   ① **点得到**：tab 上有右键菜单，菜单里有这一项（不是藏在某层后面）；
 *   ② **就地**：改的是**当前这个产品集**盘上那一个目录——内联输入框，不弹窗；
 *   ③ **只影响一个**：其他产品集的同名目录、以及全局模板表，都**不许**被顺手改
 *      （这正是它和「设置页改名（默认改模板 / ⇌ 改所有）」的区别，也是它存在的理由）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test.describe('悬案 · 实体页就地改名', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('a9-local-rename') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-rename-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      const qb = (window as any).qihebox
      // 两个客户都建同一个目录名，用来证明"只改一个"
      for (const c of ['甲客户', '乙客户']) {
        await qb.clients.create({ name: c })
        await qb.files.createSubfolder({ product_set: c, file_type: '', name: '沟通', scope: 'customer' })
      }
    })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('右键 tab → 就地改名：只动这一个实体的盘上目录', async () => {
    const dirOf = (ps: string, sub: string) => path.join(wsDir, '客户', ps, sub)

    // 与其它 spec 同一条导航口径：先回重置 hash + reload，再设目标 hash
    // （SPA 同路径导航不重挂载，文件区会停在旧状态——A1c 已经踩过一次）
    await page.evaluate(() => {
      window.location.hash = '/__e2e-reset'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(() => {
      window.location.hash = '/clients/' + encodeURIComponent('甲客户')
    })
    await expect(page.getByRole('heading', { name: '甲客户' })).toBeVisible({ timeout: 20000 })
    await expect(page.locator('.seg-item').first()).toBeVisible({ timeout: 20000 })

    // ① 右键「沟通」tab ⇒ 菜单里有这一项
    const tab = page.locator('.seg-item', { hasText: '沟通' }).first()
    await expect(tab).toBeVisible({ timeout: 20000 })
    await tab.click({ button: 'right' })
    const item = page.locator('.row-btn').filter({ hasText: '重命名这一个目录…' })
    await expect(item).toBeVisible()
    await item.click()
    await page.waitForTimeout(500)

    // ② 就地：tab 条换成输入框（不弹窗），输入新名回车
    const input = page.locator('input[aria-label="子文件夹新名称"]')
    await expect(input).toBeVisible({ timeout: 10000 })
    await input.fill('甲沟通')
    await input.press('Enter')

    // ③ 盘上：甲客户那一个目录换了名
    await expect(async () => {
      expect(await fsp.stat(dirOf('甲客户', '甲沟通')).then(() => true, () => false)).toBe(true)
    }).toPass({ timeout: 15000 })
    expect(await fsp.stat(dirOf('甲客户', '沟通')).then(() => true, () => false)).toBe(false)

    // ④ 其他实体与模板表都没被顺手改（这条不过，入口就是"改名所有"的假就地）
    expect(await fsp.stat(dirOf('乙客户', '沟通')).then(() => true, () => false)).toBe(true)
    const cfg = await page.evaluate(async () => (window as any).qihebox.config.get())
    expect(cfg.success).toBe(true)
    expect(cfg.data.customer_subfolders).toContain('沟通')
    expect(cfg.data.customer_subfolders).not.toContain('甲沟通')

    // ⑤ 人还在文件区，tab 已换成新名（改名后不把人踢走）
    await expect(page.locator('.seg-item', { hasText: '甲沟通' }).first()).toBeVisible()
  })
})
