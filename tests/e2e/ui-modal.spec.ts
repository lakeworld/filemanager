import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * Modal 底座行为 e2e（v2.5.1 T2，D2/D6）：
 * - role=dialog + aria-label（=title）可定位
 * - Esc 关闭 / overlay 点击关闭
 * - 焦点入 panel 首个可聚焦元素 + Tab/Shift-Tab 循环困于 panel + 关闭后焦点还原
 * - 嵌套层：FilePreviewModal（自制 overlay，未入栈）内 ConfirmDialog（Modal 底座）——
 *   Esc 只关栈顶确认框，再 Esc 关预览（现状 FilePreviewModal 自身 Esc 监听）
 * 说明：lockOpen / 弹出层分层（DatePicker 等）依赖 T3 迁移后补用例（同文件追加）。
 */
test.describe('Modal 底座（v2.5.1 T2）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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

  const navigateTo = async (url: string): Promise<void> => {
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, url)
  }

  test('ConfirmDialog（Modal 底座）：role/aria 定位 + Esc 关闭 + overlay 点击关闭', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-modal-e2e-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '弹窗系列' }))
      await navigateTo('/product-sets')
      // 进入详情页 → 删除产品集（详情页按钮有文本，列表卡片删除钮 accessible name 为 emoji）
      await page.getByText('弹窗系列').first().click()
      await page.getByRole('button', { name: '删除产品集' }).click()
      const dialog = page.getByRole('dialog', { name: '删除产品集' })
      await expect(dialog).toBeVisible({ timeout: 15000 })

      // Esc 关闭
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // 重新打开 → overlay 点击关闭
      await page.getByRole('button', { name: '删除产品集' }).click()
      await expect(dialog).toBeVisible()
      await page.mouse.click(10, 10) // 点击遮罩左上角
      await expect(dialog).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('焦点管理：打开焦点入 panel、Tab 循环困于 panel、关闭后焦点还原触发源', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-modal-e2e-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '焦点系列' }))
      await navigateTo('/product-sets')
      await page.getByText('焦点系列').first().click()
      const delBtn = page.getByRole('button', { name: '删除产品集' })
      await delBtn.click()
      const dialog = page.getByRole('dialog', { name: '删除产品集' })
      await expect(dialog).toBeVisible({ timeout: 15000 })

      // 焦点进入 panel（首个可聚焦 = 取消按钮）
      const focusedInDialog = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]')
        return dlg?.contains(document.activeElement)
      })
      expect(focusedInDialog).toBe(true)

      // Tab 循环：确认按钮聚焦后继续 Tab 回取消（困于 panel）
      await page.keyboard.press('Tab')
      const focus2 = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]')
        return dlg?.contains(document.activeElement)
      })
      expect(focus2).toBe(true)

      // Esc 关闭 → 焦点还原触发源（删除按钮）
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      const restored = await page.evaluate(() => document.activeElement?.textContent?.includes('删除'))
      expect(restored).toBe(true)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('嵌套层：预览弹窗内删除确认——Esc 只关栈顶确认框，再 Esc 关预览', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-modal-e2e-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '嵌套系列' }))
      // 直接放一个图片文件
      const dir = path.join(wsDir, '产品集', '嵌套系列', '图包', '主图')
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(
        path.join(dir, 'a.png'),
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      )
      await navigateTo('/files/image/嵌套系列/主图')
      await expect(page.getByText('a.png')).toBeVisible({ timeout: 15000 })

      // 双击预览 → 工具栏「🗑️ 删除」→ ConfirmDialog（嵌套：预览 overlay 内 Modal）
      await page.getByText('a.png').dblclick()
      await expect(page.getByText('用系统程序打开').first()).toBeVisible({ timeout: 15000 })
      await page.getByRole('button', { name: '🗑️ 删除', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '删除文件' })
      await expect(confirm).toBeVisible({ timeout: 15000 })

      // Esc 只关确认框（预览仍在）
      await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(page.getByText('用系统程序打开').first()).toBeVisible()

      // 再 Esc 关预览（FilePreviewModal 自身 Esc 监听）
      await page.keyboard.press('Escape')
      await expect(page.getByText('用系统程序打开').first()).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
