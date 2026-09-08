import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 产品集文档视图 e2e（v2.5.1 F2）：
 * - 产品集详情页文档卡片 → /files/doc/<产品集>/<子文件夹>（零新增路由，type='doc' 走通用路由）
 * - 空文档目录懒补建无报错（D18）
 * - 新建文档子文件夹（doc_subfolders 配置写入，D30）
 * 说明：右键「用默认应用打开」与双击分流在 open-with-default.spec.ts（F3）；MD 预览在 md-preview.spec.ts（F4）。
 * QIHEBOX_E2E=1 隔离 userData；每用例独立临时工作区，互不干扰。
 * 导航模式：goto 初始入口（reload 同步 currentWorkspace）→ location.hash（v2.5.7 补丁：file:// 走 HashRouter）。
 */
test.describe('产品集文档视图（v2.5.1 F2）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('docs-view') } })
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

  /** 建独立临时工作区 + 产品集（每次调用独立目录，互不污染） */
  const setupWorkspace = async (psName: string): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-docs-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    const psRes = await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), psName)
    expect(psRes.success).toBe(true)
    return wsDir
  }

  /** 导航：reload 同步 currentWorkspace → location.hash（v2.5.7 补丁：file:// 走 HashRouter） */
  const navigateTo = async (url: string): Promise<void> => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  test('产品集详情页文档卡片 → 文档视图（懒补建无报错）', async () => {
    const wsDir = await setupWorkspace('文档系列A')
    try {
      await navigateTo('/product-sets/文档系列A')
      // 文档卡片（第三张入口卡）
      const docCard = page.getByText('说明书、参数表与质检资料')
      await expect(docCard).toBeVisible({ timeout: 15000 })
      // 点击进入 文档/说明书（默认子文件夹）
      await docCard.click()
      // 应用内点击导航不触发 navigation 事件，用 waitForFunction 断言路由（hash 路由）
      await page.waitForFunction(() => decodeURIComponent(location.hash).includes('/files/doc/文档系列A/说明书'))
      // 空目录懒补建：视图正常渲染（面包屑「文档 - 说明书」）、无错误提示
      await expect(page.getByText('文档 - 说明书')).toBeVisible()
      await expect(page.getByText('说明书', { exact: true }).first()).toBeVisible()
      // 目录真实落盘（懒补建 D18）
      const stat = await fsp.stat(path.join(wsDir, '产品集', '文档系列A', '文档', '说明书'))
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('新建文档子文件夹：写入 doc_subfolders 配置并出现在子文件夹列表', async () => {
    const wsDir = await setupWorkspace('文档系列B')
    try {
      await navigateTo('/product-sets/文档系列B')
      await page.getByText('说明书、参数表与质检资料').click()
      await page.waitForFunction(() => decodeURIComponent(location.hash).includes('/files/doc/文档系列B/说明书'))

      // 新建文档类型子文件夹
      await page.getByRole('button', { name: /新建.*文档类型/ }).click()
      const input = page.locator('input[placeholder="如：使用说明"]')
      await input.fill('安装手册')
      await input.press('Enter')
      // 导航到新子文件夹
      await page.waitForFunction(() => decodeURIComponent(location.hash).includes('/files/doc/文档系列B/安装手册'))

      // 配置已写入 doc_subfolders
      const cfgRes = await page.evaluate(async () => (window as any).qihebox.config.get())
      expect(cfgRes.success).toBe(true)
      expect(cfgRes.data.doc_subfolders).toContain('安装手册')

      // 返回详情页：文档卡片 chips 含新子文件夹
      await navigateTo('/product-sets/文档系列B')
      await expect(page.getByText('安装手册', { exact: true })).toBeVisible({ timeout: 15000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('产品集列表统计显示文档数', async () => {
    const wsDir = await setupWorkspace('文档系列C')
    try {
      // 直接写一个文档文件到 文档/说明书
      const dir = path.join(wsDir, '产品集', '文档系列C', '文档', '说明书')
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, '说明.md'), Buffer.from('# 说明'))

      await navigateTo('/product-sets')
      // 产品集卡片统计：0 图 / 0 证 / 1 文
      await expect(page.getByText('0 图 / 0 证 / 1 文')).toBeVisible({ timeout: 15000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
