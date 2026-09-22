import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
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
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('md-preview') } })
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
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
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

  test('关闭的笔记不许被 Ctrl+S 写空、也不许吞掉当前笔记的保存（v2.6 审查轮 1：陈旧 note.save 处理器）', async () => {
    // 修前形状（探针实测取证，2026-09-23）：Ctrl+S 处理器在 `initEditor` 的首个 await **之后**注册，
    // `onCleanup(offSave)` 拿到的 Owner 已是 null ⇒ Solid 静默丢弃注销函数 ⇒ 组件卸载后处理器仍留在
    // shortcuts 表里，而且**按注册序先于新笔记自己的处理器**被派发到（`shortcuts.ts` 首个 true 即止）：
    //   ① 陈旧处理器 `serialize()` 见 editor===null → 返回 ""（把"取不到内容"当成"内容为空"）
    //   ② `props.saveRelPath` 是父组件作用域的活 getter ⇒ 解引用到**当前**预览文件（B）的路径
    //   ③ 于是 **A 的陈旧处理器把 B 的文件原子替换成 0 字节**，并且吞掉 B 自己的 Ctrl+S
    // 探针读数（修前）：`handler fired; editorAlive=false … relPath="产品集/MD系列/文档/说明书/另一份.md"`
    // + `writeText result={"success":true} contentLen=0` ⇒ B 被清空。
    // 这条 e2e 钉两个后果：B 的内容/字节数必须原样在、A 也不许被碰；工作区里不许凭空多条目
    // （旧实现还会把工作区外文件的绝对路径当相对路径喂给 writeText，在工作区里造出镜像伪目录树）。
    const { wsDir, mdFile } = await setup('# A 的正文\n\nA 不许被写空')
    const mdFileB = path.join(path.dirname(mdFile), '另一份.md')
    await fsp.writeFile(mdFileB, Buffer.from('# B 的正文\n\nB 不许被写空'))
    /** 工作区内条目清单（递归 + 目录尾斜杠），用于"一个条目都不许多"的断言 */
    const treeOf = async (dir: string, base = dir): Promise<string[]> => {
      const out: string[] = []
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) out.push(path.relative(base, p) + '/', ...(await treeOf(p, base)))
        else out.push(path.relative(base, p))
      }
      return out.sort()
    }
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      // ① 打开 A 再关掉：这一步把「修前形状」的陈旧处理器留在 shortcuts 表里
      const editableA = await openEditor()
      await expect(editableA).toContainText('A 的正文', { timeout: 20000 })
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-note-editor]')).toHaveCount(0, { timeout: 15000 })
      // ② 打开 B、编辑、等防抖保存落盘（B 的内容先在盘上成立）
      await page.getByText('另一份.md').dblclick()
      const editableB = page.locator('[data-note-editor] [contenteditable="true"]').first()
      await expect(editableB).toBeVisible({ timeout: 20000 })
      await expect(editableB).toContainText('B 的正文', { timeout: 20000 })
      await editableB.click()
      await editableB.press('End')
      await page.keyboard.type('——B 的新增段落')
      await page.waitForTimeout(1500) // 防抖 500ms 串行保存窗口
      const aBytes = await fsp.readFile(mdFile)
      const bBytes = await fsp.readFile(mdFileB)
      expect(bBytes.toString('utf-8'), '前置：B 的新增段落必须已经落盘').toContain('B 的新增段落')
      const treeBefore = await treeOf(wsDir)
      // ③ 此刻按 Ctrl+S：修前这一步被 A 的陈旧处理器接管 → B 被写成 0 字节
      await page.keyboard.press('Control+s')
      await page.waitForTimeout(1500)
      const bAfter = await fsp.readFile(mdFileB)
      expect(bAfter.length, 'B 的文件不许被陈旧处理器清空（0 字节）').toBe(bBytes.length)
      expect(bAfter, 'B 的内容必须一字不差').toEqual(bBytes)
      expect(await fsp.readFile(mdFile), 'A 的文件同样一个字节都不许动').toEqual(aBytes)
      expect(await treeOf(wsDir), '工作区内不许凭空多出条目（旧实现的绝对路径回落会造镜像伪目录树）').toEqual(treeBefore)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
