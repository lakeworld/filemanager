import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 报价单维度 e2e（v2.4.9 S3b，PLAN §3.4 / §七）：
 * 1. 列表 + 新建：填 2+ 明细行（product/sku/qty/unit_price）→ 保存 → 列表可见；汇总正确（round2 口径）
 * 2. 单号自动生成：不填单号 → QT-YYYYMMDD-<序号>；手输重名 → 查重拦截提示（core 拒绝 + toast）
 * 3. 归档：新建带归档文件 → 报价/<YYYY>/ 下文件存在（fsp.stat 断言）
 * 4. 状态流转：草稿→已确认（confirmed_at 写入）→修订中→草稿→已确认；已确认时「转草稿」禁用断言；明细只读
 * 5. 删除账物分离：删除记录 → 台账无该单、归档文件仍在（fsp.stat）
 * 6. 客户详情报价联动：客户详情显示报价数/列表；点击跳报价页；客户改名 → 报价 customer 跟随
 * 7. 筛选（打磨 M4，PLAN §3.4）：建 草稿+已确认 各 1（不同日期、不同客户）→ 状态/客户/日期筛选；
 *    URL 预选 ?status=草稿（select 显示草稿 + 列表仅草稿）；非法 status（?status=xxx）→ 回退「全部」+ 列表全显
 * 基建参照 suppliers.spec.ts（QIHEBOX_E2E=1 独立 userData；app.evaluate 打桩系统对话框）。
 */
test.describe('报价单 e2e（v2.4.9 S3）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，reload 需回初始入口 */
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

  /** 新建报价弹窗内填一行明细（第 i 行 0 起） */
  const fillLine = async (modal: ReturnType<Page['locator']>, i: number, l: { product: string; sku: string; qty: string; unit_price: string }) => {
    await modal.locator('input[placeholder="品名"]').nth(i).fill(l.product)
    await modal.locator('input[placeholder="货号"]').nth(i).fill(l.sku)
    await modal.locator('input[placeholder="1"]').nth(i).fill(l.qty)
    await modal.locator('input[placeholder="0.00"]').nth(i).fill(l.unit_price)
  }

  test('列表 + 新建：填 2+ 明细行 → 保存 → 列表可见；汇总正确（round2 口径）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e1-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    await gotoRoute('/quotes')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '➕ 新建报价' }).click()
    const modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '新建报价单' }) })
    await expect(modal).toBeVisible()

    // 2+ 明细行：2×10.50=21.00 + 3×4.25=12.75 → 合计 33.75（round2 口径）
    await fillLine(modal, 0, { product: '陶瓷杯', sku: 'SKU-A', qty: '2', unit_price: '10.5' })
    await modal.getByRole('button', { name: /添加明细行/ }).click()
    await fillLine(modal, 1, { product: '马克杯', sku: 'SKU-B', qty: '3', unit_price: '4.25' })
    // 合计实时汇总展示
    await expect(modal.getByText(/33\.75/)).toBeVisible()

    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    // 列表可见（单号自动生成 + 金额两位小数）
    const list = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(list.success).toBe(true)
    expect(list.data).toHaveLength(1)
    const rec = list.data[0]
    expect(rec.quotation_no).toMatch(/^QT-\d{8}-\d{3,}$/)
    expect(rec.lines).toHaveLength(2)
    expect(rec.total_amount).toBe(33.75)
    await expect(page.getByText(rec.quotation_no, { exact: true })).toBeVisible()
    await expect(page.getByText('33.75', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('单号自动生成：不填单号 → QT-YYYYMMDD-序号；手输重名 → 查重拦截提示', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e2-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    await gotoRoute('/quotes')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })

    // 第一张：不填单号 → 自动生成（核心断言格式 QT-YYYYMMDD-序号）
    await page.getByRole('button', { name: '➕ 新建报价' }).click()
    let modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '新建报价单' }) })
    await expect(modal).toBeVisible()
    await fillLine(modal, 0, { product: '自动生成单号品', sku: '', qty: '1', unit_price: '1' })
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    const list = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(list.success).toBe(true)
    const autoNo = list.data[0].quotation_no as string
    expect(autoNo).toMatch(/^QT-\d{8}-\d{3,}$/)

    // 第二张：手输同号 → 查重拦截（core 拒绝 + toast 提示已有记录摘要，不提供强制继续）
    await page.getByRole('button', { name: '➕ 新建报价' }).click()
    modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '新建报价单' }) })
    await expect(modal).toBeVisible()
    await modal.getByPlaceholder('如：QT-20260812-001').fill(autoNo)
    await fillLine(modal, 0, { product: '重名品', sku: '', qty: '1', unit_price: '1' })
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(page.getByText(/已存在/)).toBeVisible({ timeout: 10000 })
    await expect(modal).toBeVisible() // 弹窗不关闭，等待用户修改单号

    // 台账仍只有 1 条（重名未写入）
    const list2 = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(list2.data).toHaveLength(1)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('归档：新建带归档文件 → 报价/<YYYY>/ 下文件存在（fsp.stat）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e3-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 归档源文件（打桩系统打开对话框返回此路径；suppliers.spec 同款 app.evaluate 约定）
    const src = path.join(os.tmpdir(), `qihebox-quote-src-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    await app.evaluate(async (electron, p) => {
      ;(electron.dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, src)

    await gotoRoute('/quotes')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '➕ 新建报价' }).click()
    const modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '新建报价单' }) })
    await expect(modal).toBeVisible()
    await fillLine(modal, 0, { product: '归档品', sku: '', qty: '1', unit_price: '2' })
    await modal.getByRole('button', { name: /选择本地文件并归档/ }).click()
    await expect(modal.getByText(/qihebox-quote-src/)).toBeVisible({ timeout: 10000 })
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    // 台账 file_path + 文件真实落 报价/<YYYY>/
    const list = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(list.success).toBe(true)
    const rec = list.data[0]
    expect(rec.file_path).toMatch(/^报价\/\d{4}\/.+\.pdf$/)
    await expect(fsp.stat(path.join(wsDir, ...rec.file_path.split('/')))).resolves.toBeTruthy()

    await fsp.rm(src, { force: true }).catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('状态流转：草稿→已确认（confirmed_at）→修订中→草稿→已确认；已确认时转草稿禁用 + 明细只读', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e4-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-ST-001',
        date: '2026-08-12',
        customer: '流程客户',
        lines: [{ product: '流程品', qty: 1, unit_price: 5, amount: 5 }],
      }),
    )

    await gotoRoute('/quotes/QT-ST-001')
    await expect(page.getByRole('heading', { name: 'QT-ST-001' })).toBeVisible({ timeout: 15000 })

    // 草稿 → 已确认（confirmed_at 写入）
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByText('已确认', { exact: true })).toBeVisible({ timeout: 10000 })
    let rec = await page.evaluate(async () => (window as any).qihebox.quotes.get('QT-ST-001'))
    expect(rec.data.status).toBe('已确认')
    expect(rec.data.confirmed_at).toBeTruthy()

    // 已确认 →「转草稿」按钮禁用断言（状态机矩阵：已确认→草稿 拒绝，须先转修订中）
    const draftBtn = page.getByRole('button', { name: '转草稿' })
    await expect(draftBtn).toBeDisabled()

    // 已确认时明细只读锁定（编辑弹窗内明细行 disabled，无添加行按钮）
    await page.getByRole('button', { name: '✏️ 编辑' }).click()
    const modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '编辑报价单' }) })
    await expect(modal).toBeVisible()
    await expect(modal.getByText(/明细行已锁定/)).toBeVisible()
    await expect(modal.locator('input[placeholder="品名"]').first()).toBeDisabled()
    await expect(modal.getByRole('button', { name: /添加明细行/ })).toHaveCount(0)
    await modal.getByRole('button', { name: '取消' }).click()

    // 已确认 → 修订中 → 草稿 → 已确认（完整链路回环）
    await page.getByRole('button', { name: '转修订中' }).click()
    await expect(page.getByText('修订中', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: '转草稿' })).toBeEnabled()
    await page.getByRole('button', { name: '转草稿' }).click()
    await expect(page.getByText('草稿', { exact: true })).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByText('已确认', { exact: true })).toBeVisible({ timeout: 10000 })
    rec = await page.evaluate(async () => (window as any).qihebox.quotes.get('QT-ST-001'))
    expect(rec.data.status).toBe('已确认')
    expect(rec.data.confirmed_at).toBeTruthy() // 修订中→已确认 刷新 confirmed_at

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('删除账物分离：删除记录 → 台账无该单、归档文件仍在（fsp.stat）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e5-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    const src = path.join(wsDir, '..', `e2e-quote-del-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    const arc = await page.evaluate(async (p) => (window as any).qihebox.quotes.archiveFile(p, '2026-08-12'), src)
    expect(arc.success).toBe(true)
    const cRes = await page.evaluate(
      async (filePath) =>
        (window as any).qihebox.quotes.create({
          quotation_no: 'QT-DEL-001',
          date: '2026-08-12',
          lines: [{ product: '删除品', qty: 1, unit_price: 1, amount: 1 }],
          file_path: filePath,
        }),
      arc.data,
    )
    expect(cRes.success).toBe(true)
    const archivedAbs = path.join(wsDir, ...arc.data.split('/'))
    await expect(fsp.stat(archivedAbs)).resolves.toBeTruthy()

    // UI 删除 → ConfirmDialog「删除报价记录（归档文件保留）」
    await gotoRoute('/quotes')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await page.locator('button[title="删除"]').click()
    const dialog = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '删除报价记录' }) })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/归档文件保留/)).toBeVisible()
    await dialog.getByRole('button', { name: '删除', exact: true }).click()

    // 台账无该单；归档文件仍在（账物分离）
    const list = await page.evaluate(async () => (window as any).qihebox.quotes.list())
    expect(list.success).toBe(true)
    expect(list.data.some((r: { quotation_no: string }) => r.quotation_no === 'QT-DEL-001')).toBe(false)
    await expect(fsp.stat(archivedAbs)).resolves.toBeTruthy()

    await fsp.rm(src, { force: true }).catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('客户详情报价联动：详情显示报价数/列表 → 点击跳报价页；客户改名 → 报价 customer 跟随', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e6-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: '联动客户' }))
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-CUST-001',
        date: '2026-08-12',
        customer: '联动客户',
        lines: [{ product: '联动品', qty: 2, unit_price: 9.9, amount: 19.8 }],
      }),
    )

    // 客户详情：报价单卡片显示 1 张 + 单号
    await gotoRoute(`/clients/${encodeURIComponent('联动客户')}`)
    await expect(page.getByRole('heading', { name: '联动客户' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('heading', { name: '报价单' })).toBeVisible()
    await expect(page.getByText('共 1 张报价单')).toBeVisible()
    await expect(page.getByText('QT-CUST-001', { exact: true })).toBeVisible()
    await expect(page.getByText(/¥19\.80/)).toBeVisible()

    // 点击跳报价详情页
    await page.getByText('QT-CUST-001', { exact: true }).click()
    await expect(page.getByRole('heading', { name: 'QT-CUST-001' })).toBeVisible({ timeout: 15000 })

    // 回客户详情改名 → 报价 customer 跟随（core renameCustomer 编排：clients.rename + quotes.renameCustomer）
    await gotoRoute(`/clients/${encodeURIComponent('联动客户')}`)
    await expect(page.getByRole('heading', { name: '联动客户' })).toBeVisible({ timeout: 15000 })
    await page.getByText(/联动客户 ✏️/).click()
    const renameInput = page.locator('input[autofocus]')
    await renameInput.fill('联动客户新名')
    await renameInput.press('Enter')
    await expect(page.getByRole('heading', { name: '联动客户新名' })).toBeVisible({ timeout: 15000 })

    const rec = await page.evaluate(async () => (window as any).qihebox.quotes.get('QT-CUST-001'))
    expect(rec.data.customer).toBe('联动客户新名')

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('筛选（M4）：状态/客户/日期 + URL 预选（含非法 status 回退全部）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-quotes-e2e7-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 建 草稿+已确认 各 1（不同日期、不同客户，防状态/客户/日期断言空转）
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: '筛选客户' }))
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: '筛选客户乙' }))
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-FLT-001',
        date: '2026-08-01',
        customer: '筛选客户',
        lines: [{ product: '草稿品', qty: 1, unit_price: 10, amount: 10 }],
      }),
    )
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-FLT-002',
        date: '2026-08-10',
        customer: '筛选客户乙',
        lines: [{ product: '确认品', qty: 1, unit_price: 20, amount: 20 }],
      }),
    )
    await page.evaluate(async () => (window as any).qihebox.quotes.setStatus('QT-FLT-002', '已确认'))

    await gotoRoute('/quotes')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible({ timeout: 15000 })
    const statusSelect = page.getByLabel('状态筛选')
    const customerSelect = page.getByLabel('客户筛选')

    // —— 状态筛选 ——
    await statusSelect.selectOption({ label: '草稿' })
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toHaveCount(0)
    await statusSelect.selectOption({ label: '已确认' })
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-001', { exact: true })).toHaveCount(0)
    await statusSelect.selectOption({ label: '全部状态' })
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()

    // —— 客户筛选（下拉只列现存客户）——
    await customerSelect.selectOption({ label: '筛选客户' })
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toHaveCount(0)
    await customerSelect.selectOption({ label: '筛选客户乙' })
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-001', { exact: true })).toHaveCount(0)
    await customerSelect.selectOption({ label: '全部客户' })

    // —— 日期范围（"YYYY-MM-DD" 字符串区间比较、含两端）——
    const from = page.getByLabel('起始日期')
    const to = page.getByLabel('结束日期')
    await from.fill('2026-08-05')
    await expect(page.getByText('QT-FLT-001', { exact: true })).toHaveCount(0)
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()
    await from.fill('')
    await to.fill('2026-08-05')
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toHaveCount(0)
    // 含两端：起=001 日期 止=002 日期 → 两张都显示
    await to.fill('')
    await from.fill('2026-08-01')
    await to.fill('2026-08-10')
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()

    // —— URL 预选：?status=草稿 → select 显示草稿 + 列表仅草稿（单向，筛选不回写 URL）——
    await gotoRoute(`/quotes?status=${encodeURIComponent('草稿')}`)
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel('状态筛选')).toHaveValue('草稿')
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toHaveCount(0)

    // —— 非法 status → 回退「全部」+ 列表全显（必选断言，r3）——
    await gotoRoute('/quotes?status=xxx')
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel('状态筛选')).toHaveValue('')
    await expect(page.getByText('QT-FLT-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-FLT-002', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
