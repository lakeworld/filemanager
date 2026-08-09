import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 阶段5：XLSX 模板导出/批量导入（IPC 全链路） */
test.describe('XLSX 批量导入', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：先强制退出主进程（绕过「关闭→隐藏托盘」拦截），避免 close() 等待 90s 超时
    if (app) {
      await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {})
      await app.close().catch(() => {})
    }
  })

  test('导出模板 → 填数据 → 导入 → 批量建产品集', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-xlsx-e2e-'))

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)

    // 导出模板
    const templatePath = path.join(wsDir, 'batch.xlsx')
    const exportRes = await page.evaluate(async (p) => (window as any).qihebox.xlsx.exportTemplate(p), templatePath)
    expect(exportRes.success).toBe(true)
    await expect(fsp.stat(templatePath)).resolves.toBeTruthy()

    // 用 exceljs 填 3 行数据
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(templatePath)
    const sheet = wb.worksheets[0]
    sheet.getCell('A2').value = '批量系列一'
    sheet.getCell('A3').value = '批量系列二'
    sheet.getCell('A4').value = '批量系列三'
    await wb.xlsx.writeFile(templatePath)

    // 导入
    const importRes = await page.evaluate(async (p) => (window as any).qihebox.xlsx.import(p), templatePath)
    expect(importRes.success).toBe(true)
    expect(importRes.data).toHaveLength(3)

    // 验证产品集列表
    const listRes = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    const names = listRes.data.map((p: { name: string }) => p.name)
    expect(names).toContain('批量系列一')
    expect(names).toContain('批量系列三')

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
