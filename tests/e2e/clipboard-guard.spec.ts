import { test, expect, _electron as electron } from '@playwright/test'
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
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clip-guard-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    // 产品集 + 通过应用导入一个文件（走导入流程才会进文件索引；直接 fsp 写盘不更新索引）
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '剪贴板测试集' }))
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clip-src-'))
    await fsp.writeFile(path.join(srcDir, 'clip.png'), 'PNG-TEST')
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
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
    // 导入是异步完成（import:complete 事件）——轮询索引直到文件可见（慢机加宽到 80×300ms=24s）
    let imported = false
    for (let i = 0; i < 80; i++) {
      const list = await page.evaluate(async () =>
        ((await (window as any).qihebox.files.list({
          product_set: '剪贴板测试集',
          file_type: 'image',
          sub_folder: '主图',
          scope: 'productSet',
        }))?.data ?? []) as { name: string }[],
      )
      if (list.some((f) => f.name.includes('clip'))) {
        imported = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(imported, '导入应进入文件索引（beforeAll 前提）').toBe(true)
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

  /** 回初始入口再导航（干净挂载） */
  const gotoRoute = async (route: string) => {
    await page.goto('file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
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
    const logsDir = path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'logs')
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
})
