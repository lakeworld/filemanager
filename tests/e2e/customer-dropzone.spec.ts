import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 客户详情空文件区（v2.4.8 修复回归）：
 * 档案卡高时 flex-1 曾把文件区压缩成小条（实测虚线框仅 68px），「拖放文件到此处」提示溢出框外。
 * 修复：文件区容器 min-h-[420px]，内容超高时外层 main 滚动。
 * 断言：虚线框内容区 ≥ EmptyState 高度（h3 完整可见于框内）、框高 ≥ 200px。
 */
test.describe('客户详情空文件区拖放提示', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-cdrop-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
    const c = await page.evaluate(() => (window as any).qihebox.clients.create({ name: '空态客户' }))
    expect(c.success).toBe(true)
    // 直调 API 后渲染层未同步主进程工作区，reload 让 UI 重新初始化
    await page.reload()
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.waitForTimeout(500)
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
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('拖放提示完整显示在虚线框内（文件区保底高度）', async () => {
    await page.getByRole('button', { name: /客户/ }).first().click()
    await page.getByRole('heading', { name: '客户', exact: true }).waitFor({ timeout: 10000 })
    await page.getByText('空态客户', { exact: true }).click()
    await page.getByRole('heading', { name: '空态客户' }).waitFor({ timeout: 10000 })
    await page.waitForTimeout(600)

    const geo = await page.evaluate(() => {
      const frame = Array.from(document.querySelectorAll<HTMLElement>('.border-dashed')).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })[0]
      const hint = Array.from(document.querySelectorAll<HTMLElement>('h3,p')).find((el) =>
        el.textContent?.trim().startsWith('拖放文件到此处'),
      )
      const hintRect = hint ? hint.getBoundingClientRect() : null
      const desc = Array.from(document.querySelectorAll<HTMLElement>('p')).find((el) =>
        el.textContent?.trim().startsWith('支持图片'),
      )
      const descRect = desc ? desc.getBoundingClientRect() : null
      return {
        frame,
        hintRect: hintRect ? { top: hintRect.top, bottom: hintRect.bottom } : null,
        descRect: descRect ? { top: descRect.top, bottom: descRect.bottom } : null,
      }
    })

    // 虚线框存在且有保底高度（修复前 68px，修复后 ≥200px）
    expect(geo.frame).toBeTruthy()
    expect(geo.frame!.h).toBeGreaterThanOrEqual(200)
    // 提示标题与描述均在虚线框内（不溢出）
    expect(geo.hintRect).toBeTruthy()
    expect(geo.hintRect!.top).toBeGreaterThanOrEqual(geo.frame!.y)
    expect(geo.hintRect!.bottom).toBeLessThanOrEqual(geo.frame!.y + geo.frame!.h)
    expect(geo.descRect).toBeTruthy()
    expect(geo.descRect!.top).toBeGreaterThanOrEqual(geo.frame!.y)
    expect(geo.descRect!.bottom).toBeLessThanOrEqual(geo.frame!.y + geo.frame!.h)
  })
})
