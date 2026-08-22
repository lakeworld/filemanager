import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 全业务新建通用预填 e2e（v2.5.4，PLAN-v2.5.4 §4.2）：
 * - 6 实体经 window.qihebox.ui.openCreatePrefill 跳转 + 开弹窗 + 字段预填（真实走 preload 桥 → DOM 事件 → store → 页面）
 * - 批量逐条：创建推进下一条（P1-1）；取消清空队列、剩余条目不建档
 * - 回归锚点：手动新建空表；非法 entity 不崩不跳
 * 预填永不自动建档——每条都由用例手点「确认创建」才落库。
 */
test.describe('全业务新建预填 e2e（v2.5.4）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-prefill-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
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

  const prefill = (entity: string, payload: unknown) =>
    page.evaluate(
      ([e, p]) => (window as any).qihebox.ui.openCreatePrefill(e, p),
      [entity, payload] as const,
    )

  test('customer：单条全字段预填 + 用户确认创建落库', async () => {
    await prefill('customer', {
      name: '预填客户甲', contact: '张三', type: '企业', phone: '13800000000',
      email: 'a@b.com', address: '上海', notes: '预填备注', tags: ['预填标'],
    })
    const dlg = page.locator('[role="dialog"][aria-label="新建客户"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('input[placeholder="如：张三"]')).toHaveValue('预填客户甲')
    await expect(dlg.locator('select')).toHaveValue('企业')
    await expect(dlg.locator('textarea[placeholder="添加备注..."]')).toHaveValue('预填备注')

    await dlg.getByRole('button', { name: '确认创建' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    const c = list.data.find((x: { name: string }) => x.name === '预填客户甲')
    expect(c).toBeTruthy()
    expect(c.contact).toBe('张三')
    expect(c.type).toBe('企业')
  })

  test('customer 批量：创建推进下一条；取消清空队列（P1-1）', async () => {
    await prefill('customer', [
      { name: '批量甲', contact: '联系人甲' },
      { name: '批量乙', contact: '联系人乙' },
    ])
    const dlg = page.locator('[role="dialog"][aria-label="新建客户"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('input[placeholder="如：张三"]')).toHaveValue('批量甲')

    // 创建第 1 条 → 弹窗带第 2 条重开
    await dlg.getByRole('button', { name: '确认创建' }).click()
    await expect(dlg.locator('input[placeholder="如：张三"]')).toHaveValue('批量乙', { timeout: 10000 })

    // 取消第 2 条 → 队列清空、弹窗关闭、不建档
    await dlg.getByRole('button', { name: '取消' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list.data.some((x: { name: string }) => x.name === '批量甲')).toBe(true)
    expect(list.data.some((x: { name: string }) => x.name === '批量乙')).toBe(false)
  })

  test('supplier / productSet：预填打开新建区且字段正确', async () => {
    await prefill('supplier', {
      name: '预填供应商A', contact: '王经理', phone: '13900000000',
      email: 's@b.com', address: '义乌', notes: '预填供应商备注', tags: ['重点'],
    })
    const supDlg = page.locator('[role="dialog"][aria-label="新建供应商"]')
    await expect(supDlg).toBeVisible({ timeout: 10000 })
    await expect(supDlg.locator('input[placeholder="如：义乌恒通供应链"]')).toHaveValue('预填供应商A')
    await expect(supDlg.locator('input[placeholder="如：王经理"]')).toHaveValue('王经理')
    await supDlg.getByRole('button', { name: '确认创建' }).click()
    await expect(supDlg).toHaveCount(0, { timeout: 10000 })
    const sups = await page.evaluate(async () => (window as any).qihebox.suppliers.list())
    expect(sups.data.some((x: { name: string }) => x.name === '预填供应商A')).toBe(true)

    await prefill('productSet', { name: '预填产品集A', tags: ['预填'], notes: '预填备注' })
    const psDlg = page.locator('[role="dialog"][aria-label="新建产品集"]')
    await expect(psDlg).toBeVisible({ timeout: 10000 })
    await expect(psDlg.locator('input[placeholder="如：夏季T恤系列"]')).toHaveValue('预填产品集A')
    await psDlg.getByRole('button', { name: '确认创建' }).click()
    await expect(psDlg).toHaveCount(0, { timeout: 10000 })
    const sets = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    expect(sets.data.some((x: { name: string }) => x.name === '预填产品集A')).toBe(true)
  })

  test('quote：lines 明细预填正确', async () => {
    await prefill('quote', {
      quotation_no: 'QT-E2E-001', date: '2026-08-20', customer: '预填客户甲',
      lines: [{ product: '毛巾', sku: 'T-1', qty: 2, unit_price: 9.9 }],
      notes: '预填报价备注',
    })
    const dlg = page.locator('[role="dialog"][aria-label="新建报价单"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('input[placeholder="如：QT-20260812-001"]')).toHaveValue('QT-E2E-001')
    await expect(dlg.locator('select')).toHaveValue('预填客户甲')
    await expect(dlg.locator('input[placeholder="品名"]').first()).toHaveValue('毛巾')
    // 取消：不建档
    await dlg.getByRole('button', { name: '取消' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const quotes = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(quotes.data.some((x: { quotation_no: string }) => x.quotation_no === 'QT-E2E-001')).toBe(false)
  })

  test('invoice / inbound：自动切 tab 并预填打开编辑器', async () => {
    await prefill('invoice', {
      number: 'INV-E2E-1', date: '2026-08-20', amount: 1250.5,
      seller: '销方A', buyer: '购方B', customer: '预填客户甲', notes: '预填发票备注',
    })
    const invDlg = page.locator('[role="dialog"][aria-label="新建发票"]')
    await expect(invDlg).toBeVisible({ timeout: 10000 })
    await expect(invDlg.locator('input[placeholder="如：25312000000012345678"]')).toHaveValue('INV-E2E-1')
    await expect(invDlg.locator('input[placeholder="如：1250.50"]')).toHaveValue('1250.5')
    await invDlg.getByRole('button', { name: '取消' }).click()
    await expect(invDlg).toHaveCount(0, { timeout: 10000 })

    await prefill('inbound', {
      id: 'RK-E2E-1', date: '2026-08-20', supplier: '预填供应商A', supplier_id: '预填供应商A',
      product_set: '预填产品集A', amount: 88, notes: '预填入库备注',
    })
    const inbDlg = page.locator('[role="dialog"][aria-label="新建入库单"]')
    await expect(inbDlg).toBeVisible({ timeout: 10000 })
    await expect(inbDlg.locator('input[placeholder="如：RK-2026-001"]')).toHaveValue('RK-E2E-1')
    await inbDlg.getByRole('button', { name: '取消' }).click()
    await expect(inbDlg).toHaveCount(0, { timeout: 10000 })
  })

  test('回归：手动新建空表；非法 entity 不崩不跳', async () => {
    // 非法 entity：normalize 抛 TypeError 被 store 吞掉——不导航、不弹窗
    await prefill('bogus', { name: 'x' })
    await page.waitForTimeout(400)
    expect(await page.locator('[role="dialog"]').count()).toBe(0)

    // 手动新建客户：空表（预填不产生残留）
    await page.evaluate(() => {
      window.history.pushState({}, '', '/clients')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.getByRole('button', { name: '新建客户' }).first().click()
    const dlg = page.locator('[role="dialog"][aria-label="新建客户"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('input[placeholder="如：张三"]')).toHaveValue('')
    await dlg.getByRole('button', { name: '取消' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
  })
})
