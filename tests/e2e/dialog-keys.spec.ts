import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 弹窗开着时的按键归属 e2e（v2.5.9 加固轮 D1）。
 *
 * 三条缺陷全部是**先实测复现、再改代码**（探针原始输出见本次会话记录，探针文件已按
 * 内部调试守则 §三 删除、结论折进本文件）：
 *  1. 预览弹窗里按 `Delete` 删的是**底层选中的另一个文件**——屏幕上显示 mkA、
 *     弹的却是「确定删除选中的 1 个文件吗」（那一个是 mkB）；底层零选中时按 Delete 干脆没反应。
 *     数据风险最高的一条：确认框文案不透露文件名。
 *  2. 表单弹窗（重命名）开着、焦点不在输入框时，`Ctrl+C` 被底层抢走（弹
 *     「已复制 1 个文件到剪贴板」）、`Ctrl+A` 把底层列表多选、`Delete` 在弹窗上又叠一层删除确认。
 *     ⇒ 用户口径「弹窗里不能用复制粘贴」的真实机制。
 *  3. 反向护栏：`guard:"text"` 只认「焦点在不在输入元素」，点一下弹窗按钮/空白就离开输入框，
 *     所以修复不能靠在输入框里加判断，必须在层这一侧判（`layerStack.hasModalLayer()`）。
 *
 * 与 `copy-paste.spec.ts` 同口径：**真按键**而不是直调 IPC——直调会绕掉 `shortcuts.ts`
 * 单点派发、绕掉层栈让位，那正是要验的东西。
 */
test.describe('弹窗开着时的按键归属（v2.5.9）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''
  let srcDir = ''
  let caseNo = 0

  const filesRoute = (ps: string, sub: string): string =>
    `/files/image/${ps}/${encodeURIComponent(sub)}`

  /** 复位后再导航（干净挂载），口径同 `copy-paste.spec.ts` */
  const gotoRoute = async (route: string): Promise<void> => {
    await page.evaluate(() => {
      window.location.hash = '/__e2e-reset'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15_000 })
    await page.evaluate((r) => {
      window.location.hash = r
    }, route)
  }

  const importTo = async (ps: string, sub: string, file: string): Promise<void> => {
    await page.evaluate(async (a) => {
      const r = await (window as any).qihebox.files.import({
        source_paths: [`${a.src}/${a.file}`],
        target_product_set: a.ps,
        target_folder: a.sub,
        target_type: 'image',
        sub_folder: a.sub,
        scope: 'productSet',
        with_lazy: false,
      })
      if (!r.success) throw new Error(JSON.stringify(r))
    }, { src: srcDir, ps, sub, file })
  }

  /** 某子文件夹当前的文件名列表（删除是否真落地，只看磁盘/索引，不信 toast） */
  const listSub = async (ps: string, sub: string): Promise<string[]> => {
    const data = await page.evaluate(async (q) => {
      const r = await (window as any).qihebox.files.list({
        product_set: q.ps,
        file_type: 'image',
        sub_folder: q.sub,
        scope: 'productSet',
      })
      return (r?.data ?? []) as { name: string }[]
    }, { ps, sub })
    return data.map((f) => f.name)
  }

  /** 当前打开的弹窗标题（`ui/Modal` 的 aria-label；预览不是 Modal，返回空数组） */
  const dialogLabels = async (): Promise<string[]> =>
    page.locator('[role="dialog"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '(无标签)'))

  const closeAllLayers = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      if ((await page.locator('[role="dialog"]').count()) > 0) {
        const cancel = page.getByRole('button', { name: '取消' }).last()
        if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {})
        else await page.keyboard.press('Escape').catch(() => {})
      } else if (await page.locator('[data-preview-title]').isVisible().catch(() => false)) {
        await page.keyboard.press('Escape').catch(() => {})
      } else {
        return
      }
      await page.waitForTimeout(200)
    }
  }

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('dialog-keys') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15_000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dialogkeys-ws-'))
    srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dialogkeys-src-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    for (const n of ['mkA.png', 'mkB.png']) await fsp.writeFile(path.join(srcDir, n), 'TEST-CONTENT')
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
    for (const d of [wsDir, srcDir]) {
      if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 每个用例一个独立产品集：删除用例会真把文件移进回收站，共用一个集会互相留状态 */
  let ps = ''
  test.beforeEach(async () => {
    await closeAllLayers()
    ps = `dk${++caseNo}`
    await page.evaluate(async (name) => {
      const r = await (window as any).qihebox.productSets.create({ name })
      if (!r.success) throw new Error(JSON.stringify(r))
    }, ps)
    await importTo(ps, '主图', 'mkA.png')
    await importTo(ps, '主图', 'mkB.png')
    await gotoRoute(filesRoute(ps, '主图'))
    await expect(page.locator('.card')).toHaveCount(2, { timeout: 20_000 })
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  })

  test('护栏：没有弹窗时，Delete 仍是既有的「删除底层选中项 + 二次确认」语义（修复没把它扳死）', async () => {
    await page.locator('.card', { hasText: 'mkA' }).last().click()
    await page.locator('.card', { hasText: 'mkB' }).last().click({ modifiers: ['Control'] })
    await expect(page.locator('text=已选择 2 个文件')).toBeVisible()
    // 焦点离开卡片（blur 到 body），确保走的是快捷键而不是元素自身按键
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog', { name: '删除文件' })).toBeVisible({ timeout: 5000 })
    expect(await dialogLabels()).toContain('删除文件')
    await page.getByRole('button', { name: '取消' }).last().click()
    await expect(page.getByRole('dialog', { name: '删除文件' })).toBeHidden({ timeout: 5000 })
    expect(await listSub(ps, '主图')).toHaveLength(2)
  })

  test('预览里按 Delete：删的是眼前正在预览的那一张，不是底层选中的另一个', async () => {
    // 底层选中 mkB，屏幕上打开的是 mkA —— 原缺陷会弹「删除选中的 1 个文件」把 mkB 端走
    await page.locator('.card', { hasText: 'mkB' }).last().click()
    await page.locator('.card', { hasText: 'mkA' }).last().dblclick()
    const title = page.locator('[data-preview-title]')
    await expect(title).toBeVisible({ timeout: 15_000 })
    const previewName = (await title.innerText()).trim()
    expect(previewName).toContain('mkA')

    await page.keyboard.press('Delete')
    const dlg = page.getByRole('dialog', { name: '删除文件' })
    await expect(dlg).toBeVisible({ timeout: 5000 })
    // 判据是「确认框里点名的文件 == 眼前这一张」，不是「弹了个框就算对」
    await expect(page.getByRole('dialog', { name: '删除文件' })).toContainText(previewName)
    await page.getByRole('button', { name: '删除' }).last().click()

    // 删除即移入回收站：以索引/磁盘为准，且只能少掉预览那一张
    for (let i = 0; i < 40; i++) {
      const names = await listSub(ps, '主图')
      if (names.length === 1) {
        expect(names[0], '被删掉的应当是预览中的 mkA，留下的应当是 mkB').toContain('mkB')
        return
      }
      await page.waitForTimeout(300)
    }
    expect(await listSub(ps, '主图'), '预览内 Delete 没有真的删掉眼前这一张').toHaveLength(1)
  })

  test('预览开着时 Ctrl+A / Ctrl+2 不穿透到底层（这两条预览自己没有处理器，唯一让位来源就是层标记）', async () => {
    // 上一条用例里预览的 Delete 是「预览自己注册的那条」赢下派发，就算没有层让位也照样对
    // （实测：把 preview 的 modal 标记摘掉它仍绿）⇒ 真要钉住预览的层标记，只能测它没有处理器的键。
    await page.locator('.card', { hasText: 'mkB' }).last().click()
    await page.locator('.card', { hasText: 'mkA' }).last().dblclick()
    await expect(page.locator('[data-preview-title]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('text=已选择 1 个文件')).toBeVisible()

    await page.keyboard.press('Control+a')
    await page.waitForTimeout(400)
    await expect(page.locator('text=已选择 1 个文件'), '预览开着按 Ctrl+A 把底层全选成了 2 个').toBeVisible()
    await expect(page.locator('text=已选择 2 个文件')).toBeHidden()

    const hashBefore = await page.evaluate(() => window.location.hash)
    await page.keyboard.press('Control+2') // 侧边栏第 2 项 = 产品集
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => window.location.hash), '预览开着按 Ctrl+2 跳走了页面').toBe(hashBefore)
    await expect(page.locator('[data-preview-title]'), '预览开着按 Ctrl+2 把预览连带关掉').toBeVisible()
    expect(await listSub(ps, '主图'), '这条用例不该动文件').toHaveLength(2)
  })

  test('表单弹窗开着：Ctrl+C / Ctrl+A / Delete 都不许穿透到底层页面', async () => {
    await page.locator('.card', { hasText: 'mkA' }).last().click()
    await expect(page.locator('text=已选择 1 个文件')).toBeVisible()
    await page.locator('.card', { hasText: 'mkA' }).last().click({ button: 'right' })
    const renameItem = page.locator('#ctx-menu-root button', { hasText: /重命名\s*$/ }).first()
    await renameItem.waitFor({ timeout: 8000 })
    await renameItem.click()
    const dlg = page.locator('[role="dialog"]').last()
    await expect(dlg).toBeVisible({ timeout: 8000 })
    // 把焦点请出输入框：`guard:"text"` 这条豁免在此失效，正是原缺陷的触发条件
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // ① Ctrl+C 不许被底层抢去复制文件（原实测：弹出「已复制 1 个文件到剪贴板」toast）
    await page.keyboard.press('Control+c')
    await expect(page.locator('text=/已复制 \\d+ 个文件/')).toBeHidden({ timeout: 1500 })
    // ② Ctrl+A 不许把底层列表多选（原实测：浮条从 1 个变成 2 个）
    await page.keyboard.press('Control+a')
    await expect(page.locator('text=已选择 1 个文件')).toBeVisible()
    await expect(page.locator('text=已选择 2 个文件')).toBeHidden()
    // ③ Delete 不许在弹窗上再叠一层删除确认（原实测：dialogLabels 变成 ['重命名','删除文件']）
    await page.keyboard.press('Delete')
    await page.waitForTimeout(600)
    expect(await dialogLabels(), '弹窗开着按 Delete 又叠出一层删除确认').toEqual(['重命名'])
    // 弹窗本身仍然正常：Esc 关得掉，文件一个没少
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5000 })
    expect(await listSub(ps, '主图')).toHaveLength(2)
  })
})
