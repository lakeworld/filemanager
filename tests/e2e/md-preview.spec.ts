import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 笔记编辑器 e2e（v2.5.7 A2，原 md-preview.spec 改写）：
 * - 双击 .md → 打开 NoteEditorModal（Crepe 所见即所得编辑器）并渲染正文
 * - 零写入底线：打开未编辑 → 文件字节/mtime 不变（核心断言）
 * - 编辑 → 防抖串行保存 → 文件内容更新
 * - `<img onerror>` 注入不执行（CSP 无；ProseMirror 不执行 raw HTML）
 * - >2MB → tooLarge 三态（引导用系统程序打开）
 * - 右键 .md 首项 label = 编辑笔记
 *
 * 注：Crepe 编辑器首次加载为懒加载 chunk（>=1 秒），断言超时放宽。
 */
test.describe('笔记编辑器（v2.5.7 A2）', () => {
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

  /** 建工作区 + 产品集 + 文档/说明书/<file>.md，返回 { wsDir, mdFile } */
  const setup = async (mdContent: string, fileName = '说明.md'): Promise<{ wsDir: string; mdFile: string }> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-note-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: 'MD系列' }))
    const dir = path.join(wsDir, '产品集', 'MD系列', '文档', '说明书')
    await fsp.mkdir(dir, { recursive: true })
    const mdFile = path.join(dir, fileName)
    await fsp.writeFile(mdFile, Buffer.from(mdContent))
    return { wsDir, mdFile }
  }

  /** 等待编辑器就绪（Crepe 懒加载 chunk + create()） */
  const openEditor = async () => {
    await page.getByText('说明.md').dblclick()
    await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
    // Crepe 编辑器内容区（ProseMirror contenteditable）——就绪后渲染正文
    const editable = page.locator('[data-note-editor] [contenteditable="true"]').first()
    await expect(editable).toBeVisible({ timeout: 20000 })
    return editable
  }

  test('双击 .md → Crepe 编辑器渲染正文（懒加载可交互）', async () => {
    const md = '# 产品说明\n\n## 使用步骤\n\n- 第一步：安装\n- 第二步：配置\n\n> 引用一段话'
    const { wsDir } = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      const editable = await openEditor()
      await expect(editable).toContainText('产品说明', { timeout: 20000 })
      await expect(editable).toContainText('使用步骤')
      await expect(editable).toContainText('第一步')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('零写入底线：打开未编辑 → 文件字节/mtime 不变', async () => {
    const md = '# 零写入基线\n\n正文段落不变'
    const { wsDir, mdFile } = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      // 记录打开前字节 + mtime
      const before = await fsp.stat(mdFile)
      const beforeBytes = before.size
      const beforeMtime = before.mtimeMs
      const editable = await openEditor()
      await expect(editable).toContainText('零写入基线', { timeout: 20000 })
      // 等待足够长的防抖窗口（未编辑 → 不得触发任何写盘）
      await page.waitForTimeout(2500)
      const after = await fsp.stat(mdFile)
      expect(after.size).toBe(beforeBytes)
      expect(after.mtimeMs).toBe(beforeMtime)
      // 关闭弹窗
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1500)
      const afterClose = await fsp.stat(mdFile)
      expect(afterClose.size).toBe(beforeBytes)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('编辑 → 防抖串行保存 → 磁盘内容更新', async () => {
    const md = '# 初始标题\n\n初始正文'
    const { wsDir, mdFile } = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      const editable = await openEditor()
      await expect(editable).toContainText('初始标题', { timeout: 20000 })
      // 在正文末尾追加输入
      await editable.click()
      await editable.press('End')
      await page.keyboard.type('——新增段落内容')
      await page.waitForTimeout(2000) // 防抖 500ms 串行保存窗口
      const content = await fsp.readFile(mdFile, 'utf-8')
      expect(content).toContain('新增段落内容')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('<img onerror> 注入不执行（ProseMirror 不执行 raw HTML）', async () => {
    const md = '# 注入测试\n\n<img src="x" onerror="window.__pwned = true">'
    const { wsDir } = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      const editable = await openEditor()
      await expect(editable).toContainText('注入测试', { timeout: 20000 })
      await page.waitForTimeout(1000)
      const pwned = await page.evaluate(() => (window as any).__pwned === true)
      expect(pwned).toBe(false)
      // 编辑器 DOM 不得执行注入 handler——即使 Crepe 渲染了 img 元素，onerror 属性也不会被保留执行
      const injectedImgs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img")).filter((i) => i.getAttribute("onerror")).length,
      )
      expect(injectedImgs).toBe(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('>2MB → tooLarge 引导「用系统程序打开」（不加载编辑器）', async () => {
    const big = '# 大文件\n' + 'x'.repeat(2 * 1024 * 1024)
    const { wsDir } = await setup(big)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('说明.md').dblclick()
      await expect(page.getByText('文件过大（超过 2MB），无法在线编辑')).toBeVisible({ timeout: 20000 })
      await expect(page.getByRole('button', { name: /用系统程序打开/ }).first()).toBeVisible()
      // 未加载编辑器
      await expect(page.locator('[data-note-editor] [contenteditable="true"]')).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('右键 .md 首项 label = 编辑笔记', async () => {
    const { wsDir } = await setup('# 右键\n\n正文')
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('说明.md').click({ button: 'right' })
      await expect(page.getByText('编辑笔记')).toBeVisible({ timeout: 10000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
