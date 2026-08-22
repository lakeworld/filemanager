import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 编辑预填 e2e（v2.5.4 弹一 C-6，openEditPrefill）：
 * - customer：详情页编辑弹窗打开 + 建议改动预填 + 用户手点保存落库（phone/notes 变更）
 * - quote：报价详情页编辑弹窗 + 建议改动（notes）+ 保存
 * - invoice：发票列表页编辑弹窗 + 建议改动 + 保存；KEY 缺失的记录 → 忽略不报错不崩
 * 永不自动保存——每条都由用例手点「保存」才落库。
 */
test.describe('编辑预填 e2e（v2.5.4 C-6）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-editprefill-e2e-'))
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

  const openEdit = (entity: string, key: string, payload: unknown) =>
    page.evaluate(([e, k, p]) => (window as any).qihebox.ui.openEditPrefill(e, k, p), [entity, key, payload] as const)

  const createCustomer = (name: string, contact: string) =>
    page.evaluate(
      async ([n, c]) => (window as any).qihebox.clients.create({ name: n, contact: c }),
      [name, contact] as const,
    )

  test('customer：详情页编辑弹窗 + 建议改动预填 + 用户保存落库', async () => {
    await createCustomer('编辑预填客户', '旧联系人')
    await openEdit('customer', '编辑预填客户', { phone: '13911112222', notes: 'AI 建议备注' })

    const dlg = page.locator('[role="dialog"]', { hasText: '编辑客户档案' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    // 原值已加载（contact）且建议改动已覆盖（phone/notes）；包装 div 按标签文本筛输入控件
    await expect(dlg.locator('div.mb-4', { hasText: '联系方式' }).locator('input')).toHaveValue('旧联系人')
    await expect(dlg.locator('div.mb-4', { hasText: '电话' }).locator('input')).toHaveValue('13911112222')
    await expect(dlg.locator('div.mb-4', { hasText: '备注' }).locator('textarea')).toHaveValue('AI 建议备注')

    await dlg.getByRole('button', { name: '保存' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    const c = list.data.find((x: { name: string }) => x.name === '编辑预填客户')
    expect(c.phone).toBe('13911112222')
    expect(c.contact).toBe('旧联系人') // 未建议字段保留原值
  })

  test('quote：详情页编辑弹窗 + notes 建议改动 + 保存', async () => {
    // 先建报价（UI 新建弹窗：客户可空、明细行必填）
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('quote', {
      date: '2026-08-21',
      customer: '编辑预填客户',
      lines: [{ product: '产品X', qty: 2, unit_price: 10 }],
      notes: '原备注',
    }))
    const dlg = page.locator('[role="dialog"]', { hasText: '新建报价' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await dlg.getByRole('button', { name: '确认创建' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const qlist = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    const q = (qlist.data as { quotation_no: string; notes?: string }[]).find((x) => x.notes === '原备注')
    if (!q) throw new Error('报价未创建成功')

    await openEdit('quote', q.quotation_no, { notes: 'AI 修改后备注' })
    const edlg = page.locator('[role="dialog"]', { hasText: '编辑报价单' })
    await expect(edlg).toBeVisible({ timeout: 10000 })
    await expect(edlg.locator('textarea')).toHaveValue('AI 修改后备注')
    await edlg.getByRole('button', { name: /保存/ }).click()
    await expect(edlg).toHaveCount(0, { timeout: 10000 })
    const after = await page.evaluate(async (no) => (window as any).qihebox.quotes.get(no), q.quotation_no)
    expect(after.data.notes).toBe('AI 修改后备注')
    expect(after.data.total_amount).toBe(20) // 明细行保留原值
  })

  test('supplier：详情页编辑档案弹窗 + 建议改动 + 保存', async () => {
    // 建供应商（预填入口 + 手点确认）
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('supplier', {
      name: '编辑预填供应商', contact: '钱经理', phone: '13711110000', notes: '原备注',
    }))
    const sdlg = page.locator('[role="dialog"][aria-label="新建供应商"]')
    await expect(sdlg).toBeVisible({ timeout: 10000 })
    await sdlg.getByRole('button', { name: '确认创建' }).click()
    await expect(sdlg).toHaveCount(0, { timeout: 10000 })

    await openEdit('supplier', '编辑预填供应商', { phone: '13877778888', notes: 'AI 供应商建议' })
    const dlg = page.locator('[role="dialog"]', { hasText: '编辑供应商档案' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('input[placeholder="如：13800138000"]')).toHaveValue('13877778888')
    await expect(dlg.locator('textarea')).toHaveValue('AI 供应商建议')

    await dlg.getByRole('button', { name: '保存' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.suppliers.list())
    const s = list.data.find((x: { name: string }) => x.name === '编辑预填供应商')
    expect(s.phone).toBe('13877778888')
    expect(s.notes).toBe('AI 供应商建议')
    expect(s.contact).toBe('钱经理') // 未建议字段保留原值
  })

  test('productSet：编辑产品集信息弹窗 + notes 建议 + 保存', async () => {
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('productSet', {
      name: '编辑预填产品集', tags: ['原标签'], notes: '原备注',
    }))
    const pdlg = page.locator('[role="dialog"][aria-label="新建产品集"]')
    await expect(pdlg).toBeVisible({ timeout: 10000 })
    await pdlg.getByRole('button', { name: '确认创建' }).click()
    await expect(pdlg).toHaveCount(0, { timeout: 10000 })

    await openEdit('productSet', '编辑预填产品集', { notes: 'AI 产品集建议' })
    const dlg = page.locator('[role="dialog"]', { hasText: '编辑产品集信息' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('textarea[placeholder="添加备注..."]')).toHaveValue('AI 产品集建议')

    await dlg.getByRole('button', { name: '保存' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    const p = list.data.find((x: { name: string }) => x.name === '编辑预填产品集')
    expect(p.notes).toBe('AI 产品集建议')
    expect(p.tags).toContain('原标签') // 未建议字段保留原值
  })

  test('invoice：列表页编辑弹窗 + 建议改动 + 保存；缺失 key 忽略不崩', async () => {
    // 建发票（API 层直接建；file_path 须为已归档文件）并确认落库
    await fsp.mkdir(path.join(wsDir, '发票', '2026'), { recursive: true })
    await fsp.writeFile(path.join(wsDir, '发票', '2026', 'INV.pdf'), 'invoice-file')
    const created = await page.evaluate(() => (window as any).qihebox.invoices.create({
      number: 'INV-20260821-01', date: '2026-08-21', amount: 88, seller: '甲方', buyer: '乙方',
      file_path: '发票/2026/INV.pdf', status: '待报销',
    }))
    expect(created.success).toBe(true)
    const listBefore = await page.evaluate(async () => (window as any).qihebox.invoices.list())
    expect(listBefore.data.some((x: { number: string }) => x.number === 'INV-20260821-01')).toBe(true)
    // 直接发编辑预填（openEdit 自带导航；loading 门控等列表就绪后再消费）
    await openEdit('invoice', 'INV-20260821-01', { notes: 'AI 发票备注', due_date: '2026-09-01' })

    const dlg = page.locator('[role="dialog"]', { hasText: '编辑发票' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await dlg.getByRole('button', { name: /保存/ }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const invlist = await page.evaluate(async () => (window as any).qihebox.invoices.list())
    const inv = invlist.data.find((x: { number: string }) => x.number === 'INV-20260821-01')
    expect(inv.notes).toBe('AI 发票备注')

    // key 缺失 → 忽略：不跳详情也不崩（页面仍可交互）
    const beforeUrl = page.url()
    await openEdit('invoice', 'INV-NOT-EXISTS', { notes: 'x' })
    await page.waitForTimeout(300)
    expect(page.url()).toBe(beforeUrl)
  })

  test('inbound：列表页编辑弹窗 + notes 建议 + 保存', async () => {
    // 入库必带 file_path（账是物之索引）：先在工作区落库文件
    await fsp.mkdir(path.join(wsDir, '入库', '2026'), { recursive: true })
    await fsp.writeFile(path.join(wsDir, '入库', '2026', 'RK-EDIT-001.pdf'), 'inbound-file')
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('inbound', {
      id: 'RK-EDIT-001', date: '2026-08-22', supplier: '编辑预填供应商', supplier_id: '编辑预填供应商',
      product_set: '', amount: 100, notes: '原入库备注', file_path: '入库/2026/RK-EDIT-001.pdf',
    }))
    const idlg = page.locator('[role="dialog"][aria-label="新建入库单"]')
    await expect(idlg).toBeVisible({ timeout: 10000 })
    await idlg.getByRole('button', { name: '确认登记' }).click()
    await expect(idlg).toHaveCount(0, { timeout: 10000 })

    await openEdit('inbound', 'RK-EDIT-001', { notes: 'AI 入库建议' })
    const dlg = page.locator('[role="dialog"]', { hasText: '编辑入库单' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    await expect(dlg.locator('textarea[placeholder="添加备注..."]')).toHaveValue('AI 入库建议')

    await dlg.getByRole('button', { name: '保存' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.inbound.list())
    const r = list.data.find((x: { id: string }) => x.id === 'RK-EDIT-001')
    expect(r.notes).toBe('AI 入库建议')
    expect(r.amount).toBe(100) // 未建议字段保留原值
  })
})
