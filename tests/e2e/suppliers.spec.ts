import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 供应商维度 e2e（v2.4.9 S2，PLAN §七）：
 * 1. 列表 + 新建：填档案字段（名称/联系人/电话/邮箱/地址）→ 保存 → 列表可见
 * 2. 详情文件区：进详情 → FileBrowserView 渲染（固定子文件夹 合同/对账单/往来文件 可见）
 * 3. 删除：ConfirmDialog 确认 → trash.list 含 kind='supplier' 条目（目录移入回收站不真删）
 * 4. 重命名联动：列表重命名 → 入库单新建表单下拉选项联动（新名可见、旧名消失）
 * 5. 入库单下拉：新建入库单 → 下拉含供应商名 → 选择后保存 → 单据带 supplier_id
 * 6. 标签：新建带标签（TagInput）→ 保存 → 卡片/详情标签可见
 * 7. 关联产品集（v2.4.9 打磨 M8）：详情关联 → 重进详情仍显示（UI 形态）→ 解除关联
 * 基建参照 clients.spec.ts（QIHEBOX_E2E=1 独立 userData；app.evaluate 打桩系统对话框同 logs.spec.ts）。
 */
test.describe('供应商维度 e2e（v2.4.9 S2）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，
   *  后续 reload() 会加载假 URL → ERR_FILE_NOT_FOUND，故统一 goto 回初始入口 */
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护
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

  /** 回初始入口重跑应用启动流（同步 currentWorkspace），再导航到指定路由（pushState + popstate） */
  const gotoRoute = async (route: string) => {
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, route)
  }

  test('列表 + 新建：填档案字段 → 保存 → 列表可见 + 固定子文件夹建齐', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-e2e1-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    await gotoRoute('/suppliers')
    await expect(page.getByRole('heading', { name: '供应商', exact: true })).toBeVisible({ timeout: 15000 })

    // 新建弹窗（字段：名称/联系人/电话/邮箱/地址/备注）——header 按钮（带 ➕；EmptyState 内同名按钮同时存在）
    await page.getByRole('button', { name: '➕ 新建供应商' }).click()
    const modal = page.getByRole('dialog', { name: '新建供应商' })
    await expect(modal).toBeVisible()
    await modal.getByPlaceholder('如：义乌恒通供应链').fill('E2E供应商甲')
    await modal.getByPlaceholder('如：王经理').fill('王经理')
    await modal.getByPlaceholder('如：13800138000').fill('13800138000')
    await modal.getByPlaceholder('如：supplier@example.com').fill('sup@example.com')
    await modal.getByPlaceholder('如：浙江省义乌市…').fill('浙江省义乌市')
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    // 列表卡片可见（名称/联系人）
    await expect(page.getByText('E2E供应商甲', { exact: true })).toBeVisible()
    await expect(page.getByText('王经理', { exact: true })).toBeVisible()

    // 数据核对：档案字段 + 固定子文件夹集真实创建（core create 建齐）
    const list = await page.evaluate(async () => (window as any).qihebox.suppliers.list())
    expect(list.success).toBe(true)
    const s = list.data.find((x: { name: string }) => x.name === 'E2E供应商甲')
    expect(s).toBeTruthy()
    expect(s.contact).toBe('王经理')
    expect(s.phone).toBe('13800138000')
    expect(s.email).toBe('sup@example.com')
    expect(s.address).toBe('浙江省义乌市')
    for (const sub of ['合同', '对账单', '往来文件']) {
      const st = await fsp.stat(path.join(wsDir, '供应商', 'E2E供应商甲', sub))
      expect(st.isDirectory()).toBe(true)
    }

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('详情文件区：进详情 → FileBrowserView 渲染（固定子文件夹可见）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-e2e2-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '详情供应商', contact: '李工' }))

    await gotoRoute(`/suppliers/${encodeURIComponent('详情供应商')}`)
    await expect(page.getByRole('heading', { name: '详情供应商' })).toBeVisible({ timeout: 15000 })
    // 档案卡
    await expect(page.getByRole('heading', { name: '供应商档案' })).toBeVisible()
    await expect(page.getByText('李工', { exact: true })).toBeVisible()
    // 文件区：FileBrowserView scope="supplier" 渲染——固定子文件夹 Tab（合同/对账单/往来文件）
    await expect(page.getByRole('button', { name: '合同', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '对账单', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '往来文件', exact: true })).toBeVisible()
    // 文件列表经 scope='supplier' 正常返回（空区 → 按钮导入提示；v2.5.5 对齐：供应商区无拖放，空态不再谎称拖放）
    await expect(page.getByText('还没有文件')).toBeVisible({ timeout: 15000 })
    // v2.5.5（对齐）：文件区工具栏出现按钮导入入口
    await expect(page.getByRole('button', { name: /选择文件并添加/ })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('删除：ConfirmDialog 确认 → trash.list 含 kind=supplier（目录移入回收站不真删）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-e2e3-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '回收供应商' }))

    await gotoRoute(`/suppliers/${encodeURIComponent('回收供应商')}`)
    await expect(page.getByRole('heading', { name: '回收供应商' })).toBeVisible({ timeout: 15000 })

    // 详情页删除 → ConfirmDialog 确认（文案「移入回收站」）
    await page.getByRole('button', { name: /删除供应商/ }).click()
    const dialog = page.getByRole('dialog', { name: '删除供应商' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/将移入回收站/)).toBeVisible()
    await dialog.getByRole('button', { name: '删除', exact: true }).click()

    // 删除成功 → 跳回供应商列表
    await expect(page.getByRole('heading', { name: '供应商', exact: true })).toBeVisible({ timeout: 15000 })

    // 目录已移入回收站（不真删）；trash.list 含 kind='supplier' 条目
    await expect(fsp.stat(path.join(wsDir, '供应商', '回收供应商'))).rejects.toThrow()
    const trash = await page.evaluate(async () => (window as any).qihebox.trash.list())
    const entry = trash.data.find((t: any) => t.kind === 'supplier' && t.name === '回收供应商')
    expect(entry).toBeTruthy()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('重命名联动：列表重命名 → 入库单新建表单下拉选项联动', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-e2e4-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '旧名供应商' }))

    await gotoRoute('/suppliers')
    await expect(page.getByRole('heading', { name: '供应商', exact: true })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('旧名供应商', { exact: true })).toBeVisible()

    // 卡片右键 → 重命名弹窗 → 新名称
    await page.getByText('旧名供应商', { exact: true }).click({ button: 'right' })
    await page.getByRole('button', { name: /重命名/ }).click()
    const modal = page.getByRole('dialog', { name: '重命名供应商' })
    await expect(modal).toBeVisible()
    await modal.getByRole('textbox').fill('新名供应商')
    await modal.getByRole('button', { name: '确认重命名' }).click()
    await expect(modal).not.toBeVisible()
    await expect(page.getByText('新名供应商', { exact: true })).toBeVisible()

    // 入库单新建表单下拉联动（选项来自 suppliers store 刷新）
    await gotoRoute('/invoices')
    await expect(page.getByRole('heading', { name: '发票管理' })).toBeVisible({ timeout: 15000 })
    // Tab 按钮文本含 emoji（「📥 入库单」），exact 匹配不到，用子串
    await page.getByRole('button', { name: /入库单/ }).click()
    await page.getByRole('button', { name: /新建入库单/ }).click()
    const ibModal = page.getByRole('dialog', { name: '新建入库单' })
    await expect(ibModal).toBeVisible()
    const supplierSelect = ibModal.locator('select').first()
    // option 在收起 select 内为 hidden，用存在性断言（toHaveCount）代替可见性
    await expect(supplierSelect.locator('option', { hasText: '新名供应商' })).toHaveCount(1)
    await expect(supplierSelect.locator('option', { hasText: '旧名供应商' })).toHaveCount(0)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('入库单下拉：新建入库单 → 下拉含供应商名 → 选择后保存 → 单据带 supplier_id', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-e2e5-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '入库供应商' }))

    // 归档源文件（打桩系统打开对话框返回此路径；logs.spec.ts 同款 app.evaluate 约定）
    const src = path.join(os.tmpdir(), `qihebox-inbound-src-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    await app.evaluate(async (electron, p) => {
      ;(electron.dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, src)

    await gotoRoute('/invoices')
    await expect(page.getByRole('heading', { name: '发票管理' })).toBeVisible({ timeout: 15000 })
    // Tab 按钮文本含 emoji（「📥 入库单」），exact 匹配不到，用子串
    await page.getByRole('button', { name: /入库单/ }).click()
    await page.getByRole('button', { name: /新建入库单/ }).click()
    const modal = page.getByRole('dialog', { name: '新建入库单' })
    await expect(modal).toBeVisible()

    // 下拉含供应商名 → 选择 → 供应商自由文本联动填入（option 收起态 hidden，用存在性断言）
    const supplierSelect = modal.locator('select').first()
    await expect(supplierSelect.locator('option', { hasText: '入库供应商' })).toHaveCount(1)
    await supplierSelect.selectOption('入库供应商')
    await expect(modal.getByPlaceholder('供应商名称')).toHaveValue('入库供应商')

    // 其余必填：单据编号 + 归档文件（打桩对话框 → 选文件只暂存，B1 P0 归档后移：保存时才落盘）
    await modal.getByPlaceholder('如：RK-2026-001').fill('RK-E2E-001')
    await modal.getByRole('button', { name: /选择本地文件并归档/ }).click()

    // 保存 → 单据带 supplier_id（core 透传不硬校验；名字引用 = 供应商名）
    await modal.getByRole('button', { name: '确认登记' }).click()
    await expect(modal).not.toBeVisible()

    const list = await page.evaluate(async () => (window as any).qihebox.inbound.list())
    expect(list.success).toBe(true)
    const rec = list.data.find((r: { id: string }) => r.id === 'RK-E2E-001')
    expect(rec).toBeTruthy()
    expect(rec.supplier).toBe('入库供应商')
    expect(rec.supplier_id).toBe('入库供应商')
    // B1 P0：保存后才归档 → 入库区副本存在且 file_path 正确（账物一致）
    expect(rec.file_path).toMatch(/^入库\/\d{4}\//)
    await expect(fsp.stat(path.join(wsDir, ...rec.file_path.split('/')))).resolves.toBeTruthy()

    await fsp.rm(src, { force: true }).catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('标签：新建带标签（TagInput）→ 保存 → 卡片/详情标签可见', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-tag-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    await gotoRoute('/suppliers')
    await expect(page.getByRole('heading', { name: '供应商', exact: true })).toBeVisible({ timeout: 15000 })

    // 新建弹窗：名称 + 标签输入（TagInput 回车新建标签，无已定义匹配 → 走「新建标签」流程）
    await page.getByRole('button', { name: '➕ 新建供应商' }).click()
    const modal = page.getByRole('dialog', { name: '新建供应商' })
    await expect(modal).toBeVisible()
    await modal.getByPlaceholder('如：义乌恒通供应链').fill('标签供应商')
    const tagInput = modal.getByPlaceholder('如：重点供应商、外贸')
    await tagInput.fill('E2E重点供应商')
    await tagInput.press('Enter')
    // 已选 chip 可见（TagInput 受控 value 已含该标签）
    await expect(modal.getByText('E2E重点供应商', { exact: true })).toBeVisible()
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    // 列表卡片标签可见
    await expect(page.getByText('标签供应商', { exact: true })).toBeVisible()
    await expect(page.getByText('E2E重点供应商', { exact: true })).toBeVisible()

    // 数据核对：tags 已持久化（core 透传）
    const list = await page.evaluate(async () => (window as any).qihebox.suppliers.list())
    expect(list.success).toBe(true)
    const s = list.data.find((x: { name: string }) => x.name === '标签供应商')
    expect(s).toBeTruthy()
    expect(s.tags).toEqual(['E2E重点供应商'])

    // 详情页档案卡标签可见
    await gotoRoute(`/suppliers/${encodeURIComponent('标签供应商')}`)
    await expect(page.getByRole('heading', { name: '标签供应商' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('heading', { name: '供应商档案' })).toBeVisible()
    await expect(page.getByText('E2E重点供应商', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('关联产品集：详情关联 → 重进详情仍显示；解除关联（v2.4.9 打磨 M8）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-m8-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '关联供应商' }))
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: 'M8关联集' }))

    await gotoRoute(`/suppliers/${encodeURIComponent('关联供应商')}`)
    await expect(page.getByRole('heading', { name: '关联供应商' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('heading', { name: '关联产品集' })).toBeVisible()
    const card = page.locator('.card', { has: page.getByRole('heading', { name: '关联产品集' }) })
    // 初始「暂未关联」
    await expect(card.getByText('暂未关联产品集')).toBeVisible()

    // 下拉选产品集 → 添加 → chip 可见（option 收起态 hidden，先做存在性断言；
    // chip span 内含 ✕ 按钮致文本非纯「M8关联集」，用 title 定位）
    await expect(card.locator('option', { hasText: 'M8关联集' })).toHaveCount(1)
    await card.locator('select').selectOption('M8关联集')
    await card.getByRole('button', { name: '添加' }).click()
    await expect(card.getByTitle('打开产品集 M8关联集')).toBeVisible()

    // 重进详情 → 关联 chip 仍显示（UI 形态断言；持久化由单测覆盖，r3 措辞）
    await gotoRoute(`/suppliers/${encodeURIComponent('关联供应商')}`)
    await expect(page.getByRole('heading', { name: '关联供应商' })).toBeVisible({ timeout: 15000 })
    const card2 = page.locator('.card', { has: page.getByRole('heading', { name: '关联产品集' }) })
    await expect(card2.getByTitle('打开产品集 M8关联集')).toBeVisible()

    // 解除关联 → 回「暂未关联」
    await card2.getByTitle('解除关联').click()
    await expect(card2.getByText('暂未关联产品集')).toBeVisible()

    // 数据核对：related_product_sets 已清空（core buildInfo 输出 []）
    const list = await page.evaluate(async () => (window as any).qihebox.suppliers.list())
    expect(list.success).toBe(true)
    const s = list.data.find((x: { name: string }) => x.name === '关联供应商')
    expect(s).toBeTruthy()
    expect(s.related_product_sets).toEqual([])

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('文件区按钮导入：选择文件并添加 → 落盘 供应商/<名>/<子文件夹>（v2.5.5 对齐）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-import-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '导入供应商' }))

    // 归档源文件（打桩系统打开对话框返回此路径；同入库单用例 app.evaluate 约定）
    const src = path.join(os.tmpdir(), `qihebox-suppliers-import-src-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    await app.evaluate(async (electron, p) => {
      ;(electron.dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, src)

    await gotoRoute(`/suppliers/${encodeURIComponent('导入供应商')}`)
    await expect(page.getByRole('heading', { name: '导入供应商' })).toBeVisible({ timeout: 15000 })
    // 切到「对账单」子文件夹 → 工具栏「选择文件并添加」按钮导入（供应商区专属入口）
    await page.getByRole('button', { name: '对账单', exact: true }).click()
    await page.getByRole('button', { name: /选择文件并添加/ }).click()

    // importFiles scope=supplier：默认命名模板 供应商名_子文件夹_原名_序号 → 落盘 供应商/导入供应商/对账单/
    const imported = path.join(wsDir, '供应商', '导入供应商', '对账单', `导入供应商_对账单_${path.basename(src, '.pdf')}_1.pdf`)
    // 全量并行负载下导入落盘可能慢于默认 5s（实测 flake）→ 放宽 20s
    await expect.poll(() => fsp.stat(imported), { timeout: 20000 }).toBeTruthy()
    // 文件区自动刷新（import:complete 全局事件）→ 卡片可见
    await expect(page.getByText(path.basename(imported), { exact: true })).toBeVisible({ timeout: 15000 })

    await fsp.rm(src, { force: true }).catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
