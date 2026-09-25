import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
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
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('xlsx') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护——
    // 进程已死时 close 应快速返回（关闭 Playwright 内部句柄，避免 worker teardown 等待）；
    // 极端情况 close 内部卡住时 race 兜底，不让 afterAll 拖到 90s。
    if (app) {
      try {
        // 杀整个进程组（主进程 + Chromium 子进程）：仅杀主进程会残留 renderer/gpu，
        // Playwright worker teardown 会等待残留进程退出而超时 90s
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
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

  /**
   * 2.6.1/B16 真链判据：原样导入下载来的模板不产出任何产品集。
   * 旧版模板 A2 是数据行「示例产品集」，导入循环从第 2 行起当真数据 ⇒ 直接导入模板会凭空
   * 多出一个产品集；上一条用例（导出模板 → 填数据）恰好把 A2 覆盖掉，从未走到这一格。
   * 现模板把示例挪进 A1 批注、不含数据行 ⇒ 本条的 0 就是承诺本身；「填了数据仍能导入」
   * 由上一条用例守着。
   */
  test('B16：原样导入模板 → 0 个产品集、不产出「示例产品集」', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-xlsx-raw-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)

    const templatePath = path.join(wsDir, 'raw.xlsx')
    const exportRes = await page.evaluate(async (p) => (window as any).qihebox.xlsx.exportTemplate(p), templatePath)
    expect(exportRes.success).toBe(true)

    // 不填任何数据，原样导入
    const importRes = await page.evaluate(async (p) => (window as any).qihebox.xlsx.import(p), templatePath)
    expect(importRes.success).toBe(true)
    expect(importRes.data).toHaveLength(0)

    const listRes = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    expect(listRes.data.map((p: { name: string }) => p.name)).not.toContain('示例产品集')
    expect(listRes.data).toHaveLength(0)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
