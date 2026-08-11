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

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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
})
