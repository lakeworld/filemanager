import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * e2e 冒烟：启动应用 → 建工作区 → 建产品集 → 检查 Dashboard。
 * 覆盖阶段 0/1 的核心 IPC 链路（window.qihebox → 主进程 → core → 文件系统）。
 */
test.describe('qihe-box e2e', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 等待 preload 注入完成
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('窗口加载且 window.qihebox 可用', async () => {
    const title = await page.title()
    expect(title).toBe('启禾文件管理')
    const hasApi = await page.evaluate(() => {
      const qb = (window as any).qihebox
      return !!qb && typeof qb.workspace?.create === 'function'
    })
    expect(hasApi).toBe(true)
  })

  test('建工作区 → 建产品集 → 列表可见', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-'))

    const createRes = await page.evaluate(async (dir) => {
      return (window as any).qihebox.workspace.create(dir)
    }, wsDir)
    expect(createRes.success).toBe(true)
    expect(createRes.data.path).toBe(wsDir)

    const psRes = await page.evaluate(async () => {
      return (window as any).qihebox.productSets.create({ name: 'E2E系列' })
    })
    expect(psRes.success).toBe(true)
    expect(psRes.data.name).toBe('E2E系列')

    const listRes = await page.evaluate(async () => {
      return (window as any).qihebox.productSets.list()
    })
    expect(listRes.success).toBe(true)
    expect(listRes.data.map((p: { name: string }) => p.name)).toContain('E2E系列')

    // 目录真实存在
    const stat = await fsp.stat(path.join(wsDir, '产品集', 'E2E系列'))
    expect(stat.isDirectory()).toBe(true)

    await fsp.rm(wsDir, { recursive: true, force: true })
  })

  test('Dashboard 统计可读取', async () => {
    const stats = await page.evaluate(async () => (window as any).qihebox.dashboard.stats())
    expect(stats.success).toBe(true)
    expect(typeof stats.data.total_product_sets).toBe('number')
  })

  test('应用版本号', async () => {
    const version = await page.evaluate(async () => (window as any).qihebox.app.version())
    expect(typeof version).toBe('string')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
