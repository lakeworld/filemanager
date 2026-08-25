import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 发票/入库 卡片化 + 多选/批量 + 筛选 + 孤儿未建档通道（PLAN-v2.5.5 §一，B3 任务 A/B/C/D）e2e 冒烟：
 * - 卡片化：金额主视觉/号码可见（去表格后卡片渲染）
 * - 多选 + 批量工具条：勾选 → 工具条浮现 → 全选可见 → 批量改状态（待报销→已报销）
 * - 孤儿未建档：直接写盘未登记文件 → qihebox:orphans:scan 扫出 → 未建档视图可见 → 补建打开预填弹窗
 */
test.describe('发票/入库卡片化 + 批量 + 孤儿（B3）', () => {
  let app: ElectronApplication
  let page: Page
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()
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

  const gotoRoute = async (route: string) => {
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, route)
  }

  test('发票卡片 + 多选/批量改状态 + 孤儿扫描/未建档视图/补建', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-b3-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    try {
      const src = path.join(wsDir, '..', `e2e-b3-发票-${Date.now()}.pdf`)
      await fsp.writeFile(src, '%PDF-1.4')
      // 建两张发票（IPC 直建，页面渲染卡片）
      for (const [number, amount] of [
        ['B3-INV-1', 100.5],
        ['B3-INV-2', 200],
      ] as const) {
        const arc = await page.evaluate(async (p) => (window as any).qihebox.invoices.archiveFile(p, '2026-08-10'), src)
        await page.evaluate(
          async ({ fp, number, amount }: { fp: string; number: string; amount: number }) =>
            (window as any).qihebox.invoices.create({
              number, date: '2026-08-10', amount, seller: '开票方B3', buyer: '购买方B3', status: '待报销', file_path: fp,
            }),
          { fp: arc.data, number, amount },
        )
      }
      await gotoRoute('/invoices')
      await expect(page.getByRole('heading', { name: '发票管理' })).toBeVisible({ timeout: 15000 })

      // —— 卡片化：金额主视觉 + 号码可见（去表格后卡片渲染；title=金额唯一锁定卡片，避开 summary 合计）——
      await expect(page.getByTitle('金额 ¥100.50', { exact: true })).toBeVisible({ timeout: 10000 })
      await expect(page.getByTitle('金额 ¥200.00', { exact: true })).toBeVisible()
      await expect(page.getByText('B3-INV-1', { exact: true })).toBeVisible()

      // —— 多选 + 批量工具条（v2.5.5 打磨 2：移除常显复选框，单击卡片选中）——
      await page.getByTitle('金额 ¥100.50', { exact: true }).click()
      await expect(page.getByText('已选择 1 张发票')).toBeVisible()
      await page.getByRole('button', { name: '全选可见' }).click()
      await expect(page.getByText('已选择 2 张发票')).toBeVisible()

      // —— 批量改状态（待报销 → 已报销，全选 2 张）——
      await page.getByRole('button', { name: /批量改状态/ }).click()
      // CI 慢环境下批改状态落账为异步（本地即时、CI 首轮实测 1/0）——轮询等到两笔均已报销
      await expect
        .poll(async () => {
          const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
          return list.success ? list.data.filter((r: any) => r.status === '已报销').length : -1
        }, { timeout: 10000 })
        .toBe(2)

      // —— 孤儿扫描（B3 任务 D）：直接写盘未登记文件 → scan 扫出 ——
      await fsp.mkdir(path.join(wsDir, '发票', '2026'), { recursive: true })
      await fsp.writeFile(path.join(wsDir, '发票', '2026', 'orphan-b3.pdf'), 'x')
      const rep = await page.evaluate(async () => (window as any).qihebox.orphans.scan())
      expect(rep.success).toBe(true)
      expect(rep.data.invoice).toContain('发票/2026/orphan-b3.pdf')

      // —— 未建档视图：切视图 → 孤儿列表可见 ——
      await page.getByLabel('视图切换').selectOption('orphans')
      await expect(page.getByText('orphan-b3.pdf', { exact: true })).toBeVisible({ timeout: 10000 })

      // —— 孤儿补建：带 file_path 预填打开新建弹窗（预填触发脏守卫 → 确认放弃关闭）——
      await page.getByRole('button', { name: '补建' }).first().click()
      const dlg = page.getByRole('dialog', { name: '新建发票' })
      await expect(dlg).toBeVisible({ timeout: 5000 })
      await page.mouse.click(10, 10)
      const confirm = page.getByRole('dialog', { name: '放弃未保存内容？' })
      await expect(confirm).toBeVisible({ timeout: 5000 })
      await confirm.getByRole('button', { name: '放弃修改' }).click()
      await expect(dlg).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('入库卡片 + 入库未建档视图（孤儿删除走回收站）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-b3-inb-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    try {
      const src = path.join(wsDir, '..', `e2e-b3-入库-${Date.now()}.pdf`)
      await fsp.writeFile(src, '%PDF-1.4')
      const arc = await page.evaluate(async (p) => (window as any).qihebox.inbound.archiveFile(p, '2026-08-10'), src)
      await page.evaluate(
        async ({ fp }: { fp: string }) =>
          (window as any).qihebox.inbound.create({
            id: 'B3-RK-1', date: '2026-08-10', supplier: '供应商B3', amount: 88, file_path: fp,
          }),
        { fp: arc.data },
      )
      // 入库区孤儿：直接写盘
      await fsp.mkdir(path.join(wsDir, '入库', '2026'), { recursive: true })
      await fsp.writeFile(path.join(wsDir, '入库', '2026', 'orphan-inb.pdf'), 'x')

      await gotoRoute('/invoices')
      await page.getByRole('heading', { name: '发票管理' }).waitFor()
      await page.getByRole('button', { name: /入库单/ }).click()
      // 入库卡片渲染：金额主视觉 + 编号（title=金额唯一锁定卡片）
      await expect(page.getByTitle('金额 ¥88.00', { exact: true })).toBeVisible({ timeout: 10000 })
      await expect(page.getByText('B3-RK-1', { exact: true })).toBeVisible()

      // 入库未建档视图：孤儿可见 → 删除 → 回收站有记录
      await page.getByLabel('视图切换').selectOption('orphans')
      await expect(page.getByText('orphan-inb.pdf', { exact: true })).toBeVisible({ timeout: 10000 })
      await page.getByRole('button', { name: '删除' }).first().click()
      await expect(page.getByText('orphan-inb.pdf', { exact: true })).toHaveCount(0, { timeout: 10000 })
      const trash = await page.evaluate(async () => (window as any).qihebox.trash.list())
      expect(trash.data.some((t: any) => (t.path || t.name || '').includes('orphan-inb.pdf'))).toBe(true)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
