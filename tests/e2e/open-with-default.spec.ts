import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 用默认应用打开 e2e（v2.5.1 F3）：
 * - 右键菜单「用默认程序打开」项存在并触发 IPC（QIHEBOX_E2E=1 时 open.ts 直接 resolve，不断言真打开）
 * - 双击分流：可预览类型（pdf）→ 预览弹窗；不可预览类型（docx/xlsx）→ 默认应用打开（无预览弹窗）
 * 说明：preload/渲染层 API 在 v2.5 已接线（ipc handler → preload:120 → api.files.openWithDefaultApp，
 * 4 页面 onOpenDefault 已传）——本 spec 只覆盖行为面；D25 审查误判已如实记录（见 审查-2026-08-14-4视角-PLANv251-r2.md 修订注记）。
 */
test.describe('用默认应用打开（v2.5.1 F3）', () => {
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

  /** 建工作区 + 产品集 + 往 文档/说明书 写两个文件（md 可预览 / docx 不可预览） */
  const setup = async (): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-open-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '打开系列' }))
    const dir = path.join(wsDir, '产品集', '打开系列', '文档', '说明书')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '说明.md'), Buffer.from('# 说明'))
    await fsp.writeFile(path.join(dir, '规格表.xlsx'), Buffer.from('fake xlsx'))
    return wsDir
  }

  test('右键菜单含「用默认程序打开」且点击触发 IPC success', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/files/doc/打开系列/说明书')
      // 双击 xlsx 先确保视图就绪（列表渲染出两个文件）
      await expect(page.getByText('规格表.xlsx')).toBeVisible({ timeout: 15000 })

      // 右键 md 文件 → 菜单含「用默认程序打开」
      await page.getByText('说明.md').click({ button: 'right' })
      await expect(page.getByText('用默认程序打开')).toBeVisible()
      await page.getByText('用默认程序打开').click()

      // E2E 模式：open.ts 直接 resolve，无预览弹窗、无报错 toast
      await page.waitForTimeout(600)
      expect(decodeURIComponent(new URL(page.url()).pathname)).toContain('/files/doc/打开系列/说明书')
      await expect(page.getByText('打开失败').or(page.getByText('无法打开文件'))).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('双击分流：md → 预览弹窗渲染；xlsx → 默认应用打开（无预览弹窗）', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/files/doc/打开系列/说明书')
      await expect(page.getByText('规格表.xlsx')).toBeVisible({ timeout: 15000 })

      // 双击 md → 预览弹窗（F4 渲染细节在 md-preview.spec；FilePreviewModal 尚无 role=dialog，
      // 用特征按钮「用系统程序打开」断言弹窗出现——阶段二 Modal 统一后此处可迁 role 断言）
      await page.getByText('说明.md').dblclick()
      await expect(page.getByText('用系统程序打开').first()).toBeVisible({ timeout: 15000 })
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.body.innerText.includes('此类型暂不支持预览'))

      // 双击 xlsx → 默认应用打开：无预览弹窗出现（分流生效）
      await page.getByText('规格表.xlsx').dblclick()
      await page.waitForTimeout(800)
      // 无预览弹窗出现（分流生效：other → 默认应用打开）
      const previewOpen = await page.evaluate(() => document.body.innerText.includes('用系统程序打开'))
      expect(previewOpen).toBe(false)
      // 仍停留在文档视图
      expect(decodeURIComponent(new URL(page.url()).pathname)).toContain('/files/doc/打开系列/说明书')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
