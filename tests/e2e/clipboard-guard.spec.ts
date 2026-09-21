import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A1 剪贴板劫持守卫 e2e（v2.5.7）：
 * - 文件选中（无文本选区）时 Ctrl+C 复制文件路径（既有语义不变）
 * - 输入框/文本域中有选区时 Ctrl+C 不被劫持 → 剪贴板保持原文（根因 1 修复核心）
 * - 输入框 Ctrl+V 粘贴正常（原生语义不拦）
 * - Crepe 编辑器（contenteditable）内 Ctrl+C/Ctrl+K 不被抢（豁免回归）
 */
test.describe('剪贴板劫持守卫（v2.5.7 A1）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('clipboard-guard') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clip-guard-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    // 产品集 + 通过应用导入一个文件（走导入流程才会进文件索引；直接 fsp 写盘不更新索引）
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '剪贴板测试集' }))
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clip-src-'))
    await fsp.writeFile(path.join(srcDir, 'clip.png'), 'PNG-TEST')
    // ── v2.5.9/A1d 定责收口：这条红的根因是**本 spec 自己的 fixture 竞态**，不是"机器慢" ──
    // `files.import` 是 fire-and-forget：`src/main/ipc.ts:367` 原话「与原 Go goroutine 模式一致：
    // **立即返回**，完成后发 import:complete 事件」⇒ `success:true` 只代表**受理**，不代表落地。
    // 而这里原先一拿到 ack 就 `fsp.rm(srcDir)`：若 unlink 抢在主进程 `open()` 之前，复制就读不到源。
    // 负载越高、ack 与 open 之间间隔越长 ⇒ 越容易撞上（正好解释"隔离跑偶红、全量跑常红"）。
    // 同机两臂实测（每臂 8 次隔离跑，其余完全相同）：
    //   旧行为臂（ack 后立刻 rm）= **8 次红 1 次**；新行为臂（等 import:complete 再 rm）= **8 次红 0 次**。
    // 判据本身也升级：先看 `failed` 明细（v2.4.2 I1 起事件带失败清单），再看索引可见性轮询。
    const importComplete = page.evaluate(
      () =>
        new Promise<any>((resolve) => {
          const qb = (window as any).qihebox
          const unsub = qb.events.on('import:complete', (data: any) => {
            if (typeof unsub === 'function') unsub()
            resolve(data)
          })
        }),
    )
    await page.evaluate(async (src) => {
      const r = await (window as any).qihebox.files.import({
        source_paths: [src + '/clip.png'],
        target_product_set: '剪贴板测试集',
        target_type: 'image',
        sub_folder: '主图',
        with_lazy: false,
      })
      if (!r.success) throw new Error(JSON.stringify(r))
    }, srcDir)
    const complete = await Promise.race([
      importComplete,
      new Promise<any>((resolve) => setTimeout(() => resolve({ timedOut: true }), 20000)),
    ])
    expect(complete.timedOut, '20 秒内没等到 import:complete 事件（导入管道没回音）').toBeFalsy()
    expect(complete.failed ?? [], 'import:complete 带回失败明细（源没读到 / 落地被拒）').toHaveLength(0)
    expect(complete.count, 'import:complete 应回执落地 1 个文件').toBe(1)
    // 到这里才允许删源：事件已证明文件被复制走了（删早了就是上面那条竞态）
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
    let imported = false
    let lastList: string[] = []
    for (let i = 0; i < 80; i++) {
      const list = await page.evaluate(async () =>
        ((await (window as any).qihebox.files.list({
          product_set: '剪贴板测试集',
          file_type: 'image',
          sub_folder: '主图',
          scope: 'productSet',
        }))?.data ?? []) as { name: string }[],
      )
      lastList = list.map((f) => f.name)
      if (list.some((f) => f.name.includes('clip'))) {
        imported = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    // 红的时候必须**自己把答案带出来**（A1a 那一课：当时判据只有 `Expected true / Received false`，
    // 只能去 GitHub 未鉴权读 check-run annotations 反推，再靠人猜"是没拷进来"还是"索引没跟上"）。
    // 所以这里在失败信息里塞进三项独立事实：盘上有没有 / 索引给了什么 / 名单里有没有这个类型。
    // ⚠ 只加诊断，**不改判据也不加轮询预算**（80×300ms 与 `toBe(true)` 一字未动）。
    if (!imported) {
      const diag = await page
        .evaluate(async (seen) => {
          const cfg = await (window as any).qihebox.config.get()
          return {
            索引返回列表: seen,
            config_image_subfolders: (cfg?.data?.image_subfolders ?? []) as string[],
          }
        }, lastList)
        .catch((e) => ({ 诊断本身失败: String(e) }))
      const 目标目录 = path.join(wsDir, '产品集', '剪贴板测试集', '图包', '主图')
      const 盘上内容 = await fsp.readdir(目标目录).catch((e) => `目录读不到：${String(e)}`)
      throw new Error(
        '导入应进入文件索引（beforeAll 前提）——诊断：' +
          JSON.stringify({ 盘上图包主图目录: 盘上内容, ...diag, 轮询次数: '80×300ms 已用尽' }),
      )
    }

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

  /** 复位后再导航（干净挂载）；v2.5.7 补丁：file:// 走 HashRouter，location.hash 赋值原生触发 hashchange */
  const gotoRoute = async (route: string) => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.location.hash = decodeURIComponent(r)
    }, route)
  }

  test('文件选中（无选区）Ctrl+C → 触发文件路径复制（既有语义）', async () => {
    await gotoRoute('/files/image/剪贴板测试集/主图')
    // 导入走命名模板会加序号前缀（如 剪贴板测试集_主图_clip_1.png）——用含 clip 的行定位
    await expect(page.locator('.card', { hasText: 'clip' }).last()).toBeVisible({ timeout: 15000 })
    // 先清剪贴板 + 明确无任何 toast 残留
    await app.evaluate(({ clipboard }) => clipboard.writeText('__CLEAR__'))
    // 点「全选」选中文件（按钮点击不产生文本选区 → 折叠选区守卫放行文件路径复制）
    await page.getByRole('button', { name: '全选' }).click()
    await expect(page.getByText(/已选择 1 个文件/)).toBeVisible({ timeout: 5000 })
    // 显式清空文本选区（确保折叠/无选区——点空白区域受时序影响，removeAllRanges 确定性）
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await page.keyboard.press('Control+c')
    // Ctrl+C 命中窗口级守卫 → 走 copyFilesToClipboard（原生文件复制，text/uri-list 非纯文本）：
    // 断言「已复制 N 个文件」toast 出现（证明劫持路径生效，而非被文本选区语义吞掉）
    await expect(page.getByText(/已复制 1 个文件到剪贴板/)).toBeVisible({ timeout: 5000 })
  })

  test('文本选区在输入框内 Ctrl+C → 不被劫持（剪贴板保留原文）', async () => {
    await gotoRoute('/files/image/剪贴板测试集/主图')
    // 预置剪贴板原文
    await app.evaluate(({ clipboard }) => clipboard.writeText('原文-正文复制'))
    // 在页面注入一个可聚焦的 textarea，选中文本后按 Ctrl+C
    await page.evaluate(() => {
      const ta = document.createElement('textarea')
      ta.id = 'clip-selection-test'
      ta.value = '要复制的正文内容'
      ta.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:100px;z-index:99999'
      document.body.appendChild(ta)
    })
    await page.locator('#clip-selection-test').focus()
    await page.locator('#clip-selection-test').selectText()
    await page.keyboard.press('Control+c')
    await page.waitForTimeout(300)
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clip).toBe('要复制的正文内容')
    await page.evaluate(() => document.getElementById('clip-selection-test')?.remove())
  })

  test('输入框内 Ctrl+V 粘贴正常（原生语义放行）', async () => {
    await gotoRoute('/search')
    await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 15000 })
    const input = page.getByRole('textbox').first()
    await input.focus()
    await app.evaluate(({ clipboard }) => clipboard.writeText('粘贴验证文本'))
    await page.keyboard.press('Control+v')
    await expect(input).toHaveValue('粘贴验证文本')
  })

  test('右键输入框 → main 日志打点 [context-menu]（T1 接线回归）', async () => {
    // 注入可聚焦 input 并右键：主进程 context-menu 事件应打 `[context-menu] isEditable=…` info 行
    await page.evaluate(() => {
      const inp = document.createElement('input')
      inp.id = 'clip-ctx-test'
      inp.value = '可编辑'
      inp.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:40px;z-index:99999'
      document.body.appendChild(inp)
    })
    await page.locator('#clip-ctx-test').click({ button: 'right' })
    await page.waitForTimeout(400)
    // 读 e2e userData 的 main-*.log（与日志系同目录；异步写，轮询）
    const logsDir = path.join(os.tmpdir(), e2eUserDataDirName('clipboard-guard'), 'logs')
    let text = ''
    for (let i = 0; i < 40; i++) {
      try {
        const names = await fsp.readdir(logsDir)
        const files = names.filter((f) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        const parts = await Promise.all(files.map((f) => fsp.readFile(path.join(logsDir, f), 'utf8').catch(() => '')))
        text = parts.join('\n')
      } catch {
        text = ''
      }
      if (text.includes('[context-menu] isEditable=')) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(text).toContain('[context-menu] isEditable=')
    await page.evaluate(() => document.getElementById('clip-ctx-test')?.remove())
  })

  test('Crepe 编辑器内 Ctrl+C/Ctrl+K 不被抢（contenteditable 豁免回归）', async () => {
    // 内建「笔记」文件夹对文档区可见——经应用写一篇笔记（走 writeText IPC，索引/列表直接可见）
    await page.evaluate(async () => {
      const r = await (window as any).qihebox.files.writeText('产品集/剪贴板测试集/文档/笔记/豁免回归.md', '# 豁免文本\n\n可编辑正文')
      if (!r.success) throw new Error(JSON.stringify(r))
    })
    await gotoRoute('/files/doc/剪贴板测试集/文档')
    await page.getByRole('button', { name: '笔记', exact: true }).click()
    await expect(page.getByText('豁免回归.md')).toBeVisible({ timeout: 15000 })
    await page.getByText('豁免回归.md').dblclick()
    const editor = page.locator('[data-note-editor] [contenteditable="true"]').first()
    await expect(editor).toBeVisible({ timeout: 20000 })

    // 选中正文 → Ctrl+C：剪贴板应为文本（不被劫持为文件路径）
    await app.evaluate(({ clipboard }) => clipboard.writeText('__CLEAR2__'))
    await editor.click()
    await editor.press('Control+a')
    await editor.press('Control+c')
    await page.waitForTimeout(300)
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clip).not.toBe('__CLEAR2__')
    expect(clip).not.toContain('豁免回归.md') // 若被劫持会变成文件路径
    expect(clip).toContain('豁免文本')

    // Ctrl+K 在编辑区不触发全局搜索聚焦（Header 豁免）
    await editor.press('Control+k')
    await page.waitForTimeout(200)
    // 焦点仍在编辑器（未被搜索框抢走）
    const activeTag = await page.evaluate(() => document.activeElement?.tagName)
    expect(activeTag).not.toBe('INPUT')
  })

  // v2.5.7 补丁金丝雀（2026-09-07）：生产 file:// 下路径型 pushState 路由失效——
  // Windows 真机「点仪表盘不跳转、其余菜单正常」根因 = navigate('/') 的 pushState 目标
  // 解析为 file:/// 非法 + 冷启动 pathname 为物理路径匹配不到路由。HashRouter 后本用例
  // 在 file:// 构建产物上守住「侧边栏 ↔ 仪表盘」跳转这一真实生产路径。
  test('file:// 侧边栏跳转金丝雀：仪表盘 ↔ 产品集往返（生产模式路由）', async () => {
    await gotoRoute('/product-sets')
    await expect(page.getByRole('heading', { name: '产品集', exact: true, level: 1 })).toBeVisible({ timeout: 15000 })
    // 复现原缺陷的点击路径：从业务页回仪表盘（旧路径型路由下此点击静默失败）
    await page.getByRole('button', { name: '仪表盘' }).click()
    await expect(page.getByRole('heading', { name: '仪表盘', exact: true, level: 1 })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '产品集' }).click()
    await expect(page.getByRole('heading', { name: '产品集', exact: true, level: 1 })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '仪表盘' }).click()
    await expect(page.getByRole('heading', { name: '仪表盘', exact: true, level: 1 })).toBeVisible({ timeout: 15000 })
  })

  /**
   * 守卫**关态**的真链路验收（复审 r2 A-7：关态此前零覆盖）。
   * `tests/unit/clipboardGuard-off.test.ts` 那 8 例是纯函数级，钉的是「开关关掉后走哪条分支」；
   * 这一条钉的是「真按一次 Ctrl+C，屏幕上的表现确实翻转」——同一处语义，两个层次都要有人看着。
   *
   * 关态语义（`FileBrowserView.tsx:390`）：`clipboardGuardOn()` 为假 ⇒ 不再让位正文选区，
   * 文件选中优先 → 复制文件路径（回到 v2.5.7 A1 之前的口径）。
   *
   * 为什么正反两半必须一起跑（任何一半单独存在都会假绿）：
   *  - 只跑关态：若「造非折叠选区」那步根本没生效，关态照样出 toast ⇒ 绿得没有意义；
   *  - 加开态反向半：同一串动作在开态下**不该**出 toast ⇒ 选区没造出来时这一半会红。
   * 另外选区刻意造在**普通 div** 上而不是输入框里：输入框/contenteditable 走的是豁免①
   * （`isTextTarget`），与守卫开关无关，拿它测守卫等于什么都没测。
   */
  test('剪贴板守卫关态：正文有选区时 Ctrl+C 复制文件；开态让位正文（正反两半，A-7）', async () => {
    const guardToggle = () =>
      page.locator('label', { hasText: '剪贴板让位正文选区' }).first().locator('input[type="checkbox"]')
    const toast = () => page.getByText(/已复制 1 个文件到剪贴板/)

    /** 在普通 div 上造一段非折叠选区，并自证前提成立 */
    const selectBodyText = async (): Promise<void> => {
      await page.evaluate(() => {
        document.getElementById('clip-guard-body')?.remove()
        const d = document.createElement('div')
        d.id = 'clip-guard-body'
        d.textContent = '守卫关态验收用的正文选区'
        d.style.cssText = 'position:fixed;left:0;top:0;z-index:99998'
        document.body.appendChild(d)
        const range = document.createRange()
        range.selectNodeContents(d)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
      const collapsed = await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)
      expect(collapsed, '没造出非折叠选区 = 本用例前提不成立（不是行为变了）').toBe(false)
    }

    /** 到文件页 → 全选 1 个文件 → 造选区 → Ctrl+C（返回 toast 是否出现） */
    const copyWithSelection = async (): Promise<boolean> => {
      await gotoRoute('/files/image/剪贴板测试集/主图')
      await expect(page.locator('.card', { hasText: 'clip' }).last()).toBeVisible({ timeout: 15000 })
      await page.getByRole('button', { name: '全选' }).click()
      await expect(page.getByText(/已选择 1 个文件/)).toBeVisible({ timeout: 5000 })
      await selectBodyText()
      await app.evaluate(({ clipboard }) => clipboard.writeText('__CLEAR__'))
      await page.keyboard.press('Control+c')
      await page.waitForTimeout(500)
      const n = await toast().count()
      await page.evaluate(() => document.getElementById('clip-guard-body')?.remove())
      return n > 0
    }

    try {
      // ① 关态：文件优先 → 出 toast
      await gotoRoute('/settings')
      // 先等镜像拉回：未就绪时开关是 disabled 的（默认值也是"开"，所以光 toBeChecked 不足以判定就绪）
      await expect(guardToggle()).toBeEnabled({ timeout: 15000 })
      await expect(guardToggle()).toBeChecked()
      await guardToggle().uncheck()
      expect(await copyWithSelection(), '关态下 Ctrl+C 仍让位正文 = 开关没接上').toBe(true)

      // ② 开态（默认）：同一串动作 → 让位正文，不出 toast
      await gotoRoute('/settings')
      await guardToggle().check()
      expect(await copyWithSelection(), '开态下仍复制文件 = 守卫失效（A1 根因 1 复发）').toBe(false)
    } finally {
      // 复位成默认开态并落盘，别把状态泄漏给共用同一个 app 的其余用例
      await gotoRoute('/settings').catch(() => {})
      await guardToggle().check().catch(() => {})
    }
  })
})
