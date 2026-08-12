import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 侧边栏分组折叠（v2.4.9 M7，PLAN §3.7）：分组重组（概览/资料-产品/资料-业务/工具/系统）
 * + 组标题折叠（title 可定位、折叠后整组隐藏、标题保留、会话内不持久化）。
 * 覆盖：
 * 1. 分组结构断言（5 组标题 + 13 项导航）
 * 2. 折叠交互（点组标题收起 → 组内条目隐藏、标题保留 → 再点展开）
 * 3. 折叠后 reload → 分组恢复展开（会话内不持久化验证）
 * 4. 既有导航回归（label/path 未动；点击 产品集/客户/供应商/报价/发票/搜索/导出/我的/设置/回收站 可达）
 * 基建参照 tag-collapse.spec.ts（QIHEBOX_E2E=1；beforeAll 建工作区，create 会置为当前工作区并持久化）。
 */
test.describe('侧边栏分组折叠（v2.4.9 M7）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；reload 需回初始入口 */
  let baseUrl: string
  let wsDir: string

  const GROUP_TITLES = ['概览', '资料-产品', '资料-业务', '工具', '系统']
  const NAV_LABELS = ['仪表盘', '产品集', '图包库', '证书库', '客户', '供应商', '报价', '发票', '搜索', '导出', '我的', '设置', '回收站']
  /** 侧边栏（aside）：导航入口/组标题都在其内，避免与页面内容按钮混淆 */
  const sidebar = () => page.locator('aside')

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-sidebar-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
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

  test('分组结构：5 组标题 + 13 项导航可见', async () => {
    // 5 组标题（button + title 可定位）
    for (const g of GROUP_TITLES) {
      await expect(sidebar().getByTitle(`展开/收起${g}`)).toBeVisible()
    }
    // 13 项导航全部可见（label 不变，子串匹配含图标前缀）
    for (const label of NAV_LABELS) {
      await expect(sidebar().getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('折叠交互：点组标题收起 → 组内条目隐藏、标题保留 → 再点展开', async () => {
    const collapseBtn = sidebar().getByTitle('展开/收起资料-业务')
    await collapseBtn.click()

    // 收起后整组隐藏：资料-业务 4 项全部消失
    for (const label of ['客户', '供应商', '报价', '发票']) {
      await expect(sidebar().getByRole('button', { name: label })).toHaveCount(0)
    }
    // 组标题保留（可再次定位）
    await expect(collapseBtn).toBeVisible()
    // 其他组不受影响：概览/工具/系统条目仍在
    await expect(sidebar().getByRole('button', { name: '仪表盘' })).toBeVisible()
    await expect(sidebar().getByRole('button', { name: '搜索' })).toBeVisible()
    await expect(sidebar().getByRole('button', { name: '设置' })).toBeVisible()

    // 再点展开 → 条目恢复
    await collapseBtn.click()
    for (const label of ['客户', '供应商', '报价', '发票']) {
      await expect(sidebar().getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('折叠后 reload → 分组恢复展开（会话内不持久化）', async () => {
    // 收起「工具」组
    await sidebar().getByTitle('展开/收起工具').click()
    await expect(sidebar().getByRole('button', { name: '搜索' })).toHaveCount(0)

    // reload 回初始入口（工作区选择由主进程持久化，重启后自动恢复当前工作区）
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    // 分组恢复展开：工具组条目重新可见
    await expect(sidebar().getByRole('button', { name: '搜索' })).toBeVisible()
    await expect(sidebar().getByRole('button', { name: '导出' })).toBeVisible()
    // 5 组标题齐全
    for (const g of GROUP_TITLES) {
      await expect(sidebar().getByTitle(`展开/收起${g}`)).toBeVisible()
    }
  })

  test('既有导航回归：侧边栏入口点击可达（label/path 未动）', async () => {
    const cases: [string, string][] = [
      ['产品集', '产品集'],
      ['客户', '客户'],
      ['供应商', '供应商'],
      ['报价', '报价管理'],
      ['发票', '发票管理'],
      ['搜索', '搜索'],
      ['导出', '导出'],
      ['我的', '我的'],
      ['设置', '设置'],
      ['回收站', '回收站'],
    ]
    for (const [label, heading] of cases) {
      await sidebar().getByRole('button', { name: label }).click()
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 10000 })
    }
    // 收尾回仪表盘（还原初始路由，避免影响其他用例）
    await sidebar().getByRole('button', { name: '仪表盘' }).click()
    await expect(page.getByRole('heading', { name: '仪表盘', exact: true })).toBeVisible({ timeout: 10000 })
  })
})
