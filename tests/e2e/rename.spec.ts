import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 批量重命名复用命名模板（v2.4.9 S5）：
 * 1) 文件浏览器多选 2 个原始名文件 → 右键「批量重命名」→ 预览名 = 产品集_子文件夹_原文件名_序号
 *    （新默认模板 4 字段：product_set/sub_folder/original_name/sequence）→ 应用 → 列表与磁盘落盘名一致。
 *    说明：该用例被测文件直接写盘而非走导入——导入会先按模板改名（带编号），无法呈现「原文件名」格式。
 * 2) 真实导入（落盘名带编号，如 重命名集_主图_banner_1.png）→ 再批量重命名 → 预览/落盘名嵌套
 *    （original_name 槽位取当前文件名，即整个导入名，再套一次模板 + 新序号）。
 *    评审决策（S5 拍板）：嵌套行为保持现状、预览可见；本用例锁定现状防回归。
 */
test.describe('批量重命名复用命名模板（v2.4.9 S5）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，重载需回初始入口 */
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()
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
    const dialog = page.getByRole('dialog', { name: /批量重命名/ })
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

  test('单文件重命名弹窗（v2.5.2 RenameDialog）：同名禁用 / 非法名服务端错误展示 / 成功改名落盘', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-renamedlg-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '重命名集' }))

    // 裸 IPC 只切主进程 currentWS，渲染层 signal 需整页重载对齐（照 smoke 基建同款口径）
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    const mainDir = path.join(wsDir, '产品集', '重命名集', '图包', '主图')
    await fsp.mkdir(mainDir, { recursive: true })
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await fsp.writeFile(path.join(mainDir, '原图.png'), PNG_1PX)

    // 进入文件浏览器
    await page.evaluate(async () => {
      const route = `/files/image/${encodeURIComponent('重命名集')}/${encodeURIComponent('主图')}`
      window.history.pushState({}, '', route)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const cards = page.locator('.card')
    await cards.first().waitFor({ timeout: 15000 })

    // 右键 → 重命名（单文件；菜单根 id=ctx-menu-root 限定——页面「重命名集」按钮同名避免 strict 冲突；
    // 「批量重命名」为多选菜单项，单文件场景不渲染）→ 弹窗预填原名
    await cards.first().click({ button: 'right' })
    await page.locator('#ctx-menu-root').getByRole('button', { name: /重命名/ }).click()
    const dialog = page.getByRole('dialog', { name: '重命名' })
    await dialog.waitFor({ timeout: 10000 })
    const input = dialog.getByLabel('新文件名')
    await expect(input).toHaveValue('原图.png')

    // 同名未变更 → 确定禁用（同名重命名无意义）
    await expect(dialog.getByRole('button', { name: '确定' })).toBeDisabled()

    // 非法名（含 /）→ 服务端校验错误展示在弹窗内（不再静默 toast）
    await input.fill('非法/名.png')
    await dialog.getByRole('button', { name: '确定' }).click()
    await dialog.getByText(/文件名|非法|冲突/).waitFor({ timeout: 10000 })
    await expect(dialog).toBeVisible() // 错误态弹窗不关闭

    // 合法新名 → 成功关闭 + 磁盘落盘名变化
    await input.fill('新名字.png')
    await dialog.getByRole('button', { name: '确定' }).click()
    await dialog.waitFor({ state: 'detached', timeout: 10000 })
    await expect(fsp.stat(path.join(mainDir, '新名字.png'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(mainDir, '原图.png'))).rejects.toThrow()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('导入（按模板带编号）→ 再批量重命名：预览/落盘名嵌套（含导入编号段 + 新编号）', async () => {
    // 评审决策锁定（v2.4.9 S5）：导入先按模板改名（带编号，如 嵌套集_主图_banner_1.png）；
    // 再批量重命名时 original_name 槽位取当前文件名（已含导入编号）→ 产物嵌套 = 模板再套一次导入名 + 新序号。
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-renest-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '嵌套集' }))

    // 真实导入：2 个原始名文件 → 默认模板（product_set/sub_folder/original_name/sequence）落盘名带编号
    const srcDir = path.join(wsDir, '..', `src-${Date.now()}`)
    await fsp.mkdir(srcDir, { recursive: true })
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await fsp.writeFile(path.join(srcDir, 'banner.png'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, 'detail.jpg'), PNG_1PX)
    const importEvent = await page.evaluate(async (srcs) => {
      const qb = (window as any).qihebox
      return new Promise((resolve) => {
        const unsub = qb.events.on('import:complete', (data: any) => {
          unsub()
          resolve(data)
        })
        void qb.files.import({
          source_paths: srcs,
          target_product_set: '嵌套集',
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        })
      })
    }, [path.join(srcDir, 'banner.png'), path.join(srcDir, 'detail.jpg')]) as { success: boolean }
    expect(importEvent.success).toBe(true)

    const mainDir = path.join(wsDir, '产品集', '嵌套集', '图包', '主图')
    const imported = ['嵌套集_主图_banner_1.png', '嵌套集_主图_detail_2.jpg']
    for (const n of imported) await expect(fsp.stat(path.join(mainDir, n))).resolves.toBeTruthy()

    // 进入文件浏览器（/files/image/<产品集>/<子文件夹>）→ 多选 → 批量重命名
    await page.evaluate(async () => {
      const route = `/files/image/${encodeURIComponent('嵌套集')}/${encodeURIComponent('主图')}`
      window.history.pushState({}, '', route)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const cards = page.locator('.card')
    await cards.first().waitFor({ timeout: 15000 })
    await expect(cards).toHaveCount(2)
    await cards.nth(0).click()
    await cards.nth(1).click()
    await cards.nth(0).click({ button: 'right' })
    await page.getByRole('button', { name: /批量重命名/ }).click()

    // 预览名 = 嵌套：<集>_<子夹>_<集>_<子夹>_<原名>_<导入编号>_<新编号>.<ext>
    const dialog = page.getByRole('dialog', { name: /批量重命名/ })
    await dialog.getByText('批量重命名 2 个文件').waitFor({ timeout: 10000 })
    const previewTargets = await dialog.locator('span.text-surface-900').allTextContents()
    const nestPat = /^嵌套集_主图_嵌套集_主图_(banner|detail)_([12])_([12])\.(png|jpg)$/
    expect(previewTargets).toHaveLength(2)
    expect(previewTargets.every((t) => nestPat.test(t))).toBe(true)
    // 嵌套锁：每个预览必含对应导入名整体（含导入编号段），且新编号独立重计
    for (const [base, impNum] of [
      ['banner', '1'],
      ['detail', '2'],
    ] as const) {
      const hit = previewTargets.find((t) => t.match(nestPat)?.[1] === base)
      expect(hit, `预览应含导入名 ${base}`).toBeTruthy()
      expect(hit!.match(nestPat)![2]).toBe(impNum)
    }
    expect(new Set(previewTargets.map((t) => t.match(nestPat)![3]))).toEqual(new Set(['1', '2']))

    // 应用 → 列表落盘名与预览一致
    await dialog.getByRole('button', { name: /重命名 2 个/ }).click()
    await dialog.waitFor({ state: 'detached', timeout: 10000 })
    const listRes = (await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '嵌套集', file_type: 'image', sub_folder: '主图' }),
    )) as { success: boolean; data: Array<{ name: string }> | null }
    expect(listRes.success).toBe(true)
    const names = listRes.data!.map((f: { name: string }) => f.name)
    expect(names).toHaveLength(2)
    expect(new Set(names)).toEqual(new Set(previewTargets))

    // 磁盘：嵌套名落盘、导入名（含编号）已不存在
    for (const n of names) await expect(fsp.stat(path.join(mainDir, n))).resolves.toBeTruthy()
    for (const n of imported) await expect(fsp.stat(path.join(mainDir, n))).rejects.toThrow()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
  })
})
