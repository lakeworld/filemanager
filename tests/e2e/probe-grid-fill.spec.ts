/**
 * probe-grid-fill.spec.ts —— 文件网格/图包库「多久真的出图」量化探针（2026-08-31 发布轮 D-12 取证）
 *
 * 起因：soak 万文件夹具（15000 条目）下，步骤 1 的 `.vscroll img[thumb]` 15s 等待经常整轮超时
 *   （一次运行 20/20 轮 imgs=0，另一次前 9 轮 0、第 10 轮起 18）——即「网格空转」可能是真实用户
 *   在大工作区下看到的**空白图包页**。需要在「贴近真实使用的规模」上量一次，判断这是极端夹具
 *   专属还是现实规模也有。
 *
 * 做法：同一夹具规模阶梯（600 / 3000 / 9000 条目）各自起一次应用，进 /files/image/<集>/主图 与
 *   /images 两面，测「首次出现 ≥1 张缩略图」与「出现 ≥20 张」的耗时，并核最终是否到齐。
 *   只测量与打印，不设耗时硬阈值（判读归人），但「最终一张都没有」按缺陷红。
 *
 * 运行：npx playwright test --config=playwright.probe.config.ts probe-grid-fill
 * 输出：tests/e2e/probe-results/grid-fill-<ts>.json
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const SIZES = [600, 3000, 9000]

interface Row {
  entries: number
  route: string
  firstImgMs: number
  img20Ms: number
  finalImgs: number
  finalCards: number
}

test.describe('网格出图耗时阶梯（probe，不入默认套件）', () => {
  for (const total of SIZES) {
    test(`${total} 条目工作区：网格与图包库首次出图耗时`, async () => {
      test.setTimeout(9 * 60 * 1000)
      const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), `qihebox-grid-${total}-`))
      await buildFixture(wsDir, total)
      const app: ElectronApplication = await electron.launch({
        args: ['.', '--no-sandbox'],
        cwd: ROOT,
        env: { ...process.env, QIHEBOX_E2E: '1' },
      })
      const rows: Row[] = []
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 30000 })
        await page.evaluate(async (dir) => {
          const r = await (window as any).qihebox.workspace.open(dir)
          if (!r?.success) throw new Error('打开工作区失败: ' + JSON.stringify(r))
        }, wsDir)
        await page.goto(INDEX_URL)
        await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 30000 })
        const sets = Math.floor(total / 150)
        for (const route of [`/files/image/集01/主图`, '/images']) {
          await page.evaluate((u) => {
            window.history.pushState({}, '', u)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }, route)
          const t0 = Date.now()
          let firstImgMs = -1
          let img20Ms = -1
          let finalImgs = 0
          let finalCards = 0
          // 最多观察 6 分钟：每 2s 采一次
          for (let i = 0; i < 180; i++) {
            const s = await page.evaluate(() => ({
              imgs: document.querySelectorAll('img[src^="qihebox://thumb/"]').length,
              cards: document.querySelectorAll('main .card').length,
            }))
            finalImgs = s.imgs
            finalCards = s.cards
            if (firstImgMs < 0 && s.imgs >= 1) firstImgMs = Date.now() - t0
            if (img20Ms < 0 && s.imgs >= 20) img20Ms = Date.now() - t0
            if (firstImgMs >= 0 && img20Ms >= 0) break
            await page.waitForTimeout(2000)
          }
          rows.push({ entries: total, route: route.replace(`集01`, `集01(${sets}集)`), firstImgMs, img20Ms, finalImgs, finalCards })
        }
        for (const r of rows) {
          console.log(
            `[grid] ${String(r.entries).padStart(5)} 条目 ${r.route.padEnd(22)} 首图=${fmt(r.firstImgMs)} 20图=${fmt(r.img20Ms)} 末值 imgs=${r.finalImgs} cards=${r.finalCards}`,
          )
        }
        const dead = rows.filter((r) => r.finalImgs === 0)
        expect(dead, `以下面在 6 分钟内一张缩略图都没出：${JSON.stringify(dead)}`).toHaveLength(0)
      } finally {
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
        await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      }
      const outDir = path.join(ROOT, 'tests', 'e2e', 'probe-results')
      await fsp.mkdir(outDir, { recursive: true })
      await fsp.writeFile(path.join(outDir, `grid-fill-${total}-${Date.now()}.json`), JSON.stringify(rows, null, 2))
    })
  }
})

function fmt(ms: number): string {
  return ms < 0 ? '未达成' : `${(ms / 1000).toFixed(1)}s`
}

/** 造 total 个图片条目：每集 150 张真 JPEG（硬链复用内容），集数 = total/150 */
async function buildFixture(ws: string, total: number): Promise<void> {
  const sharp = (await import('sharp')).default
  const src = path.join(ws, '.s.jpg')
  await fsp.writeFile(
    src,
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 120, b: 80 } } }).jpeg().toBuffer(),
  )
  const sets = Math.max(1, Math.floor(total / 150))
  for (let s = 1; s <= sets; s++) {
    const d = path.join(ws, '产品集', `集${String(s).padStart(2, '0')}`, '图包', '主图')
    await fsp.mkdir(d, { recursive: true })
    for (let i = 1; i <= 150; i++) {
      const dst = path.join(d, `图片${s}-${i}.jpg`)
      try {
        await fsp.link(src, dst)
      } catch {
        await fsp.copyFile(src, dst)
      }
    }
  }
  await fsp.rm(src, { force: true })
}
