import { test, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const OUT_DIR = process.env.QIHE_SHOT_DIR || path.join(os.tmpdir(), 'v257-shots')

/**
 * v2.5.7 发布轮渲染走查探针（诊断用，**不进默认套件**：playwright.config.ts testIgnore 已排除）。
 * 用途：本版新增大面积渲染（Crepe 编辑器 / 标签域分组 / 统一表单控件 / 侧边栏新入口），
 * 本仓又没有任何长期视觉基线（快照跨机抖动会造永久 flaky），故发布轮做一次
 * 「多视口 × 多缩放 × 多状态」截图留档，交人工目视裁决（3 视口 × 2 缩放 × 5 面）。
 *
 * 跑法：QIHE_SHOT_DIR=/tmp/v257-shots npx playwright test tests/e2e/probe-render-shots.spec.ts --reporter=line --ignore-project-args
 *      （或直接 npx playwright test tests/e2e/probe-render-shots.spec.ts --grep-invert __none__）
 */
const VIEWPORTS: Array<[number, number]> = [[1280, 720], [1440, 900], [1920, 1080]]
const ZOOMS = [1, 1.5]
const ROUTES: Array<[string, string]> = [
  ['notes', '/notes'],
  ['settings-tags', '/settings'],
  ['client-detail', '/clients/走查客户'],
  ['invoices', '/invoices'],
  ['product-set', '/product-sets/走查系列'],
]

test.describe('发布轮渲染走查截图（probe，不入默认套件）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    await fsp.mkdir(OUT_DIR, { recursive: true })
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-shots-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      await (window as any).qihebox.productSets.create({ name: '走查系列' })
      await (window as any).qihebox.clients.create({ name: '走查客户' })
      // 拥挤标签（走查行高/换行/溢出）
      for (let i = 1; i <= 20; i++) await (window as any).qihebox.tags.create(`标签${i}号名称偏长`, `hsl(${i * 17},60%,50%)`, null, i % 3 === 0 ? 'invoice' : undefined)
    })
    // 笔记（含超长中文文件名 + 富结构正文）+ 产品集文档区笔记
    const longName = '这是一份名字非常长的笔记用于走查截断与换行表现-产品修订记录-2026年08月31日.md'
    const rich = ['# 走查标题', '', '正文一段，含**加粗**、`行内码`与[链接](https://example.com)。', '', '- 列表项一', '- 列表项二', '', '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', ''].join('\n')
    for (const dir of [
      path.join(wsDir, '产品集', '走查系列', '文档', '笔记'),
      path.join(wsDir, '客户', '走查客户', '笔记'),
    ]) {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, longName), rich)
      await fsp.writeFile(path.join(dir, '空笔记.md'), '')
    }
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
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

  /**
   * 导航后 zoom 会被重置，故每次 goto 后必须重放。
   * 注意：Playwright setViewportSize 走 CDP 页面度量覆写，会使 webContents.setZoomFactor 不生效
   * （实测 @1/@1.5 成图 md5 全同）→ 改用 CSS zoom（与用户缩放同为 reflow 语义，不受覆写影响）。
   */
  const applyZoom = async (factor: number): Promise<void> => {
    await page.evaluate((f) => {
      document.documentElement.style.setProperty('zoom', String(f))
    }, factor)
  }

  const goto = async (url: string, zoom = 1): Promise<void> => {
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await applyZoom(zoom)
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, url)
    await page.waitForTimeout(700)
  }

  const shot = async (name: string): Promise<void> => {
    // 字体加载偶尔不落定（web font 拉取慢）→ 单张截图限时 12s；失败不中断（走查图以多为胜，留档待目视）
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), timeout: 12000 })
    } catch (err) {
      console.log(`[shots] ⚠ ${name} 截图超时/失败：${err instanceof Error ? err.message.split('\n')[0] : String(err)}（跳过）`)
    }
  }

  test('3 视口 × 2 缩放 × 5 面 + 编辑器态 留档', async () => {
    for (const [w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h })
      for (const z of ZOOMS) {
        await app.evaluate(({ BrowserWindow }, factor) => {
          for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(factor)
        }, z).catch(() => {})
        await page.waitForTimeout(250)
        for (const [key, route] of ROUTES) {
          await goto(route, z)
          await shot(`${w}x${h}@${z}-${key}`)
        }
        // 编辑器态（本版最大新面）：深链进 Crepe
        await goto(`/files/doc/${encodeURIComponent('走查系列')}/笔记?note=${encodeURIComponent('空笔记.md')}`, z)
        const editor = page.locator('.ProseMirror').first()
        if (await editor.isVisible().catch(() => false)) {
          // 不用 click：某些视口下编辑器父容器（.h-full.w-full）会拦截指针（layout overlay 正常现象）
          await editor.focus()
          await page.keyboard.type('走查正文第一行')
          await page.keyboard.press('Enter')
          await page.keyboard.type('## 小节标题')
          await page.waitForTimeout(900)
        }
        await shot(`${w}x${h}@${z}-editor`)
        // 懒加载 CSS 落地核查：Crepe 样式是独立分片（prosemirror/list-item/toolbar/style…），
        // 只有 JS chunk 被动态 import 时才注入 <link>；DOM 结构对但样式没进 = 静默无样式渲染缺陷。
        const cssProbe = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.getAttribute('href') || '')
          const pm = document.querySelector('.ProseMirror') as HTMLElement | null
          const cs = pm ? getComputedStyle(pm) : null
          const tb = document.querySelector('.milkdown-toolbar') as HTMLElement | null
          return {
            crepeChunks: links.filter((h) => /prosemirror|list-item|toolbar|table|cursor|block-edit|link-tooltip|style-/.test(h)),
            allLinks: links.length,
            pmPadding: cs?.padding ?? '(无 .ProseMirror)',
            pmOutline: cs?.outlineStyle ?? '-',
            toolbarPos: tb ? getComputedStyle(tb).position : '(无工具条)',
          }
        })
        console.log(
          `[shots] ${w}x${h}@${z} Crepe 样式：分片 ${cssProbe.crepeChunks.length}/${cssProbe.allLinks} 个 link · .ProseMirror padding=${cssProbe.pmPadding} outline=${cssProbe.pmOutline} · 工具条 position=${cssProbe.toolbarPos}`,
        )
      }
    }
    console.log(`[shots] 已写 ${OUT_DIR}（${VIEWPORTS.length * ZOOMS.length * (ROUTES.length + 1)} 张）`)
  })
})
