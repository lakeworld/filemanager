import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * Markdown 预览 e2e（v2.5.1 F4）：
 * - 双击 .md → 渲染标题/列表/代码块（marked 懒加载 + .md-prose）
 * - `<script>` 注入不执行（configureMarked 转义为可见文本）
 * - 2MB 上限 → 引导「用系统程序打开」
 * - 相对路径图片 → img src 为 qihebox://（D22）
 */
test.describe('Markdown 预览（v2.5.1 F4）', () => {
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

  const setup = async (mdContent: string): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-md-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: 'MD系列' }))
    const dir = path.join(wsDir, '产品集', 'MD系列', '文档', '说明书')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '说明.md'), Buffer.from(mdContent))
    return wsDir
  }

  test('双击 .md → 渲染标题/列表/代码块', async () => {
    const md = [
      '# 产品说明',
      '',
      '## 使用步骤',
      '',
      '- 第一步：安装',
      '- 第二步：配置',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '> 引用一段话',
    ].join('\n')
    const wsDir = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await expect(page.getByText('说明.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('说明.md').dblclick()

      // 渲染结果（.md-prose 内）
      const prose = page.locator('.md-prose')
      await expect(prose).toBeVisible({ timeout: 15000 })
      await expect(prose.locator('h1')).toHaveText('产品说明')
      await expect(prose.locator('h2')).toHaveText('使用步骤')
      await expect(prose.locator('li')).toHaveCount(2)
      await expect(prose.locator('pre code')).toContainText('const x = 1')
      await expect(prose.locator('blockquote')).toContainText('引用一段话')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('<script> 注入不执行：转义为可见文本', async () => {
    const md = '# 标题\n\n<script>window.__pwned = true</script>\n\n正文内容'
    const wsDir = await setup(md)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await page.getByText('说明.md').dblclick()
      const prose = page.locator('.md-prose')
      await expect(prose).toBeVisible({ timeout: 15000 })
      // 无脚本执行
      const pwned = await page.evaluate(() => (window as any).__pwned === true)
      expect(pwned).toBe(false)
      // 注入源文本以转义形式可见（&lt;script&gt;）
      await expect(prose).toContainText('<script>window.__pwned = true</script>')
      // 页面无真实 script 节点（除应用自身）
      const scripts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script')).filter((s) => s.textContent?.includes('__pwned')).length,
      )
      expect(scripts).toBe(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('相对路径图片 → img src 为 qihebox://', async () => {
    const md = '# 带图说明\n\n![示例](img/demo.png)'
    const wsDir = await setup(md)
    try {
      // 放一张图（真实 1x1 PNG 字节；img 子目录先建）
      const dir = path.join(wsDir, '产品集', 'MD系列', '文档', '说明书')
      await fsp.mkdir(path.join(dir, 'img'), { recursive: true })
      await fsp.writeFile(
        path.join(dir, 'img', 'demo.png'),
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      )
      await navigateTo('/files/doc/MD系列/说明书')
      await page.getByText('说明.md').dblclick()
      const img = page.locator('.md-prose img')
      await expect(img).toBeVisible({ timeout: 15000 })
      const src = await img.getAttribute('src')
      expect(src).toMatch(/^qihebox:\/\/file\//)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('2MB 上限 → 引导「用系统程序打开」', async () => {
    const big = '# 大文件\n' + 'x'.repeat(2 * 1024 * 1024)
    const wsDir = await setup(big)
    try {
      await navigateTo('/files/doc/MD系列/说明书')
      await page.getByText('说明.md').dblclick()
      await expect(page.getByText('文档较大（超过 2MB），内嵌预览已跳过')).toBeVisible({ timeout: 15000 })
      // exact：右上角「🗂 用系统程序打开」按钮不参与匹配
      await expect(page.getByRole('button', { name: '用系统程序打开', exact: true })).toBeVisible()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
