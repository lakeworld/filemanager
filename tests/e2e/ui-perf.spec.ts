import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'route-first-render.baseline.json')

interface PerfBaseline {
  platform: string
  comparisonRatio: number
  routeMediansMs: Record<string, number>
}

/** 读取冻结基线；文件缺失或格式非法时返回 null（仅影响 25% 比较，不阻断 3000ms 灾难线） */
async function loadPerfBaseline(): Promise<PerfBaseline | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(BASELINE_PATH, 'utf8')) as PerfBaseline
    if (typeof raw.comparisonRatio !== 'number' || typeof raw.platform !== 'string') return null
    return raw
  } catch {
    return null
  }
}

/**
 * 渲染性能灾难回归探针（v2.5.1 D4 升级，v2.5.3 T0 收紧）：
 * - 懒加载路由首渲染耗时（performance.now 打点，路由专属 H1 ready，同机三次取中位数）
 * - 双层判定：3000ms 灾难线（任何机器必须过）；同机可比（os.platform 匹配）时
 *   三次中位数超过冻结基线的 125% 即失败，迫使在动作文档记录并解释回退。
 * - 冻结基线：tests/e2e/fixtures/route-first-render.baseline.json（v2.5.2/开发前同机三次中位数）。
 */
test.describe('渲染性能探针（v2.5.1 D4 / v2.5.3 T0）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-perf-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
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

  const ROUTES = [
    { path: '/', heading: '仪表盘' },
    { path: '/product-sets', heading: '产品集' },
    { path: '/images', heading: '图包库' },
    { path: '/certs', heading: '证书库' },
    { path: '/search', heading: '搜索' },
    { path: '/settings', heading: '设置' },
    { path: '/profile', heading: '我的' },
    { path: '/trash', heading: '回收站' },
    { path: '/clients', heading: '客户' },
    { path: '/invoices', heading: '发票管理' },
  ]

  test('懒加载路由首渲染 < 阈值（3000ms 灾难线 + 冻结基线 125% 回归门禁）', async () => {
    const medians: Record<string, number> = {}
    const baseline = await loadPerfBaseline()
    if (!baseline) {
      console.warn('[ui-perf] 冻结基线缺失或格式非法，跳过 25% 回归比较（保留 3000ms 灾难线）')
    } else if (baseline.platform !== os.platform()) {
      console.warn(`[ui-perf] 基线平台 ${baseline.platform} ≠ 本机 ${os.platform()}，跳过 25% 回归比较（保留 3000ms 灾难线）`)
    }

    for (const route of ROUTES) {
      const samples: number[] = []
      for (let sample = 0; sample < 3; sample += 1) {
        await page.goto(INDEX_URL)
        await page.waitForLoadState('domcontentloaded')
        const start = await page.evaluate(() => performance.now())
        await page.evaluate((url) => {
          window.history.pushState({}, '', url)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }, route.path)
        await expect(page.getByRole('heading', { name: route.heading, exact: true, level: 1 })).toBeVisible({ timeout: 10000 })
        const elapsed = await page.evaluate((started) => performance.now() - started, start)
        samples.push(elapsed)
        expect(elapsed, `route ${route.path} 第 ${sample + 1} 次首渲染 ${elapsed.toFixed(1)}ms`).toBeLessThan(3000)
      }

      samples.sort((left, right) => left - right)
      const median = samples[1]
      medians[route.path] = median
      console.log(`[ui-perf] ${route.path} samples=${samples.map((value) => value.toFixed(1)).join(',')}ms median=${median.toFixed(1)}ms`)
      expect(median, `route ${route.path} 三次中位数 ${median.toFixed(1)}ms`).toBeLessThan(3000)

      const routeBaseline = baseline?.routeMediansMs?.[route.path]
      if (baseline && baseline.platform === os.platform()) {
        if (typeof routeBaseline !== 'number') {
          console.warn(`[ui-perf] ${route.path} 冻结基线缺少该路由记录，跳过 25% 比较`)
          continue
        }
        const threshold = routeBaseline * baseline.comparisonRatio
        console.log(
          `[ui-perf] ${route.path} 基线=${routeBaseline.toFixed(1)}ms 125% 阈值=${threshold.toFixed(1)}ms median=${median.toFixed(1)}ms`,
        )
        expect(
          median,
          `route ${route.path} 中位数 ${median.toFixed(1)}ms 超过基线 ${routeBaseline.toFixed(1)}ms 的 125%（阈值 ${threshold.toFixed(1)}ms），需在动作文档记录并解释`,
        ).toBeLessThanOrEqual(threshold)
      }
    }

    await test.info().attach('route-first-render.json', {
      body: Buffer.from(JSON.stringify({ medians, baselineEligible: baseline?.platform === os.platform(), baseline }, null, 2)),
      contentType: 'application/json',
    })
  })
})
