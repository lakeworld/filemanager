import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** n 天后的本地日期 YYYY-MM-DD（invoices.json due_date 归一化格式；与主进程同机同时区） */
function dateInDays(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 发票台账 e2e（v2.4.7，PLAN §十）：
 * - 新建归档：archiveFile（发票/<YYYY>/）→ create → 台账记录 + 账物一致 + Excel 导出
 * - 查重拦截 → 状态流转 → 待办出现（invoices.list dueSoon + dashboard.invoiceTodos 通道）
 */
test.describe('发票台账 e2e（v2.4.7）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；SPA 导航用 pushState + popstate 触发路由 */
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

  test('新建归档 → 台账记录 + 账物一致 + Excel 导出', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-invoices-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)

    // 源文件（工作区外，模拟对话框选本地文件）→ archiveFile 归档到 发票/2026/
    const src = path.join(wsDir, '..', `e2e-发票-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    const arc = await page.evaluate(
      async (p) => (window as any).qihebox.invoices.archiveFile(p, '2026-08-01'),
      src,
    )
    expect(arc.success).toBe(true)
    expect(arc.data).toMatch(/^发票\/2026\/.+\.pdf$/)
    await expect(fsp.stat(path.join(wsDir, ...arc.data.split('/')))).resolves.toBeTruthy()

    // 建台账记录
    const cRes = await page.evaluate(
      async (filePath) =>
        (window as any).qihebox.invoices.create({
          number: '20260801001',
          code: 'A001',
          date: '2026-08-01',
          amount: 1250.5,
          seller: '开票方甲',
          buyer: '购买方乙',
          status: '待报销',
          file_path: filePath,
          tags: ['e2e标'],
        }),
      arc.data,
    )
    expect(cRes.success).toBe(true)
    expect(cRes.data.number).toBe('20260801001')

    // 台账记录完整 + 账物一致
    const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
    expect(list.success).toBe(true)
    expect(list.data).toHaveLength(1)
    const rec = list.data[0]
    expect(rec.amount).toBe(1250.5)
    expect(rec.file_path).toBe(arc.data)
    await expect(fsp.stat(path.join(wsDir, ...rec.file_path.split('/')))).resolves.toBeTruthy()

    // Excel 导出（IPC 直传路径，exceljs 懒加载生成）
    const out = path.join(wsDir, '..', `e2e-台账-${Date.now()}.xlsx`)
    const exp = await page.evaluate(
      async (p) => (window as any).qihebox.invoices.exportXlsx(p, (await (window as any).qihebox.invoices.list()).data),
      out,
    )
    expect(exp.success).toBe(true)
    const buf = await fsp.readFile(out)
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK') // xlsx = zip 容器

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('查重拦截 → 状态流转 → 待办出现（invoices.list dueSoon + dashboard.invoiceTodos）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-invoices-e2e2-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    const src = path.join(wsDir, '..', `e2e-发票2-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    const due = dateInDays(10)
    const mk = async (number: string, buyer: string) => {
      const arc = await page.evaluate(async (p) => (window as any).qihebox.invoices.archiveFile(p, '2026-08-05'), src)
      const r = await page.evaluate(
        async ({ filePath, number, buyer, due }: { filePath: string; number: string; buyer: string; due: string }) =>
          (window as any).qihebox.invoices.create({
            number,
            code: '',
            date: '2026-08-05',
            amount: 99,
            seller: '开票方乙',
            buyer,
            status: '待报销',
            due_date: due,
            file_path: filePath,
          }),
        { filePath: arc.data, number, buyer, due },
      )
      return r
    }
    const r1 = await mk('20260805001', '购方X')
    expect(r1.success).toBe(true)

    // 查重拦截：同号码再建 → 拒绝并提示已有记录摘要（不提供强制继续）
    const dup = await page.evaluate(async () =>
      (window as any).qihebox.invoices.checkNumber('20260805001'),
    )
    expect(dup.success).toBe(true)
    expect(dup.data.number).toBe('20260805001')
    const r2 = await mk('20260805001', '购方Y')
    expect(r2.success).toBe(false)
    expect(String(r2.error)).toContain('已存在')

    // 状态流转：待报销 → 已报销 → 已入账（单入口 setStatus）
    const s1 = await page.evaluate(async () => (window as any).qihebox.invoices.setStatus('20260805001', '已报销'))
    expect(s1.success).toBe(true)
    expect(s1.data.status).toBe('已报销')

    // 待办出现：30 天窗口内（due_date = +10 天）且状态 ≠ 已入账
    const soon = await page.evaluate(async () => (window as any).qihebox.invoices.list({ dueSoonOnly: true }))
    expect(soon.data.some((r: any) => r.number === '20260805001')).toBe(true)
    // dashboard.invoiceTodos（v2.4.7 新通道，端到端验证）
    const todos = await page.evaluate(async () => (window as any).qihebox.dashboard.invoiceTodos())
    expect(todos.success).toBe(true)
    expect(todos.data.some((r: any) => r.number === '20260805001')).toBe(true)

    // 已入账 → 待办排除
    const s2 = await page.evaluate(async () => (window as any).qihebox.invoices.setStatus('20260805001', '已入账'))
    expect(s2.success).toBe(true)
    const todos2 = await page.evaluate(async () => (window as any).qihebox.dashboard.invoiceTodos())
    expect(todos2.data.some((r: any) => r.number === '20260805001')).toBe(false)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
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

  /** 递归统计目录下文件数（含子目录；目录不存在 → 0） */
  const countFiles = async (dir: string): Promise<number> => {
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

  /** 主进程 dialog.showOpenDialog 打桩：返回固定源文件路径（插件仓 e2e-host/plugins.spec.ts 同先例） */
  const stubOpenDialog = async (filePath: string) => {
    await app.evaluate(async ({ dialog }, p) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () =>
        ({ canceled: false, filePaths: [p] }) as never
    }, filePath)
  }

  // —— B1 P0 归档后移（PLAN §二 修复1）：选文件只暂存、保存才落盘；取消/遮罩/Esc 零落盘 ——
  test('P0：新建发票选文件 → 遮罩关闭（脏守卫确认）→ 发票区零落盘 + 台账无记录', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-p0-inv-e2e-'))
    const src = path.join(wsDir, '..', `e2e-p0-发票-${Date.now()}.pdf`)
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    try {
      await fsp.writeFile(src, '%PDF-1.4')
      await stubOpenDialog(src)
      await gotoRoute('/invoices')
      await expect(page.getByRole('heading', { name: '发票管理' })).toBeVisible({ timeout: 15000 })
      await page.getByRole('button', { name: /新建发票/ }).first().click()
      const dlg = page.getByRole('dialog', { name: '新建发票' })
      await expect(dlg).toBeVisible()
      // 选文件（打桩 dialog 返回源路径）→ 只暂存、不落盘
      await dlg.getByRole('button', { name: /选择本地文件并归档/ }).click()
      // 遮罩点击 → 脏守卫确认「放弃未保存内容？」→ 放弃修改 → 关闭
      await page.mouse.click(10, 10)
      const confirm = page.getByRole('dialog', { name: '放弃未保存内容？' })
      await expect(confirm).toBeVisible({ timeout: 5000 })
      await confirm.getByRole('button', { name: '放弃修改' }).click()
      await expect(dlg).toHaveCount(0)
      // 零落盘：发票区无新增文件 + 台账无记录
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(0)
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      expect(list.data).toHaveLength(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('P0：新建发票选文件 → 保存 → 归档副本存在 + 台账记录 file_path 正确', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-p0-inv-save-e2e-'))
    const src = path.join(wsDir, '..', `e2e-p0-save-发票-${Date.now()}.pdf`)
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    try {
      await fsp.writeFile(src, '%PDF-1.4')
      await stubOpenDialog(src)
      await gotoRoute('/invoices')
      await page.getByRole('button', { name: /新建发票/ }).first().click()
      const dlg = page.getByRole('dialog', { name: '新建发票' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: /选择本地文件并归档/ }).click()
      // 填必填字段（date 默认今天；选文件只暂存、不填 file_path）
      await dlg.locator('input[placeholder="如：25312000000012345678"]').fill('P0-SAVE-001')
      await dlg.locator('input[placeholder="如：1250.50"]').fill('88')
      await dlg.locator('input[placeholder="销售方名称"]').fill('开票方甲')
      await dlg.locator('input[placeholder="购买方名称"]').fill('购买方乙')
      await dlg.getByRole('button', { name: '确认登记' }).click()
      await expect(dlg).toHaveCount(0, { timeout: 10000 })
      // 归档副本存在（发票/<YYYY>/）+ 台账记录 file_path 正确
      const list = await page.evaluate(async () => (window as any).qihebox.invoices.list())
      expect(list.success).toBe(true)
      const rec = list.data.find((x: any) => x.number === 'P0-SAVE-001')
      expect(rec, '台账未发现 P0-SAVE-001').toBeTruthy()
      expect(rec.file_path).toMatch(/^发票\/\d{4}\//)
      await expect(fsp.stat(path.join(wsDir, ...rec.file_path.split('/')))).resolves.toBeTruthy()
      expect(await countFiles(path.join(wsDir, '发票'))).toBe(1)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('P0：入库单选文件 → 遮罩关闭（脏守卫确认）→ 入库区零落盘 + 台账无记录', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-p0-inb-e2e-'))
    const src = path.join(wsDir, '..', `e2e-p0-入库-${Date.now()}.pdf`)
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    try {
      await fsp.writeFile(src, '%PDF-1.4')
      await stubOpenDialog(src)
      await gotoRoute('/invoices')
      await page.getByRole('heading', { name: '发票管理' }).waitFor()
      // 切入库单 Tab
      await page.getByRole('button', { name: /入库单/ }).click()
      await page.getByRole('button', { name: /新建入库/ }).first().click()
      const dlg = page.getByRole('dialog', { name: '新建入库单' })
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: /选择本地文件并归档/ }).click()
      // 取消按钮与遮罩同路（脏守卫）：点遮罩 → 确认 → 放弃修改
      await page.mouse.click(10, 10)
      const confirm = page.getByRole('dialog', { name: '放弃未保存内容？' })
      await expect(confirm).toBeVisible({ timeout: 5000 })
      await confirm.getByRole('button', { name: '放弃修改' }).click()
      await expect(dlg).toHaveCount(0)
      expect(await countFiles(path.join(wsDir, '入库'))).toBe(0)
      const list = await page.evaluate(async () => (window as any).qihebox.inbound.list())
      expect(list.data).toHaveLength(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
