import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 单选打勾回归（v2.5.5 修复）：发票卡片 / 入库卡片 / 报价行 单击选中后左上角选择框必须打勾。
 * 根因：renderItem 顶层 `const selected = ...` 是一次性值，JSX 不追踪 → 工具条响应而卡片内
 * checked/高亮不更新；修复为响应式 getter（`const isSel = () => props.selectedIds.includes(...)`）。
 */
test.describe('单选打勾回归（v2.5.5）', () => {
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
      try { process.kill(-app.process().pid!, 'SIGKILL') } catch { try { process.kill(app.process().pid!, 'SIGKILL') } catch { /* */ } }
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

  /** 归档一个源文件，返回归档相对路径 */
  const archive = async (src: string, date: string): Promise<string> => {
    const arc = await page.evaluate(
      async ({ p, d }: { p: string; d: string }) => (window as any).qihebox.invoices.archiveFile(p, d),
      { p: src, d: date },
    )
    expect(arc.success).toBe(true)
    return arc.data
  }

  test('发票卡片：单击选中 → 选择框打勾 + 高亮；再点取消', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-sel-inv-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      const src = path.join(os.tmpdir(), `sel-inv-${Date.now()}.pdf`)
      await fsp.writeFile(src, '%PDF-1.4')
      const rel = await archive(src, '2026-08-10')
      await page.evaluate(
        async ({ fp }: { fp: string }) =>
          (window as any).qihebox.invoices.create({ number: 'SEL-INV-1', date: '2026-08-10', amount: 88, seller: '甲', buyer: '乙', status: '待报销', file_path: fp }),
        { fp: rel },
      )
      await gotoRoute('/invoices')
      await expect(page.getByTitle('金额 ¥88.00', { exact: true })).toBeVisible({ timeout: 10000 })

      // 单击卡片（金额元素）→ 工具条 + 选择框打勾
      await page.getByTitle('金额 ¥88.00', { exact: true }).click()
      await expect(page.getByText('已选择 1 张发票')).toBeVisible({ timeout: 5000 })
      const cb = page.getByRole('checkbox', { name: '选择发票 SEL-INV-1' })
      await expect(cb).toBeChecked()

      // 再点一次 → 取消（选择框取消勾选）
      await page.getByTitle('金额 ¥88.00', { exact: true }).click()
      await expect(cb).not.toBeChecked()
      await fsp.rm(src, { force: true }).catch(() => {})
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('入库卡片：单击选中 → 选择框打勾', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-sel-rk-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      const src = path.join(os.tmpdir(), `sel-rk-${Date.now()}.pdf`)
      await fsp.writeFile(src, '%PDF-1.4')
      const rel = await archive(src, '2026-08-10')
      await page.evaluate(
        async ({ fp }: { fp: string }) =>
          (window as any).qihebox.inbound.create({ id: 'SEL-RK-1', date: '2026-08-10', supplier: '甲', amount: 66, file_path: fp }),
        { fp: rel },
      )
      await gotoRoute('/invoices')
      // 切到入库单 Tab（发票页双 Tab，非视图切换）
      await page.getByRole('button', { name: '📥 入库单' }).click()
      await expect(page.getByTitle('金额 ¥66.00', { exact: true })).toBeVisible({ timeout: 10000 })

      await page.getByTitle('金额 ¥66.00', { exact: true }).click()
      await expect(page.getByText('已选择 1 条入库单')).toBeVisible({ timeout: 5000 })
      await expect(page.getByRole('checkbox', { name: '选择入库单 SEL-RK-1' })).toBeChecked()
      await fsp.rm(src, { force: true }).catch(() => {})
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('报价行：单击行 → 选择框打勾', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-sel-qt-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      await page.evaluate(
        async () =>
          (window as any).qihebox.quotes.create({
            quotation_no: 'SEL-QT-1',
            date: '2026-08-10',
            lines: [{ product: '品A', qty: 1, unit_price: 2, amount: 2 }],
          }),
      )
      await gotoRoute('/quotes')
      await expect(page.getByText('SEL-QT-1', { exact: true })).toBeVisible({ timeout: 10000 })

      // 报价号是 button、客户/状态是 button——点日期文本（纯文本 span，行内无交互元素区域）
      await page.getByText('2026-08-10', { exact: true }).first().click()
      await expect(page.getByText('已选择 1 条报价')).toBeVisible({ timeout: 5000 })
      await expect(page.getByRole('checkbox', { name: '选择报价 SEL-QT-1' })).toBeChecked()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
