import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_SRC = path.join(ROOT, 'tests/e2e/fixtures/identify-mock')
const FIXTURE_OUT = path.join(ROOT, 'tests/e2e/fixtures')
const QBOX = path.join(FIXTURE_OUT, 'qbox-identify-mock.qbox')
const PLUGIN_ID = 'com.qihe.mock.identify'
const COMMAND_ID = 'invoice.identifyFile'

/**
 * 发票识别宿主 e2e（v2.5.4 Task 4，恒跑无凭据）：
 * 用测试 fixture 插件（manifest commands global + ipc 返回固定字段）驱动「新建发票识别」全链路：
 * - test1：按钮渲染 → 点击回填（有值覆盖/空字段不动）→ 确认 → 复制归档落账（源文件仍在）
 * - test1b：失败注入（fixture 抛 MODEL_ERROR）→ toast + 表单保持 + 无归档副本
 * - test1c：重复发票号 → checkNumber 预检拦截 → 「已存在」文案 + 发票区副本数不变
 */
test.describe('发票识别 e2e（v2.5.4 Task 4）', () => {
  test.describe.configure({ mode: 'serial' })

  /** 构建 fixture qbox（幂等，产物 tests/e2e/fixtures/qbox-identify-mock.qbox） */
  async function buildFixture(): Promise<void> {
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts/build-hello-plugin.mjs'),
      '--src',
      FIXTURE_SRC,
      '--out',
      FIXTURE_OUT,
    ], { stdio: 'pipe' })
    await fsp.rm(QBOX, { force: true })
    await fsp.rename(path.join(FIXTURE_OUT, `${PLUGIN_ID}.qbox`), QBOX)
  }

  async function launchApp(extraEnv?: Record<string, string>): Promise<ElectronApplication> {
    const app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', ...(extraEnv ?? {}) },
    })
    // 诊断：远程主进程 stdout 里 [ai-identify] 日志（仅预热真链 test2 用）
    try {
      app.process()?.stdout?.on('data', (d: Buffer) => {
        const s = String(d)
        if (s.includes('ai-identify')) console.log('MAIN-IDY:', s.trim().slice(0, 500))
      })
    } catch { /* 无 stdout 则跳过 */ }
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    return app
  }

  async function closeApp(app: ElectronApplication): Promise<void> {
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch { /* 已退出 */ }
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }

  async function installFixture(page: Page): Promise<void> {
    await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)
  }

  async function setupWorkspace(page: Page, wsDir: string): Promise<void> {
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
  }

  async function openCreateInvoice(page: Page): Promise<void> {
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('invoice', {}))
  }

  /** 递归统计目录下文件数（含子目录） */
  async function countFiles(dir: string): Promise<number> {
    let n = 0
    const stack = [dir]
    while (stack.length > 0) {
      const cur = stack.pop()!
      const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const full = path.join(cur, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.isFile()) n++
      }
    }
    return n
  }

  test('test1：识别按钮渲染 → 点击回填 + 识别即归档 → 确认落账（不二次复制）', async () => {
    await buildFixture()
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-identify-e2e-'))
    const wsDir = path.join(tmpBase, 'ws')
    const fakeSource = path.join(tmpBase, 'sample-invoice.jpg')
    const app = await launchApp({ QH_IDENTIFY_SOURCE: fakeSource })
    try {
      const page = await app.firstWindow()
      await installFixture(page)
      await setupWorkspace(page, wsDir)
      // 伪造外部源文件（临时目录内，不属于工作区）→ 确认时经 archiveFile 复制进发票区
      await fsp.writeFile(fakeSource, 'fake-jpeg')

      await openCreateInvoice(page)
      const dlg = page.locator('[role="dialog"][aria-label="新建发票"]')
      await expect(dlg).toBeVisible({ timeout: 10000 })
      // 按钮渲染（label 取命令 label）
      const identifyBtn = dlg.getByRole('button', { name: '从文件识别' })
      await expect(identifyBtn).toBeVisible()
      // 先手输 buyer → 识别后仍保持（空字段不动）
      const buyerInput = dlg.locator('input[placeholder="购买方名称"]')
      await buyerInput.fill('手工买方')

      await identifyBtn.click()
      // 回填断言（number/seller/amount）
      await expect(dlg.locator('input[placeholder="如：25312000000012345678"]')).toHaveValue('MOCK-2026-001')
      await expect(dlg.locator('input[placeholder="销售方名称"]')).toHaveValue('样例卖方')
      await expect(dlg.locator('input[placeholder="如：1250.50"]')).toHaveValue('88')
      await expect(buyerInput).toHaveValue('手工买方') // 识别未返回 buyer → 空字段不动
      await expect(page.getByText('部分字段未能识别')).toBeVisible() // warnings 提示条
      await expect(page.getByText(/已识别并归档/)).toBeVisible() // 识别即归档提示条

      // 识别成功即归档：发票区已出现副本（无需等待确认），源文件仍在（复制语义）
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(1)
      await expect(fsp.stat(fakeSource)).resolves.toBeTruthy()

      await dlg.getByRole('button', { name: '确认登记' }).click()
      await expect(dlg).toHaveCount(0, { timeout: 10000 })

      // 落账断言：台账落账 + file_path 以 发票/ 开头 + 确认不二次复制（副本仍 1 个）
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      const rec = list.data.find((x: { number: string }) => x.number === 'MOCK-2026-001')
      expect(rec, '台账未发现 MOCK-2026-001').toBeTruthy()
      expect(rec.file_path.startsWith('发票/')).toBe(true)
      await expect(fsp.stat(path.join(wsDir, ...rec.file_path.split('/')))).resolves.toBeTruthy()
      await expect(fsp.stat(fakeSource)).resolves.toBeTruthy()
      expect(rec.file_path).toMatch(/^发票\/\d{4}\/sample-invoice\.jpg$/)
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(1)
    } finally {
      await closeApp(app)
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('test1b：识别失败注入 → toast + 表单保持 + 无归档副本', async () => {
    await buildFixture()
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-identify-fail-e2e-'))
    const wsDir = path.join(tmpBase, 'ws')
    const app = await launchApp({ QH_IDENTIFY_FAIL: 'MODEL_ERROR' })
    try {
      const page = await app.firstWindow()
      await installFixture(page)
      await setupWorkspace(page, wsDir)

      await openCreateInvoice(page)
      const dlg = page.locator('[role="dialog"][aria-label="新建发票"]')
      await expect(dlg).toBeVisible({ timeout: 10000 })
      await dlg.getByRole('button', { name: '从文件识别' }).click()

      // 失败信封 → toast（title 识别失败），表单保持（号码仍空）
      await expect(page.getByText('识别失败', { exact: true })).toBeVisible({ timeout: 5000 })
      await expect(dlg.locator('input[placeholder="如：25312000000012345678"]')).toHaveValue('')

      // 无落账、无归档副本（发票区无文件；目录为工作区脚手架空目录，不以此判定）
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      expect(list.data).toHaveLength(0)
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(0)
    } finally {
      await closeApp(app)
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('test2（凭据门）：真链识别——图片多模态 + PDF 文字层 → 字段 → 预填桥回填', async () => {
    const EMAIL = process.env.QIHE_E2E_EMAIL ?? ''
    const PASSWORD = process.env.QIHE_E2E_PASSWORD ?? ''
    const DIST = process.env.QIHE_PLUGINS_DIST ?? ''
    const CLOUD_QBOX = DIST ? path.join(DIST, 'com.qihe.cloud.qbox') : ''
    test.skip(!EMAIL || !PASSWORD || !CLOUD_QBOX, '需要 QIHE_E2E_EMAIL/PASSWORD + QIHE_PLUGINS_DIST（真账号，仅本地）')
    test.skip(!!process.env.CI, '依赖内部插件仓 + erp /api/ai，公开 CI 不可用')
    test.setTimeout(240_000)
    const SAMPLE_PNG = path.join(FIXTURE_OUT, 'invoice-sample.png')
    const SAMPLE_PDF = path.join(FIXTURE_OUT, 'invoice-sample.pdf')
    const app = await launchApp()
    try {
      const page = await app.firstWindow()
      await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
      const login = await page.evaluate(
        async ([e, p]) => (window as any).qihebox.account.login(e, p),
        [EMAIL, PASSWORD] as const,
      )
      expect(login.success, `login err: ${String(login.error)}`).toBe(true)
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.cloud').catch(() => {})
      const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), CLOUD_QBOX)
      expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)

      // ① 图片多模态真链：阶跃看图 → 字段信封（IPC 直调，不弹原生对话框）
      const r1 = await page.evaluate(async (p) =>
        (window as any).qihebox.plugins.call('com.qihe.cloud', 'invoice.identifyFile', { sourcePath: p }), SAMPLE_PNG)
      expect(r1.success, `image identify err: ${JSON.stringify(r1.error)}`).toBe(true)
      const f1 = r1.data?.fields ?? {}
      expect(typeof f1.number === 'string' && f1.number.trim().length >= 8, `图片识别 number 必达, got=${JSON.stringify(f1)}`).toBe(true)
      // 样本中可辨字段（number/date/amount/seller）命中 ≥4/6 口径：除 number 外至少再中 2 个
      const hit1 = [f1.date, f1.amount, f1.seller, f1.buyer].filter((v) => v != null && String(v).trim() !== '' && v !== 0).length
      expect(hit1, `图片识别可辨字段不足, fields=${JSON.stringify(f1)}`).toBeGreaterThanOrEqual(2)

      // ② PDF 文字层真链：抽字 → 文本消息 → 字段
      const r2 = await page.evaluate(async (p) =>
        (window as any).qihebox.plugins.call('com.qihe.cloud', 'invoice.identifyFile', { sourcePath: p }), SAMPLE_PDF)
      expect(r2.success, `pdf identify err: ${JSON.stringify(r2.error)}`).toBe(true)
      const f2 = r2.data?.fields ?? {}
      expect(typeof f2.number === 'string' && f2.number.trim().length >= 8, `PDF 识别 number 必达, got=${JSON.stringify(f2)}`).toBe(true)

      // ③ 识别字段经预填桥回填新建发票表单（弹窗校验值 → 取消，不落库）
      await page.evaluate((f) => (window as any).qihebox.ui.openCreatePrefill('invoice', f), f1)
      const dlg = page.locator('[role="dialog"][aria-label="新建发票"]')
      await expect(dlg).toBeVisible({ timeout: 10000 })
      await expect(dlg.locator('input[placeholder="如：25312000000012345678"]')).toHaveValue(String(f1.number ?? ''))
      await dlg.getByRole('button', { name: /取消|关闭/ }).first().click().catch(() => {})
      await expect(dlg).toHaveCount(0, { timeout: 5000 }).catch(() => {})
      // 卸载云插件，避免与后续 fixture 用例（test1c）同槽重名按钮
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), 'com.qihe.cloud').catch(() => {})
    } finally {
      await closeApp(app)
    }
  })

  test('test1c：重复发票号 → 识别即归档一个副本 → 确认拦截「已存在」且不再落账', async () => {
    await buildFixture()
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-identify-dup-e2e-'))
    const wsDir = path.join(tmpBase, 'ws')
    const fakeSource = path.join(tmpBase, 'sample-invoice.jpg')
    const app = await launchApp({ QH_IDENTIFY_SOURCE: fakeSource })
    try {
      const page = await app.firstWindow()
      await installFixture(page)
      await setupWorkspace(page, wsDir)

      // 先建一条 MOCK-2026-001 记录（直接 IPC，file_path 为已归档文件）
      await fsp.mkdir(path.join(wsDir, '发票', '2026'), { recursive: true })
      await fsp.writeFile(path.join(wsDir, '发票', '2026', 'INV-MOCK-001.pdf'), 'dup-file')
      const created = await page.evaluate(async () =>
        (window as any).qihebox.invoices.create({
          number: 'MOCK-2026-001', date: '2026-08-21', amount: 88, seller: '样例卖方', buyer: '购方',
          file_path: '发票/2026/INV-MOCK-001.pdf', status: '待报销',
        }),
      )
      expect(created.success).toBe(true)
      const beforeFiles = await countFiles(path.join(wsDir, '发票'))

      await fsp.writeFile(fakeSource, 'fake-jpeg')
      await openCreateInvoice(page)
      const dlg = page.locator('[role="dialog"][aria-label="新建发票"]')
      await expect(dlg).toBeVisible({ timeout: 10000 })
      await dlg.getByRole('button', { name: '从文件识别' }).click()
      await expect(dlg.locator('input[placeholder="如：25312000000012345678"]')).toHaveValue('MOCK-2026-001')
      // 识别即归档：源文件副本已进发票区（比识别前 +1）
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(beforeFiles + 1)
      // 补必填 buyer（识别未回填 buyer）
      await dlg.locator('input[placeholder="购买方名称"]').fill('购方')

      await dlg.getByRole('button', { name: '确认登记' }).click()
      // checkNumber 预检命中 → 「已存在」文案（弹窗仍开）；不二次归档、不落账
      await expect(page.getByText(/已存在/)).toBeVisible({ timeout: 5000 })
      const afterFiles = await countFiles(path.join(wsDir, '发票'))
      expect(afterFiles).toBe(beforeFiles + 1)
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      expect(list.data.filter((x: { number: string }) => x.number === 'MOCK-2026-001')).toHaveLength(1)
    } finally {
      await closeApp(app)
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('test1d：重复识别提示 + 取消提示 + 归档副本保留（不落账）', async () => {
    await buildFixture()
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-identify-close-e2e-'))
    const wsDir = path.join(tmpBase, 'ws')
    const fakeSource = path.join(tmpBase, 'sample-invoice.jpg')
    const app = await launchApp({ QH_IDENTIFY_SOURCE: fakeSource })
    try {
      const page = await app.firstWindow()
      await installFixture(page)
      await setupWorkspace(page, wsDir)
      await fsp.writeFile(fakeSource, 'fake-jpeg')

      await openCreateInvoice(page)
      const dlg = page.locator('[role="dialog"][aria-label="新建发票"]')
      await expect(dlg).toBeVisible({ timeout: 10000 })
      const identifyBtn = dlg.getByRole('button', { name: '从文件识别' })

      // 第一次识别 → 归档到发票区
      await identifyBtn.click()
      await expect(page.getByText(/已识别并归档/)).toBeVisible()
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(1)

      // 再次识别 → 提示「将新增一份归档副本」；归档第 2 个副本
      await identifyBtn.click()
      await expect(page.getByText(/再次识别将新增一份归档副本/)).toBeVisible()
      await expect(page.getByText(/已识别并归档/)).toBeVisible()
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(2)

      // 取消弹窗 → 提示「未登记为发票记录」；副本保留、台账无记录
      await dlg.getByRole('button', { name: '取消' }).click()
      await expect(page.getByText(/未登记为发票记录/)).toBeVisible({ timeout: 5000 })
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(2)
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      expect(list.data).toHaveLength(0)
    } finally {
      await closeApp(app)
      await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
    }
  })
})
