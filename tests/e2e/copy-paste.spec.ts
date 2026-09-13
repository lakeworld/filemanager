import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 复制 / 粘贴 / 剪切体验 e2e（v2.5.8 D19 / 体验批 B1·B2·B3·B7）。
 *
 * 对到 PLAN §六 的验收口径：
 *  1. **B1**：预览弹窗里点「📋 复制文件」→ 成功 toast 可见（改造前成功全静默，只有失败才写错误条）；
 *  2. **B2**：图包库（不是文件浏览器）选中后按 Ctrl+C 出 toast，且**数量对**；
 *     发票台账批量条的「📋 复制」能复制归档文件；
 *  3. **B2③**：预览开着时按 Ctrl+C，复制的是**正在预览的那一张**，不是底层列表的选中项
 *     （原缺陷：底层页面在弹窗下保持挂载、监听仍活，会拿到列表选中的别的文件）；
 *  4. **B3**：剪贴板预置外部文件 → 在文件夹页按 Ctrl+V → 走既有导入管道落地；
 *  5. **B7**：`Ctrl+X` 标记 → 换子文件夹 → `Ctrl+V` 调 `files.move`，
 *     两端各查一遍（移动不是复制）；Esc 撤销后 Ctrl+V 什么都不搬。
 *
 * 为什么用 `_electron` 真按键而不是直调 IPC：这几条的语义就长在「真按一次组合键」上——
 * 直调会绕掉 `shortcuts.ts` 单点派发、绕掉预览让位守卫、绕掉剪贴板工具链，那正是要验的东西。
 *
 * 每个用例一个**独立产品集**：B7/B3 会真的移动、新增文件，共用一个集会互相留状态，
 * 让后跑的用例「断言通过但其实验的是别人的残留」（同 `preview-lifecycle` 的隔离教训）。
 */
test.describe('复制粘贴剪切体验（v2.5.8 D19）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''
  let srcDir = ''
  let caseNo = 0

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName('copy-paste'),
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-copypaste-ws-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 导入源文件放工作区**外**：粘贴导入的语义就是「把外面的文件拿进来」。
    // 从工作区内复制一份再粘回工作区，等于把这条链路最关键的「外部来源」那段测没了。
    srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-copypaste-src-'))
    for (const n of ['mkA.png', 'mkB.png', 'inv.pdf']) {
      await fsp.writeFile(path.join(srcDir, n), 'TEST-CONTENT')
    }
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

  /** 本用例专属产品集（`cp1` / `cp2`…），配合 `ps` 拼路由 */
  let ps = ''
  test.beforeEach(async () => {
    // 系统剪贴板是**跨用例的共享状态**（同一个 app 进程）：上一条 Ctrl+C 留下的文件列表
    // 会让下一条的 Ctrl+V 走「粘贴导入」，把「Esc 已撤销剪切」这条用例判成"移动还是发生了"。
    // 每例开头清一次，否则等于用例之间互相串内容。
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    ps = `cp${++caseNo}`
    await page.evaluate(async (name) => {
      const r = await (window as any).qihebox.productSets.create({ name })
      if (!r.success) throw new Error(JSON.stringify(r))
    }, ps)
  })

  /** 把一个外部文件导进指定子文件夹（走导入管道，顺带把子文件夹建出来） */
  const importTo = async (file: string, sub: string): Promise<void> => {
    await page.evaluate(
      async (a) => {
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
      },
      { src: srcDir, file, sub, ps },
    )
  }

  /** 某子文件夹当前的文件名列表 */
  const listSub = async (sub: string): Promise<string[]> => {
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

  /** 导入/移动都是异步落索引，轮询到符合预期为止（60×300ms = 18s 上限） */
  const waitListed = async (sub: string, marker: string, want: boolean): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      const hit = (await listSub(sub)).some((n) => n.includes(marker))
      if (hit === want) return
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(`子文件夹「${sub}」里 ${marker} 应当${want ? '出现' : '消失'}，轮询 18s 未达成`)
  }

  /** 复位后再导航（干净挂载），口径同 `clipboard-guard.spec.ts:81` */
  const gotoRoute = async (route: string): Promise<void> => {
    await page.evaluate(() => {
      window.location.hash = '/__e2e-reset'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.location.hash = decodeURIComponent(r)
    }, route)
  }

  /**
   * **不 reload** 的站内跳转（只改 hash）。
   * B7 的用例必须用它：`Ctrl+X` 的剪切标记住在渲染层内存里，reload 等于重启应用，
   * 标记必然消失——那会把「移动没发生」测成"标记被我自己清掉了"，是个假红也是假绿。
   * 真人换子文件夹就是一次 SPA 路由跳转（点面包屑/子文件夹 chips），本函数与之同形。
   */
  const spaRoute = async (route: string): Promise<void> => {
    await page.evaluate((r) => {
      window.location.hash = r
    }, route)
  }

  /** 走主进程那条新通道读剪贴板（B3 前提自证 + 缺工具环境据此 skip） */
  const readClipboardFiles = async (): Promise<string[]> => {
    const data = await page.evaluate(async () => {
      const r = await (window as any).qihebox.files.readClipboardFiles()
      return (r?.data ?? []) as string[]
    })
    return data
  }

  /** 清掉文本选区，让 Ctrl+C/Ctrl+X 落到页面语义而不是浏览器文本语义 */
  const clearTextSelection = async (): Promise<void> => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
  }

  test('B1：预览弹窗内点「复制文件」→ 成功也出声（改造前只有失败才写错误条）', async () => {
    await importTo('mkA.png', '主图')
    await gotoRoute(`/files/image/${ps}/主图`)
    await expect(page.locator('.card', { hasText: 'mkA' }).last()).toBeVisible({ timeout: 15000 })
    await page.locator('.card', { hasText: 'mkA' }).last().dblclick()
    // 按钮的可访问名是「📋 复制文件」（`FilePreviewModal.tsx` 底部按钮），
    // 「复制文件到剪贴板」是**右键菜单**里那一项的字面量（`preview-nav.spec.ts:246` 靠它定位菜单）——两条不同名，别混
    const copyBtn = page.getByRole('button', { name: '📋 复制文件' })
    await expect(copyBtn).toBeVisible({ timeout: 10000 })
    await copyBtn.click()
    await expect(page.getByText(/已复制 1 个文件到剪贴板/)).toBeVisible({ timeout: 5000 })
  })

  test('B2：图包库选中后 Ctrl+C 出 toast 且数量正确；发票台账批量条的「📋 复制」能复制归档文件', async () => {
    // —— ① 图包库 Ctrl+C（此前只能靠批量条按钮，按 Ctrl+C 毫无反应）——
    await importTo('mkA.png', '主图')
    await gotoRoute('/images')
    await expect(page.locator('.card', { hasText: 'mkA' }).last()).toBeVisible({ timeout: 15000 })
    await page.locator('.card', { hasText: 'mkA' }).last().click()
    await expect(page.getByText(/已选择 1 个/)).toBeVisible({ timeout: 5000 })
    await clearTextSelection()
    await app.evaluate(({ clipboard }) => clipboard.writeText('__CLEAR__'))
    await page.keyboard.press('Control+c')
    // 标量断言：钉「1 个」而不是「有 toast」——把整屏可见图都拷走也是一种"能复制"，那仍是缺陷
    await expect(page.getByText(/^已复制 1 个文件到剪贴板$/)).toBeVisible({ timeout: 5000 })
    const clip = await readClipboardFiles()
    test.skip(clip.length === 0, '本机读不回 text/uri-list（缺 xclip/xsel/wl-paste 且 Electron 回退不可用）')
    expect(clip).toHaveLength(1)
    expect(clip[0]).toContain('mkA')

    // —— ② 发票台账批量条（此前只有改状态/导出/删除，复制只能逐张右键）——
    const arc = await page.evaluate(async (src) => {
      const r = await (window as any).qihebox.invoices.archiveFile(`${src}/inv.pdf`, '2026-09-13')
      if (!r.success) throw new Error(JSON.stringify(r))
      return r.data as string
    }, srcDir)
    await page.evaluate(async (filePath) => {
      const r = await (window as any).qihebox.invoices.create({
        number: 'CP20260913001',
        code: 'A001',
        date: '2026-09-13',
        amount: 100,
        seller: '开票方甲',
        buyer: '购买方乙',
        status: '待报销',
        file_path: filePath,
        tags: [],
      })
      if (!r.success) throw new Error(JSON.stringify(r))
    }, arc)
    await gotoRoute('/invoices')
    // 台账行的选中走复选框（点卡片空白处会被卡片内的按钮/链接吞掉，`InvoiceCards.tsx:113-118` 的
    // onClick 也显式跳过 `button, input, a`），断言用浮条那句「已选择 N 张发票」
    const row = page.locator('.card', { hasText: 'CP20260913001' }).first()
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.locator('input[type="checkbox"]').check()
    await expect(page.getByText(/已选择 1 张发票/)).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: /📋 复制/ }).click()
    await expect(page.getByText(/已复制 1 个文件到剪贴板/)).toBeVisible({ timeout: 5000 })
  })

  test('B2③：预览开着时 Ctrl+C 复制正在预览的那一张，不是底层列表的选中项', async () => {
    await importTo('mkA.png', '主图')
    await importTo('mkB.png', '主图')
    await gotoRoute(`/files/image/${ps}/主图`)
    await expect(page.locator('.card', { hasText: 'mkA' }).last()).toBeVisible({ timeout: 15000 })
    // 底层选中 mkB，然后打开 mkA 的预览：原缺陷会复制成 mkB
    await page.locator('.card', { hasText: 'mkB' }).last().click()
    await page.locator('.card', { hasText: 'mkA' }).last().dblclick()
    await expect(page.getByRole('button', { name: '📋 复制文件' })).toBeVisible({ timeout: 10000 })
    await clearTextSelection()
    await app.evaluate(({ clipboard }) => clipboard.writeText('__CLEAR__'))
    await page.keyboard.press('Control+c')
    await expect(page.getByText(/已复制 1 个文件到剪贴板/)).toBeVisible({ timeout: 5000 })
    const clip = await readClipboardFiles()
    test.skip(clip.length === 0, '本机读不回 text/uri-list（缺剪贴板工具）')
    expect(clip).toHaveLength(1)
    expect(clip[0], '拿到 mkB = 底层页面抢走了预览的 Ctrl+C（B2③ 交棒失效）').toContain('mkA')
  })

  test('B3：剪贴板里有外部文件 → Ctrl+V → 落到当前子文件夹', async () => {
    const src = path.join(srcDir, 'mkA.png')
    // 用 Electron 直接预置 uri-list：不依赖本机装没装 xclip，写/读同一条格式
    await app.evaluate(
      ({ clipboard }, p) => clipboard.writeBuffer('text/uri-list', Buffer.from(`file://${p}\n`, 'utf-8')),
      src,
    )
    const seeded = await readClipboardFiles()
    test.skip(seeded.length === 0, '本机读不回 text/uri-list（缺 xclip/xsel/wl-paste 且 Electron 回退不可用）')

    await gotoRoute(`/files/image/${ps}/主图`)
    // 目标子文件夹先建出来（本集里除了粘进来的这一个不该有别的文件）
    await importTo('mkB.png', '详情页')
    await gotoRoute(`/files/image/${ps}/详情页`)
    await expect(page.locator('.card', { hasText: 'mkB' }).first()).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Control+v')
    await expect(page.getByText(/已粘贴导入 1 个文件到「详情页」/)).toBeVisible({ timeout: 15000 })
    await waitListed('详情页', 'mkA', true)
  })

  test('B7：Ctrl+X 标记 → 换子文件夹 → Ctrl+V 走移动（原目录真的少了那一个）', async () => {
    await importTo('mkA.png', '主图')
    await importTo('mkB.png', '详情页')
    await gotoRoute(`/files/image/${ps}/主图`)
    await expect(page.locator('.card', { hasText: 'mkA' }).last()).toBeVisible({ timeout: 15000 })
    await page.locator('.card', { hasText: 'mkA' }).last().click()
    await expect(page.getByText(/已选择 1 个/)).toBeVisible({ timeout: 5000 })
    await clearTextSelection()
    await page.keyboard.press('Control+x')
    await expect(page.getByText(/已标记 1 个文件为剪切/)).toBeVisible({ timeout: 5000 })

    // 换目录：用**站内跳转**（不是 reload）。剪切标记住在渲染层内存里，reload 等于重启应用，
    // 标记必然消失——那样测的是"我自己把状态冲了"，不是"换目录后 Ctrl+V 会不会移动"。
    await spaRoute(`/files/image/${ps}/详情页`)
    await expect(page.locator('.card', { hasText: 'mkB' }).first()).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Control+v')
    await expect(page.getByText(/已移动 1 个文件到「详情页」/)).toBeVisible({ timeout: 15000 })
    // 移动 ≠ 复制：两端各查一遍
    await waitListed('详情页', 'mkA', true)
    await waitListed('主图', 'mkA', false)
    // 用完即焚：再按一次 Ctrl+V 不该拿已经不在原地的路径再搬一遍
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(1000)
    await expect(page.getByText(/移动失败/)).toHaveCount(0)
  })

  test('B7 边界：Esc 撤销剪切标记后，Ctrl+V 什么都不搬', async () => {
    await importTo('mkA.png', '主图')
    await importTo('mkB.png', '详情页')
    await gotoRoute(`/files/image/${ps}/主图`)
    await expect(page.locator('.card', { hasText: 'mkA' }).last()).toBeVisible({ timeout: 15000 })
    await page.locator('.card', { hasText: 'mkA' }).last().click()
    await clearTextSelection()
    await page.keyboard.press('Control+x')
    await expect(page.getByText(/已标记 1 个文件为剪切/)).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape') // 层栈：只有有标记时才入栈，Esc 撤销标记
    // 同样用站内跳转：reload 会连标记一起冲掉，那样这条用例就成了永远为真的空检查
    await spaRoute(`/files/image/${ps}/详情页`)
    await expect(page.locator('.card', { hasText: 'mkB' }).first()).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Control+v')
    await page.waitForTimeout(1000)
    await expect(page.getByText(/已移动|移动失败/)).toHaveCount(0)
    await waitListed('详情页', 'mkA', false)
  })
})
