import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 预览连续切换 e2e（v2.5.8 D18）。
 *
 * 权威 = `docs/INTERNAL/PLAN-v2.5.8-预览连续切换与体验盘点.md` §六 e2e 清单（本 spec 逐条对应）：
 *   例 1 左右切换标题与图源变更 → 本文件 test 1
 *   例 2 到头绕回（**循环语义**，2026-09-13 用户拍板 #1）→ test 2
 *   例 3 元数据输入框聚焦守卫不切换 → test 3
 *   例 4 连按 5 次终态为最后一张（代际守卫不回归）→ test 4
 *   例 5 Esc 与右键菜单让位不回归 → test 5
 *   附加：只有一张 / 单文件入口不显示 ◀▶（守卫一与「不传 list = 现状不变」）→ test 6
 *
 * 载体选文件浏览器（`/files/image/<集>/<子目录>`）：它是 D18 接线里最直接的一处
 * （`handleOpenPreview` 传 `filteredFiles()`），且卡片顺序 = `filteredFiles()` 顺序 =
 * 导航快照顺序，**顺序从 DOM 现读**，不假设排序规则（改排序不该改这套断言）。
 *
 * 图源断言用 `<img alt={文件名}>`（FilePreviewModal 里 alt 就是 previewFile().name）：
 * `qihebox://thumb/` 的 URL 段是哈希，比不出「换了张图」，而 alt 能。
 */
test.describe('预览连续切换（v2.5.8 D18）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  const PS3 = '连看测试集' // 三张：循环语义的载体
  const PS1 = '单张测试集' // 一张：长度 1 守卫的载体

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('preview-nav') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pvnav-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), PS3)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), PS1)

    // 直写磁盘不进文件索引 ⇒ 必须走导入流程（照 clipboard-guard 先例）
    const sharp = (await import('sharp')).default
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pvnav-src-'))
    const importInto = async (ps: string, names: string[]) => {
      const paths: string[] = []
      for (const [i, n] of names.entries()) {
        const p = path.join(srcDir, n)
        await sharp({
          create: { width: 200 + i, height: 120 + i, channels: 3, background: { r: 30 + i * 40, g: 90, b: 150 } },
        })
          .png()
          .toFile(p)
        paths.push(p)
      }
      const r = await page.evaluate(
        async (a) => (window as any).qihebox.files.import({
          source_paths: a.paths,
          target_product_set: a.ps,
          target_type: 'image',
          sub_folder: '主图',
          with_lazy: false,
        }),
        { paths, ps },
      )
      if (!r.success) throw new Error(`导入失败 ${ps}: ${JSON.stringify(r)}`)
    }
    await importInto(PS3, ['pnav-a.png', 'pnav-b.png', 'pnav-c.png'])
    await importInto(PS1, ['pnav-solo.png'])

    // 导入异步完成（import:complete）→ 轮询索引到齐
    for (const [ps, want] of [[PS3, 3], [PS1, 1]] as const) {
      let got = 0
      for (let i = 0; i < 80; i++) {
        got = await page.evaluate(
          async (a) =>
            (((await (window as any).qihebox.files.list({
              product_set: a.ps,
              file_type: 'image',
              sub_folder: '主图',
              scope: 'productSet',
            }))?.data ?? []) as unknown[]).length,
          { ps, want },
        )
        if (got >= want) break
        await new Promise((r) => setTimeout(r, 300))
      }
      expect(got, `${ps} 应导入 ${want} 张（beforeAll 前提）`).toBeGreaterThanOrEqual(want)
    }
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
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

  /** 复位到无匹配空路由再整页 reload（v2.5.7 补丁后的标准导航口径） */
  const gotoRoute = async (route: string) => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => { window.location.hash = decodeURIComponent(r) }, route)
  }

  /** 卡片的文件名（DOM 顺序 = filteredFiles() 顺序 = 导航快照顺序） */
  const cardNames = async (): Promise<string[]> =>
    (await page.locator('.card div.text-sm.font-medium.truncate').allTextContents()).map((s) => s.trim())

  /** 进某产品集主图页并等到卡片数就位，返回 DOM 顺序的文件名 */
  const openFolder = async (ps: string, want: number): Promise<string[]> => {
    await gotoRoute(`/files/image/${ps}/主图`)
    let names: string[] = []
    for (let i = 0; i < 20; i++) {
      names = await cardNames()
      if (names.length >= want) break
      await page.waitForTimeout(500)
    }
    expect(names.length, `${ps} 卡片应到齐 ${want} 张`).toBeGreaterThanOrEqual(want)
    return names
  }

  const previewTitle = () => page.locator('[data-preview-title]')
  const navPos = () => page.locator('[data-navpos]')
  const imgOf = (name: string) => page.locator(`img[alt="${name}"]`)

  test('例 1：双击开预览 → → 换下一张（标题与图源同换）→ ← 回原张', async () => {
    const names = await openFolder(PS3, 3)
    await page.locator('.card').first().dblclick()

    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })
    await expect(imgOf(names[0])).toBeVisible({ timeout: 15000 })
    // 位置指示与 ◀▶ 只在「列表 >1 且当前项在快照里」时出现
    await expect(navPos()).toHaveText('1 / 3')
    await expect(page.locator('[data-nav-next]')).toBeVisible()
    await expect(page.locator('[data-nav-prev]')).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await expect(previewTitle()).toHaveText(names[1], { timeout: 15000 })
    await expect(navPos()).toHaveText('2 / 3')
    await expect(imgOf(names[1])).toBeVisible({ timeout: 15000 })
    // 上一张的图源必须真的卸掉（不是叠在下面）：alt 只对应当前那张
    await expect(imgOf(names[0])).toHaveCount(0)

    await page.keyboard.press('ArrowLeft')
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })
    await expect(navPos()).toHaveText('1 / 3')

    await page.keyboard.press('Escape')
    await expect(previewTitle()).toHaveCount(0)
  })

  test('例 2：最后一张再按 → 绕回第一张（拍板 #1 = 循环，不到头停）', async () => {
    const names = await openFolder(PS3, 3)
    await page.locator('.card', { hasText: names[2] }).first().dblclick()
    await expect(previewTitle()).toHaveText(names[2], { timeout: 15000 })
    await expect(navPos()).toHaveText('3 / 3')

    await page.keyboard.press('ArrowRight')
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })
    await expect(navPos()).toHaveText('1 / 3')

    // 反向同样绕回：在最前一张按 ← 应到最后一张
    await page.keyboard.press('ArrowLeft')
    await expect(previewTitle()).toHaveText(names[2], { timeout: 15000 })
    await expect(navPos()).toHaveText('3 / 3')
    await page.keyboard.press('Escape')
  })

  test('例 2b：点 ◀▶ 按钮与方向键等效（同一 navigatePreview 出口）', async () => {
    const names = await openFolder(PS3, 3)
    await page.locator('.card').first().dblclick()
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })

    await page.locator('[data-nav-next]').click()
    await expect(previewTitle()).toHaveText(names[1], { timeout: 15000 })
    await page.locator('[data-nav-prev]').click()
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })
    await page.keyboard.press('Escape')
  })

  test('例 3：元数据输入框聚焦时按方向键 → 不切换（守卫③：打字不该翻页）', async () => {
    const names = await openFolder(PS3, 3)
    // 「编辑信息」入口才带 productSet + editMetadata ⇒ 元数据面板才出现（同传 list，D3）
    await page.locator('.card').first().click({ button: 'right' })
    await page.getByText('编辑信息').click()
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })
    const certType = page.getByPlaceholder('如：3C')
    await expect(certType).toBeVisible({ timeout: 10000 })

    await certType.click()
    await certType.fill('3C')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    // 标题与位置指示都不该动
    await expect(previewTitle()).toHaveText(names[0])
    await expect(navPos()).toHaveText('1 / 3')
    // 输入内容也不该被全站快捷键吃掉
    await expect(certType).toHaveValue('3C')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  test('例 4：连按 5 次 → 终态为第五张落点（代际守卫不回归，不串图）', async () => {
    const names = await openFolder(PS3, 3)
    await page.locator('.card').first().dblclick()
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })

    // 连发不等：5 步 × 3 张 = 落点 (0+5)%3 = 2（即第三张），中间每次换代都不同
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    await expect(previewTitle()).toHaveText(names[2], { timeout: 15000 })
    await expect(navPos()).toHaveText('3 / 3')
    // 终态图源 = 第三张；前两张不得残留在 DOM（旧请求迟到的表现就是叠图）
    await expect(imgOf(names[2])).toBeVisible({ timeout: 15000 })
    await expect(imgOf(names[0])).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('例 5：预览内右键菜单开着时按 → 不切换；Esc 先关菜单再关预览（让位不回归）', async () => {
    const names = await openFolder(PS3, 3)
    await page.locator('.card').first().dblclick()
    await expect(previewTitle()).toHaveText(names[0], { timeout: 15000 })

    // 预览内右键 = 画面区（`onContextMenu` 挂在 aspect-video 容器上，标题行没有该处理器）
    await page.locator('.aspect-video').first().click({ button: 'right' })
    await expect(page.getByText('复制文件到剪贴板')).toBeVisible({ timeout: 10000 })

    await page.keyboard.press('ArrowRight') // 守卫②：菜单开着不该切
    await expect(previewTitle()).toHaveText(names[0])

    await page.keyboard.press('Escape') // 第一次 Esc 关菜单，预览留
    await expect(page.getByText('复制文件到剪贴板')).toHaveCount(0)
    await expect(previewTitle()).toHaveText(names[0])

    await page.keyboard.press('Escape') // 第二次才关预览
    await expect(previewTitle()).toHaveCount(0)
  })

  test('例 6：只有一张 ⇒ 不显示 ◀▶ 与位置指示（守卫一）；无快照入口同', async () => {
    await openFolder(PS1, 1)
    await page.locator('.card').first().dblclick()
    await expect(previewTitle()).toHaveText(/pnav-solo|\.png$/, { timeout: 15000 })
    await expect(page.locator('[data-nav-next]')).toHaveCount(0)
    await expect(page.locator('[data-nav-prev]')).toHaveCount(0)
    await expect(navPos()).toHaveCount(0)
    // 方向键在单张预览里是空操作（不报错、不关窗、不换图）
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await expect(previewTitle()).toBeVisible()
    await page.keyboard.press('Escape')
  })
})
