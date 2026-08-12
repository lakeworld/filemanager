import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 批量重命名复用命名模板（v2.4.9 S5）：
 * 文件浏览器多选 2 个原始名文件 → 右键「批量重命名」→ 预览名 = 产品集_子文件夹_原文件名_序号
 * （新默认模板 4 字段：product_set/sub_folder/original_name/sequence）→ 应用 → 列表与磁盘落盘名一致。
 * 说明：被测文件直接写盘而非走导入——导入会先按模板改名（带编号），批量重命名按 baseOf 语义会再次套模板嵌套，
 * 无法呈现 brief 要求的「产品集_子文件夹_原文件名_序号」格式；直接写盘即批量重命名的真实输入场景。
 */
test.describe('批量重命名复用命名模板（v2.4.9 S5）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
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

  test('多选 → 批量重命名：预览/落盘名 = 产品集_子文件夹_原文件名_序号（新默认模板）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-rename-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '重命名集' }))

    // 直接写 2 个原始名文件到 图包/主图（真实批量重命名输入；见文件头注释）
    const mainDir = path.join(wsDir, '产品集', '重命名集', '图包', '主图')
    await fsp.mkdir(mainDir, { recursive: true })
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await fsp.writeFile(path.join(mainDir, 'banner.png'), PNG_1PX)
    await fsp.writeFile(path.join(mainDir, 'detail.jpg'), PNG_1PX)

    // 进入文件浏览器（/files/image/<产品集>/<子文件夹>）
    await page.evaluate(async () => {
      const route = `/files/image/${encodeURIComponent('重命名集')}/${encodeURIComponent('主图')}`
      window.history.pushState({}, '', route)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const cards = page.locator('.card')
    await cards.first().waitFor({ timeout: 15000 })
    await expect(cards).toHaveCount(2)

    // 多选两个文件（点卡片切换选中态）
    await cards.nth(0).click()
    await cards.nth(1).click()

    // 右键打开上下文菜单 → 批量重命名（多选才显示菜单项）
    await cards.nth(0).click({ button: 'right' })
    await page.getByRole('button', { name: /批量重命名/ }).click()

    // 预览名 = 产品集_子文件夹_原文件名_序号（新默认模板 4 字段；批序随 mtime/选中序 → 断言集合与单文件模式）
    const dialog = page.locator('.fixed.inset-0.bg-black\\/50')
    await dialog.getByText('批量重命名 2 个文件').waitFor({ timeout: 10000 })
    const previewTargets = await dialog.locator('span.text-surface-900').allTextContents()
    const renPat = /^重命名集_主图_(banner|detail)_([12])\.(png|jpg)$/
    expect(previewTargets).toHaveLength(2)
    expect(previewTargets.every((t) => renPat.test(t))).toBe(true)
    expect(new Set(previewTargets.map((t) => t.match(renPat)![1]))).toEqual(new Set(['banner', 'detail']))
    expect(new Set(previewTargets.map((t) => t.match(renPat)![2]))).toEqual(new Set(['1', '2']))

    // 应用（逐个 rename IPC，全部成功才关闭）
    await dialog.getByRole('button', { name: /重命名 2 个/ }).click()
    await dialog.waitFor({ state: 'detached', timeout: 10000 })

    // 列表落盘名（父级 onDone 已刷新）
    const listRes = (await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '重命名集', file_type: 'image', sub_folder: '主图' }),
    )) as { success: boolean; data: Array<{ name: string }> | null }
    expect(listRes.success).toBe(true)
    const names = listRes.data!.map((f: { name: string }) => f.name)
    expect(names).toHaveLength(2)
    expect(names.every((n) => renPat.test(n))).toBe(true)
    expect(new Set(names.map((n) => n.match(renPat)![1]))).toEqual(new Set(['banner', 'detail']))
    expect(new Set(names.map((n) => n.match(renPat)![2]))).toEqual(new Set(['1', '2']))

    // 磁盘真实落盘（原始名已不存在）
    const renamed = new Set(names)
    for (const n of renamed) await expect(fsp.stat(path.join(mainDir, n))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(mainDir, 'banner.png'))).rejects.toThrow()
    await expect(fsp.stat(path.join(mainDir, 'detail.jpg'))).rejects.toThrow()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
