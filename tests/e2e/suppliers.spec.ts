import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
// v2.5.8 D9：34 处原生 select → SearchSelect，selectOption 一律走本助手（只换定位，不改断言语义）
import { expectOptionExists, expectOptionMissing, pickOption } from './helpers/searchSelect'
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
  /** 应用初始入口 URL（file:// index.html）；导航只改 location.hash（文档路径恒定），
   *  复位统一走 hash='/__e2e-reset' + reload（v2.5.7 补丁：hash 路由下 reload 安全） */
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('suppliers') } })
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

  /** 复位并重跑应用启动流（同步 currentWorkspace），再导航到指定路由（location.hash） */
  const gotoRoute = async (route: string) => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.location.hash = decodeURIComponent(r)
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
    // v2.5.8 D9：入库弹窗供应商下拉换 SearchSelect ⇒ 「收起态 option 常驻 hidden」的前提不成立
    // （弹层是 Portal，收起时整层不在 DOM）⇒ 存在/不存在两条断言改走开面板核对，语义一字未动：
    // 改名后的新名在列表里、旧名不在。
    const supplierSelect = ibModal.getByLabel('供应商', { exact: true })
    await expectOptionExists(page, supplierSelect, '新名供应商')
    await expectOptionMissing(page, supplierSelect, '旧名供应商')

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

    // 下拉含供应商名 → 选择 → 供应商自由文本联动填入
    // v2.5.8 D9：入库弹窗供应商下拉换 SearchSelect。两处定位都要改：
    // ① 旧的「收起态 option 存在」断言不再成立（弹层是 Portal，收起时整层不在 DOM）
    //    ⇒ 改「打开面板断言该值在列表里 → Esc 收起」（expectOptionExists 内部完成）；
    // ② `getByLabel('供应商')` 必须 exact——否则会把同弹窗里 placeholder=「供应商名称」的
    //    自由文本框一起命中（Playwright 的 getByLabel 也认 placeholder），触发严格模式报错。
    const supplierSelect = modal.getByLabel('供应商', { exact: true })
    await expectOptionExists(page, supplierSelect, '入库供应商')
    await pickOption(page, supplierSelect, '入库供应商')
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

    // 下拉选产品集 → 添加 → chip 可见
    // v2.5.8 D9：客户/供应商详情页「选择要关联的产品集」换 SearchSelect ⇒ 旧的收起态 option
    // 存在性断言（原生 option 常驻 hidden）改「开面板断言在列 → Esc 收起」，再走同一选项提交。
    // 下方 chip 仍用 title 定位（span 内含 ✕ 按钮致文本非纯「M8关联集」），该口径不变。
    const linkSelect = card.getByLabel('选择要关联的产品集')
    await expectOptionExists(page, linkSelect, 'M8关联集')
    await pickOption(page, linkSelect, 'M8关联集')
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

  test('文件区子文件夹：新建/删除开放 + config.supplier_subfolders 写入/移除（v2.5.5 对齐客户）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-sub-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '子夹供应商' }))

    await gotoRoute(`/suppliers/${encodeURIComponent('子夹供应商')}`)
    await expect(page.getByRole('heading', { name: '子夹供应商' })).toBeVisible({ timeout: 15000 })

    // v2.5.5（对齐客户）：供应商文件区开放新建/删除子文件夹按钮（原固定集隐藏）
    await expect(page.getByRole('button', { name: /新建子文件夹/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /删除当前子文件夹/ })).toBeVisible()

    // 新建子文件夹 → 弹窗标题「新建子文件夹」+ 占位符 → Enter → 导航到新子文件夹
    await page.getByRole('button', { name: /新建子文件夹/ }).click()
    const dialog = page.getByRole('dialog', { name: '新建子文件夹' })
    await expect(dialog).toBeVisible()
    await dialog.locator('input[placeholder="如：报价"]').fill('样品')
    await dialog.locator('input[placeholder="如：报价"]').press('Enter')
    await page.waitForFunction(() => decodeURIComponent(location.hash).includes('/files/supplier/子夹供应商/样品'))

    // config.supplier_subfolders 已写入 样品（默认集 合同/对账单/往来文件 保留）
    const cfgRes = await page.evaluate(async () => (window as any).qihebox.config.get())
    expect(cfgRes.success).toBe(true)
    // A9 刀2b：新建只落本实体，**不再写**全站模板表（要改默认集去「设置 → 子文件夹」；旧断言钉的正是那个偷偷写表的行为）
    expect(cfgRes.data.supplier_subfolders).not.toContain('样品')
    // 下面要判「删除不得动模板表」⇒ 前提得显式造出来（模拟用户自己去「设置 → 子文件夹」登记过）：
    // 不这么写的话，新建不再进表 ⇒ 那条 `toContain` 会因为"根本没登记"而红，属测试自己的假故障。
    await page.evaluate(async () => {
      const cur = await (window as any).qihebox.config.get()
      const next = { ...cur.data, supplier_subfolders: [...new Set([...(cur.data.supplier_subfolders ?? []), '样品'])] }
      const r = await (window as any).qihebox.config.update(next)
      if (!r.success) throw new Error(`登记模板失败：${JSON.stringify(r).slice(0, 120)}`)
    })
    expect((await page.evaluate(async () => (window as any).qihebox.config.get())).data.supplier_subfolders,
      '前提：已显式登记进模板表').toContain('样品')
    expect(cfgRes.data.supplier_subfolders).toEqual(expect.arrayContaining(['合同', '对账单', '往来文件']))

    // 删除当前子文件夹 → ConfirmDialog 确认 → 跳回剩余首个子文件夹 + config 移除
    await page.getByRole('button', { name: /删除当前子文件夹/ }).click()
    const del = page.getByRole('dialog', { name: '删除子文件夹' })
    await expect(del).toBeVisible()
    await expect(del.getByText(/移入回收站/)).toBeVisible()
    await del.getByRole('button', { name: '删除', exact: true }).click()

    await page.waitForFunction(() => !decodeURIComponent(location.hash).includes('/files/supplier/子夹供应商/样品'))
    const cfgRes2 = await page.evaluate(async () => (window as any).qihebox.config.get())
    expect(cfgRes2.success).toBe(true)
    // A9 刀2a：删除只作用于本供应商，**不再**从全站模板表里划名（旧断言钉的正是那个毛病）；
    // 用户看的判据换成「那一排 tab 里没了」——它由盘驱动（刀1b）。
    expect(cfgRes2.data.supplier_subfolders, '删除不该再动全站模板表').toContain('样品')
    await expect
      .poll(
        () => page.evaluate(() => Array.from(document.querySelectorAll('.seg-item')).map((e) => (e.textContent ?? '').trim())),
        { timeout: 10000, intervals: [300, 300, 300] },
      )
      .not.toContain('样品')
    // 目录已移入回收站（不真删）
    await expect(fsp.stat(path.join(wsDir, '供应商', '子夹供应商', '样品'))).rejects.toThrow(/ENOENT/)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('设置页供应商子文件夹管理：添加/重命名/删除 → config.supplier_subfolders（v2.5.5 同步）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-settings-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 侧边栏 → 设置页
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: /设置/ }).click()
    await page.getByRole('heading', { name: '设置' }).waitFor({ timeout: 10000 })

    // 供应商子文件夹 card：添加「样品夹」→ 保存设置 → config 落盘
    const card = page.locator('.card', { has: page.getByRole('heading', { name: '供应商子文件夹' }) })
    await card.locator('input[placeholder="新增供应商子文件夹名称"]').fill('样品夹')
    await card.getByRole('button', { name: '添加' }).click()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByText('已保存 ✓')).toBeVisible({ timeout: 10000 })

    const cfgRes = await page.evaluate(async () => (window as any).qihebox.config.get())
    expect(cfgRes.success).toBe(true)
    expect(cfgRes.data.supplier_subfolders).toContain('样品夹')
    expect(cfgRes.data.supplier_subfolders).toEqual(expect.arrayContaining(['合同', '对账单', '往来文件']))

    // —— 子文件夹改名两条路（v2.5.9 / A9 刀3b）——————————————————————————
    // 背景：旧实现无条件把**每个实体**下的同名目录一起物理改名，用户在设置页改个名
    // 就把整个工作区的盘动了（用户原话「可是它动的是全局的」）。现在 ✓/Enter 只改**默认模板**，
    // 物理迁移降级为编辑行里那颗显式红钮（⇌）。两段各验一条路。
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '设置供应商甲' }))
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '设置供应商乙' }))
    const chip = card.locator('span', { hasText: '样品夹' }).first()
    await chip.getByTitle('重命名（默认只改新建模板；旁边 ⇌ 才连所有实体一起改）').click()
    const input = card.locator('input.w-32')
    await input.fill('样品柜')
    await input.press('Enter') // ← 安全默认：只改模板

    // ⚠ 判据必须用**轮询**（A1a 定责留下的修法，取证见 2026-09-21 动作记录）：
    //   Enter 触发的改名要穿三段异步（渲染层 → 主进程 → 落盘），一次性读在慢机器上会赶不上。
    const subfolders = async (): Promise<string[]> => {
      const r = await page.evaluate(async () => (window as any).qihebox.config.get())
      expect(r.success).toBe(true) // 读本身失败不参与轮询，直接判红
      return (r.data.supplier_subfolders ?? []) as string[]
    }
    await expect
      .poll(subfolders, { timeout: 15000, message: '安全默认这条也要把 config 改掉' })
      .toContain('样品柜')
    await expect
      .poll(subfolders, { timeout: 15000, message: '改名后旧值「样品夹」仍在 config 里' })
      .not.toContain('样品夹')
    // 关键判据：**盘上目录一个字都没动**（两个供应商都还是旧名，新名不存在）
    for (const holder of ['设置供应商甲', '设置供应商乙']) {
      await expect(fsp.stat(path.join(wsDir, '供应商', holder, '样品夹'))).resolves.toBeTruthy()
      await expect(fsp.stat(path.join(wsDir, '供应商', holder, '样品柜'))).rejects.toThrow(/ENOENT/)
    }

    // 第二段：**显式 acrossEntities=true 才走物理迁移**，每个实体的同名目录跟着改名、文件跟着走。
    // 为了让"盘上确有其名"，先造一个真实存在的同名目录（等价于用户在实体里建过/同步进来的文件夹），
    // 再把名字登记进模板（改名要求旧名在表里），最后点 ⇌。
    await card.locator('input[placeholder="新增供应商子文件夹名称"]').fill('样品厅')
    await card.getByRole('button', { name: '添加' }).click()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByText('已保存 ✓')).toBeVisible({ timeout: 10000 })
    for (const holder of ['设置供应商甲', '设置供应商乙']) {
      const d = path.join(wsDir, '供应商', holder, '样品厅')
      await fsp.mkdir(d, { recursive: true })
      await fsp.writeFile(path.join(d, 'note.txt'), holder) // 里面有文件：迁移必须整体搬走
    }
    // 危险钮就在编辑行里（红色 ⇌）⇒ 必须点它才物理迁移。这里走界面，不走后门 API。
    const chip2 = card.locator('span', { hasText: '样品厅' }).first()
    await chip2.getByTitle('重命名（默认只改新建模板；旁边 ⇌ 才连所有实体一起改）').click()
    await card.locator('input.w-32').fill('样品室')
    await page.getByTitle('连所有实体下的同名文件夹一起改名（直接改硬盘上的目录名）').click()
    await expect
      .poll(subfolders, { timeout: 15000, message: '显式点名这条也要把 config 改掉' })
      .toContain('样品室')
    for (const holder of ['设置供应商甲', '设置供应商乙']) {
      const moved = path.join(wsDir, '供应商', holder, '样品室')
      await expect(fsp.stat(moved)).resolves.toBeTruthy()
      await expect(fsp.stat(path.join(wsDir, '供应商', holder, '样品厅'))).rejects.toThrow(/ENOENT/)
      // 内容跟着目录走（改名是 move 不是复制/重建）
      expect(await fsp.readFile(path.join(moved, 'note.txt'), 'utf8')).toBe(holder)
    }

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
