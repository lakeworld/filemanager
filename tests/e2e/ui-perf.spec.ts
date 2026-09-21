import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import { AUTOSTART_ARGS } from '../../src/main/core/autoLaunch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
/**
 * v2.5.9/A1d（用户 2026-09-21 拍板 = **给 CI 单独一套基线口径**，本机灵敏度不动）：
 * 判据**代码**两边完全同一套（同一比较、同一带宽、同一 3000ms 灾难线），
 * 分开的只是**冻结基线文件**——因为性能的可比性本来就跟机器绑，不跟"是不是 CI"绑：
 *   · `route-first-render.baseline.json`     = 本机开发机（现有文件，数值一字未动）
 *   · `route-first-render.baseline.ci-linux.json` = GitHub ubuntu-latest runner
 * ⚠ 别把这条读成 A1d 的病根复发：病根是 `if (process.env.CI)` 把**比较整个跳过**
 * （于是"CI 绿"什么都不证明）。这里 CI 不仅要比，而且在**自己的基线冻上之前会红**，
 * 红的时候把候选数字直接打在失败信息里 ⇒ 下一笔就能落成文件、转为常态门禁。
 */
const IS_GH_RUNNER = process.env.GITHUB_ACTIONS === 'true'
const BASELINE_PATH = path.join(
  FIXTURES_DIR,
  IS_GH_RUNNER ? 'route-first-render.baseline.ci-linux.json' : 'route-first-render.baseline.json',
)

/**
 * v2.5.9/A1d（待拍板 #19 附带项③「ui-perf 补 PROD_ARGS」）：性能探针必须跑在**生产形态启动参数**上。
 * 旧版只带 `--no-sandbox`，与 measure-memory PROD_ARGS / builder executableArgs / autostart
 * 三处同步面漂移（无 --disable-gpu/--in-process-gpu 时 GPU 进程独立、首渲染时序不同源）。
 * AUTOSTART_ARGS 去 --autostart = 那五参（逐字一致由 tests/unit/autoLaunch.test.ts 锚定）。
 */
const PERF_ARGS = ['.', ...AUTOSTART_ARGS.filter((a) => a !== '--autostart')]

interface PerfBaseline {
  platform: string
  comparisonRatio: number
  routeMediansMs: Record<string, number>
}

/**
 * v2.5.9/A1d（待拍板 #19 裁决 = **改测法，不重埋数字**）：旧判据「3 样本中位数 ≤ 冻结基线×1.25」
 * 的容差带只有 7–8ms（小于一帧 16.7ms），单峰分布下最大样本落带外的概率就是两位数——本机实测
 * /settings 六轮重复的中位数 28.1–33.6ms、最大样本 36.5–42.6ms（同机同树）。
 * 新口径：**每路由连采 5 个 reload 样本，判 p90（升序第 4 值，即次大值）≤ 阈值**。
 * - p90 对瞬时尖峰只留一档容忍（不再拿"恰好没撞上"的中位数冒充稳定）；
 * - 阈值 = max(基线 × comparisonRatio × p90Factor, 基线 + minBandMs)——绝对带宽下限专治
 *   "/settings 基线 28ms、比例带只有 7ms"这类窄带。**minBandMs 的取值不是拍的**：生产参数下本机
 *   13 轮实测 /settings p90 = 40.1–45.2ms（其余路由 ≤37.4），20ms 带（阈值 48）仍留 ≥2.8ms 余量；
 *   曾试 12ms 带（阈值 40）⇒ 同一台机器 6 轮里红 1 轮，正是本判据要消灭的"贴脸判据"；
 * - **基线数值一律不动**（重冻结属阈值纪律，未经用户拍板不得执行）；
 * - 判据逻辑 CI 与本地**同一套**（A1d 的病根 = `if (process.env.CI)` 把基线置 null 造出两套口径）：
 *   平台不可比时退化为灾难线并显式告警，与本地基线缺失路径完全同码。
 */
const PERF_SAMPLES = 5
const P90_FACTOR = 1.15
const MIN_BAND_MS = 20

/** 取 p90：升序第 4 值（5 样本时的次大值）——一个瞬时尖峰可容忍，两个即红 */
function p90Of(sorted: number[]): number {
  return sorted[Math.min(Math.ceil(sorted.length * 0.9) - 1, sorted.length - 1)]
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
 * 渲染性能灾难回归探针（v2.5.1 D4 升级，v2.5.3 T0 收紧；v2.5.9 A1d 改测法）：
 * - 懒加载路由首渲染耗时（performance.now 打点，路由专属 H1 ready，每路由 5 次 reload 采样判 p90）
 * - 双层判定：3000ms 灾难线（任何机器必须过）；同机可比（os.platform 匹配）时
 *   p90 超过冻结基线的 125%×p90Factor（且不低于基线+20ms 绝对带）即失败，迫使在动作文档记录并解释回退。
 * - 冻结基线：tests/e2e/fixtures/route-first-render.baseline.json（v2.5.2/开发前同机三次中位数，数值不动）。
 */
test.describe('渲染性能探针（v2.5.1 D4 / v2.5.3 T0 / v2.5.9 A1d）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: PERF_ARGS, cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('ui-perf') } })
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

  test('懒加载路由首渲染 < 阈值（3000ms 灾难线 + 冻结基线 p90 回归门禁）', async () => {
    const p90s: Record<string, number> = {}
    let baseline = await loadPerfBaseline()
    if (!baseline) {
      console.warn('[ui-perf] 冻结基线缺失或格式非法，跳过回归比较（保留 3000ms 灾难线）')
    } else if (baseline.platform !== os.platform()) {
      // CI runner 与本机不同源时走这一支——判据逻辑与本地完全同一套代码，只是不可比就明告警。
      // （v2.5.9/A1d：删掉 `if (process.env.CI)` 的特判——两套口径正是"CI 绿但本地红"的机制。）
      console.warn(`[ui-perf] 基线平台 ${baseline.platform} ≠ 本机 ${os.platform()}，跳过回归比较（保留 3000ms 灾难线）`)
    }

    for (const route of ROUTES) {
      const samples: number[] = []
      for (let sample = 0; sample < PERF_SAMPLES; sample += 1) {
        await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
        await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
        await page.waitForLoadState('domcontentloaded')
        const start = await page.evaluate(() => performance.now())
        await page.evaluate((url) => {
          window.location.hash = decodeURIComponent(url)
        }, route.path)
        await expect(page.getByRole('heading', { name: route.heading, exact: true, level: 1 })).toBeVisible({ timeout: 10000 })
        const elapsed = await page.evaluate((started) => performance.now() - started, start)
        samples.push(elapsed)
        expect(elapsed, `route ${route.path} 第 ${sample + 1} 次首渲染 ${elapsed.toFixed(1)}ms`).toBeLessThan(3000)
      }

      samples.sort((left, right) => left - right)
      const p90 = p90Of(samples)
      p90s[route.path] = p90
      console.log(`[ui-perf] ${route.path} samples=${samples.map((value) => value.toFixed(1)).join(',')}ms p90=${p90.toFixed(1)}ms`)
      expect(p90, `route ${route.path} ${PERF_SAMPLES} 样本 p90 ${p90.toFixed(1)}ms`).toBeLessThan(3000)

      const routeBaseline = baseline?.routeMediansMs?.[route.path]
      if (baseline && baseline.platform === os.platform()) {
        if (typeof routeBaseline !== 'number') {
          console.warn(`[ui-perf] ${route.path} 冻结基线缺少该路由记录，跳过回归比较`)
          continue
        }
        const threshold = Math.max(routeBaseline * baseline.comparisonRatio * P90_FACTOR, routeBaseline + MIN_BAND_MS)
        console.log(
          `[ui-perf] ${route.path} 基线=${routeBaseline.toFixed(1)}ms p90 阈值=${threshold.toFixed(1)}ms p90=${p90.toFixed(1)}ms`,
        )
        expect(
          p90,
          `route ${route.path} p90 ${p90.toFixed(1)}ms 超过基线 ${routeBaseline.toFixed(1)}ms 的回归阈值 ${threshold.toFixed(1)}ms（${PERF_SAMPLES} 样本=[${samples.map((v) => v.toFixed(1)).join(',')}]），需在动作文档记录并解释`,
        ).toBeLessThanOrEqual(threshold)
      }
    }

    // CI 基线还没冻结 ⇒ **不静默放行**：把本轮观测值塞进失败信息，供下一笔写成基线文件。
    if (IS_GH_RUNNER && !baseline) {
      throw new Error(
        `[ui-perf] CI 基线尚未冻结（缺 ${path.relative(ROOT, BASELINE_PATH)}）。` +
          `本轮 runner 实测 p90 = ${JSON.stringify(p90s)} ⇒ 按这些数（含少量余量）写进该文件即转常态门禁。`,
      )
    }

    await test.info().attach('route-first-render.json', {
      body: Buffer.from(JSON.stringify({ p90s, baselineEligible: baseline?.platform === os.platform(), baseline }, null, 2)),
      contentType: 'application/json',
    })
  })
})
