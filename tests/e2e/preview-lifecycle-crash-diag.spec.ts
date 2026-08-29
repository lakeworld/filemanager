import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 崩溃取证管道（v2.5.7 线程B 阶段1，诊断专用）：**不入默认套件**（playwright.config.ts testIgnore），
 * 不设重试。复刻 preview-lifecycle.spec.ts:276 前置序列——共享 app 实例 + 连续 ROUNDS 轮
 * setupImageWorkspace + navigateTo('/images') 整页重载，每轮记录：
 *   1. 渲染进程内存曲线（app.getAppMetrics() workingSetSize / 空闲后 RSS 对比）
 *   2. render-process-gone 崩溃 reason / exitCode（主进程 log + --enable-logging 输出，
 *      采集 [e2e-crash-diag] 行；用例尾部 dump 到 crash-diag-results/）
 * 目的：拿到 276 首跑失败的崩溃 reason 分布（phase 1 输出，供 phase 2/3 根因裁决）。
 * 验收后整文件清理（PLAN-v2.5.7-preview-lifecycle §三）。
 */

/** 主进程日志文件名 = 本地日期（logger.ts dateStr 语义，同 wake-recovery.spec.ts 注释） */
function localLogDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const RESULTS_DIR = path.join(ROOT, 'crash-diag-results')
/** 复刻轮数（可覆盖：CRASH_DIAG_ROUNDS=6）——276 前置对应约 4~5 次整页重载后崩溃 */
const ROUNDS = Number(process.env.CRASH_DIAG_ROUNDS) || 5

/** 渲染进程关键内存快照（主进程侧取值，页面崩溃后仍可从 app 侧读取——本采集不依赖页面） */
async function rendererMemorySnapshot(app: ElectronApplication): Promise<{ wsKB: number; usedHeapMB: number } | null> {
  try {
    return await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed() || win.webContents.isCrashed()) return null
      const pid = win.webContents.getOSProcessId()
      // Electron 31 AppMetric.type 类型不含 'Renderer' 字面量（编译期收窄），运行期为字符串——类型断言取证
      const metric = (electronApp.getAppMetrics?.() ?? []).find(
        (m) => (m.type as string) === 'Renderer' && m.pid === pid,
      )
      const wsKB = metric?.memory?.workingSetSize ?? -1
      // 轻量 heap 探针（尽力而为：崩溃中/加载中不阻塞主进程）——失败返回 -1
      let usedHeapMB = -1
      try {
        const wc = win.webContents as unknown as { getHeapStatistics?: () => { usedHeapSize: number } }
        const mem = wc.getHeapStatistics?.()
        if (mem) usedHeapMB = Math.round(mem.usedHeapSize / 1024 / 1024)
      } catch { /* 不阻断 */ }
      return { wsKB, usedHeapMB }
    })
  } catch {
    return null
  }
}

test.describe('preview-lifecycle 崩溃取证（诊断专用，不入默认套件）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox', '--enable-logging'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
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

  /** 建图包工作区并导入一张小图（对齐 preview-lifecycle setupImageWorkspace 非 big 路径） */
  const setupImageWorkspace = async (psName: string): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-crashdiag-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), psName)

    const sharp = (await import('sharp')).default
    const pngPath = path.join(wsDir, '取证图.png')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 160, b: 200 } } })
      .png()
      .toFile(pngPath)
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-crashdiag-src-'))
    const srcFile = path.join(srcDir, path.basename(pngPath))
    await fsp.copyFile(pngPath, srcFile)
    await page.evaluate(
      async (args) => {
        const { src, ps } = args as { src: string; ps: string }
        return (window as any).qihebox.files.import({
          source_paths: [src],
          target_product_set: ps,
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        })
      },
      { src: srcFile, ps: psName },
    )
    await fsp.rm(srcDir, { recursive: true, force: true })
    return wsDir
  }

  /** 对齐 276 的 waitImageCard：轮询列表出现 → 整页重载 → 图包库标题 → 卡片可见 */
  const waitImageCard = async (psName: string): Promise<void> => {
    await page.waitForFunction(
      async (psName) => {
        const r = await (window as any).qihebox.files.list({
          product_set: psName,
          file_type: 'image',
          media_type: 'image',
          sub_folder: '主图',
        })
        return !!(r.success && r.data && r.data.length > 0)
      },
      psName,
      { timeout: 45000 },
    )
    await navigateTo('/images')
    await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
    let cardVisible = false
    for (let attempt = 0; attempt < 3 && !cardVisible; attempt += 1) {
      try {
        await page.locator('.card', { hasText: psName }).first().waitFor({ timeout: 30000 })
        cardVisible = true
      } catch (error) {
        if (attempt < 2) {
          await navigateTo('/images')
          await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
        } else {
          throw error
        }
      }
    }
  }

  test('复刻 276 前置序列：共享 app + 连续整页重载，采集崩溃 reason/内存曲线', async () => {
    const rounds: Array<Record<string, unknown>> = []
    let crashReason: string | null = null
    let crashRound = 0
    let logTail = ''

    for (let i = 1; i <= ROUNDS; i += 1) {
      const psName = `取证集T${i}`
      const memBefore = await rendererMemorySnapshot(app)
      let wsDir: string | null = null
      let hit = false
      try {
        wsDir = await setupImageWorkspace(psName)
        await navigateTo('/images')
        await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
        await waitImageCard(psName)
        const memAfter = await rendererMemorySnapshot(app)
        rounds.push({
          round: i,
          ok: true,
          wsRSSBeforeKB: memBefore?.wsKB ?? null,
          wsRSSAfterKB: memAfter?.wsKB ?? null,
          heapUsedMB: memAfter?.usedHeapMB ?? null,
        })
        hit = true
      } catch (error) {
        // 渲染进程死亡（Target closed / page crashed）或断言超时——记录该轮崩溃，停止后续轮
        crashReason = error instanceof Error ? error.message : String(error)
        crashRound = i
        rounds.push({
          round: i,
          ok: false,
          wsRSSBeforeKB: memBefore?.wsKB ?? null,
          error: crashReason.slice(0, 300),
        })
        break
      } finally {
        if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      }
      // 每轮完成打印（list reporter 顺带可见），供即时观察
      console.log(`[crash-diag] round=${i} ok=${hit}`)
    }

    // 主进程日志采集崩溃 reason（--enable-logging + FileLogger 双通道）；
    // 通过 app.evaluate 拿真实 logs 目录（崩溃后主进程可仍在运行，app.evaluate 走主进程上下文）
    try {
      const logsDir = await app.evaluate(({ app: a }) => a.getPath('logs'))
      const logPath = path.join(logsDir, `main-${localLogDate()}.log`)
      logTail = await fsp.readFile(logPath, 'utf8')
    } catch {
      // 主进程日志不可读时依赖 e2e 侧的捕获
    }
    const diagLines = logTail
      .split('\n')
      .filter((l) => l.includes('[e2e-crash-diag]') || l.includes('renderer gone:'))
      .slice(-20)

    // 汇总落盘（供跨轮/跨会话聚合崩溃 reason 分布）
    await fsp.mkdir(RESULTS_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const report = {
      ts: new Date().toISOString(),
      rounds,
      crashRound,
      crashReason,
      crashDiagLogLines: diagLines,
      ci: !!process.env.CI,
    }
    const outFile = path.join(RESULTS_DIR, `preview-lifecycle-crash-diag-${stamp}.json`)
    await fsp.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8')

    console.log(
      `[crash-diag] REPORT=${outFile} crashRound=${crashRound} crashReason=${crashReason ?? 'none'} diagLines=${diagLines.length}`,
    )

    // 诊断 spec 自身不断言崩溃与否：跑完即出报告（阶段1目标 = 拿到 reason 分布，不是让用例红/绿）
    expect(rounds.length).toBeGreaterThan(0)
    expect(outFile).toBeTruthy()
  })
})
