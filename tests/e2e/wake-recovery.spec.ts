import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 系统暂停/唤醒回归（v2.5.3 常驻轻壳 T5 + 2026-08-19 托盘冻结热修）。
 * 新语义（设计 §4.4 系统睡眠 + PLAN-v2.5.3-托盘冻结根治.md）：暂停/锁屏信号到达即隐藏窗口
 * （渲染常驻），唤醒后仅在「暂停前可见」（wasVisibleBeforeSystemPause）时自动恢复——
 * **直接 show + 显示后白屏自检兜底**（FrameWitness 隐藏预检已废止：长时隐藏后合成器休眠
 * 抓不到帧，预检 unknown 反而堵死唤醒，2026-08-19 事故定案）。崩溃 render-process-gone →
 * 状态机 L4 销毁重建，ready-to-show 收口直接 show。
 * 覆盖：
 * 1. 正常窗口 resume / unlock-screen 后不被打扰（未记录暂停前可见 → 不显示，保留页面状态）
 * 2. 系统暂停（可见窗口）→ 立即隐藏；唤醒 → 直接恢复显示 + 显示后自检通过
 * 3. 托盘隐藏/恢复：页面状态保留，恢复 = 直接显示 + 显示后自检
 * 4. 时钟跳变（单时钟兜底）→ 可见窗口按「暂停前可见」处理：先隐藏再直接恢复
 * 5. 系统旁路 restore 只做最小化状态归一化，不是显示入口（无 WM 环境动态跳过）
 * 6. 渲染进程崩溃 → 状态机 L4 销毁重建 + ready-to-show 收口（不依赖 resume 信号）
 */
/**
 * 主进程日志文件名 = 本地日期（logger.ts dateStr 语义；toISOString 是 UTC，
 * 本地 00:00–08:00（UTC+8）窗口会差一天导致 ENOENT——2026-08-18 修复）
 */
function localLogDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 业务层是否已挂载（主路由 main 元素出现；parked 卸载后消失） */
const bizMounted = () => !!document.querySelector('main[class*="overflow-y-auto"]')
// 取反版必须自包含（函数体只引用页面全局），序列化到页面上下文后不依赖 Node 作用域；
// waitForFunction(() => !bizMounted()) 会因闭包引用 bizMounted 而 ReferenceError
const bizUnmounted = () => !document.querySelector('main[class*="overflow-y-auto"]')

test.describe('系统暂停/唤醒与崩溃恢复（常驻轻壳 T5 + 托盘冻结热修）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.waitForFunction(bizMounted, null, { timeout: 15000 })
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

  /** 触发 powerMonitor 信号（模拟系统事件） */
  const fireWake = (signal: 'resume' | 'unlock-screen' | 'suspend' | 'lock-screen') =>
    app.evaluate(({ powerMonitor }, sig) => {
      powerMonitor.emit(sig)
      return true
    }, signal)

  /** 主进程当日日志全文（app.getPath('logs')/main-<本地日期>.log） */
  async function readLog(): Promise<string> {
    const logsDir = await app.evaluate(({ app: a }) => a.getPath('logs'))
    const logPath = path.join(logsDir, `main-${localLogDate()}.log`)
    try {
      return await fsp.readFile(logPath, 'utf8')
    } catch {
      return ''
    }
  }

  test('正常窗口 resume / unlock-screen 后不被打扰（未记录暂停前可见 → 不显示）', async () => {
    // 页面标记：reload 会丢失
    await page.evaluate(() => {
      ;(window as any).__wakeMarker = 'alive'
    })
    await fireWake('resume')
    await page.waitForTimeout(500)
    await fireWake('unlock-screen')
    await page.waitForTimeout(500)

    // 窗口仍可见、页面状态保留（未被 reload）
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '可见窗口收到 resume 不应被隐藏').toBe(true)
    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker).toBe('alive')
    const hasApi = await page.evaluate(() => typeof (window as any).qihebox?.app?.version === 'function')
    expect(hasApi).toBe(true)
    // 观测日志：不自行显示（未记录暂停前可见）
    expect(await readLog()).toMatch(/窗口原本在托盘\/未记录暂停前可见，不自行显示/)
  })

  test('系统暂停（可见窗口）→ 立即隐藏；唤醒 → 直接恢复显示 + 显示后自检', async () => {
    await page.evaluate(() => {
      ;(window as any).__wakeMarker = 'alive'
    })
    const before = (await readLog()).length

    await fireWake('suspend')
    // 暂停：可见窗口立即隐藏 + 业务层卸载（parking → parked）
    await page.waitForFunction(bizUnmounted, null, { timeout: 10000 })
    const visibleAfterSuspend = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visibleAfterSuspend, '暂停信号到达后窗口应隐藏').toBe(false)

    await fireWake('resume')
    // 暂停前可见 → 直接 show 恢复（无隐藏预检），显示后 300ms 自检兜底
    await page.waitForFunction(bizMounted, null, { timeout: 20000 })
    const visibleAfterResume = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visibleAfterResume, '暂停前可见的窗口唤醒后应自动恢复显示').toBe(true)
    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker, '恢复路径不得误 reload（页面状态保留）').toBe('alive')

    // 等显示后自检（show+300ms 抓帧）跑完再读日志
    await page.waitForTimeout(600)
    const log = (await readLog()).slice(before)
    expect(log, '唤醒恢复应直接显示（无隐藏预检）').toMatch(/系统唤醒.*直接恢复显示/)
    expect(log, '恢复后应跑显示后白屏自检并通过').toMatch(/显示后自检通过/)
    expect(log, '健康暂停/唤醒不得触发 L2 reload').not.toMatch(/L2 reload 渲染进程/)
  })

  test('托盘隐藏/恢复：页面状态保留，恢复 = 直接显示 + 显示后自检', async () => {
    await page.evaluate(() => {
      ;(window as any).__wakeMarker = 'alive'
    })
    const before = (await readLog()).length

    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(bizUnmounted, null, { timeout: 10000 })
    await page.evaluate(() => (window as any).qihebox.window.show())
    await page.waitForFunction(bizMounted, null, { timeout: 20000 })

    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker, '托盘恢复不得误 reload').toBe('alive')
    // 等显示后自检（show+300ms 抓帧）跑完再读日志
    await page.waitForTimeout(600)
    const after = (await readLog()).slice(before)
    expect(after, '托盘恢复后应跑显示后白屏自检并通过').toMatch(/显示后自检通过/)
    expect(after, '健康托盘恢复不得触发 L2 reload').not.toMatch(/L2 reload 渲染进程/)
  })

  test('时钟跳变（单时钟兜底）→ 可见窗口按「暂停前可见」处理：先隐藏再直接恢复', async () => {
    await page.evaluate(() => {
      ;(window as any).__wakeMarker = 'alive'
    })
    const before = (await readLog()).length

    // 首 tick 建立当前基线（Δ 小，不判定）
    await app.evaluate(() => (globalThis as any).__wakePollTick(Date.now()))
    // 伪造 3 分钟时钟跳变（模拟睡眠冻结 → 唤醒）：Δ=180s > 30s×3 → 判定刚经历睡眠
    await app.evaluate(() => (globalThis as any).__wakePollTick(Date.now() + 3 * 60 * 1000))
    // 可见窗口：先同步隐藏 → 按暂停前可见恢复链（直接 show + 显示后自检）
    await page.waitForFunction(bizMounted, null, { timeout: 20000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '时钟检测到睡眠后应直接恢复显示').toBe(true)
    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker, '时钟恢复路径不得误 reload').toBe('alive')

    // 等显示后自检（show+300ms 抓帧）跑完再读日志
    await page.waitForTimeout(600)
    const after = (await readLog()).slice(before)
    expect(after, '日志应记录时钟检测命中').toMatch(/时钟检测到系统休眠恢复/)
    expect(after, '时钟恢复应直接显示（无隐藏预检）').toMatch(/直接恢复显示/)
    expect(after, '恢复后应跑显示后白屏自检并通过').toMatch(/显示后自检通过/)
    expect(after, '健康时钟恢复不得触发 L2 reload').not.toMatch(/L2 reload 渲染进程/)
  })

  test('系统旁路 restore 只做最小化状态归一化，不是显示入口', async () => {
    const logsDir = await app.evaluate(({ app: a }) => a.getPath('logs'))
    const logPath = path.join(logsDir, `main-${localLogDate()}.log`)
    const before = (await fsp.readFile(logPath, 'utf8')).length

    // 真实最小化（无 WM 环境（CI xvfb）窗口不进最小化态 → 动态跳过，本地桌面环境完整验证）
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].minimize()
      return true
    })
    const minimized = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (!w.isDestroyed() && w.isMinimized()) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    })
    test.skip(!minimized, '无 WM 环境窗口不进入最小化态，跳过（本地桌面/有 WM 环境验证）')

    // 系统旁路最小化 → minimize 事件归一化为隐藏（渲染常驻）
    await page.waitForFunction(bizUnmounted, null, { timeout: 10000 })

    // 恢复窗口 → restore 事件：只做归一化（保持隐藏），不显示
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].restore()
      return true
    })
    await page.waitForTimeout(800)

    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '旁路 restore 不得触发显示（恢复只走状态机入口）').toBe(false)
    const after = (await fsp.readFile(logPath, 'utf8')).slice(before)
    expect(after, 'restore 旁路应有归一化日志').toMatch(/系统 restore 旁路/)
    expect(after, '旁路 restore 不得触发 reload').not.toMatch(/L2 reload 渲染进程/)

    // 收尾：经托盘恢复显示（真实恢复入口）
    await page.evaluate(() => (window as any).qihebox.window.show())
    await page.waitForFunction(bizMounted, null, { timeout: 20000 })
  })

  test('渲染进程崩溃 → 状态机 L4 销毁重建 + ready-to-show 收口（不依赖 resume 信号）', async () => {
    // 环境适配：崩溃模拟（SIGKILL 渲染进程）在 GitHub runner 上时序不可靠（本地 xvfb 实测连续跑
    // 也偶发 flaky，CI 更甚）——本用例在 CI 跳过，由本地/开发机 xvfb 完整验证崩溃恢复路径
    test.skip(!!process.env.CI, '崩溃模拟在 GitHub runner 时序不可靠，本地 xvfb 完整验证')
    // 注册崩溃信号 + 真实 SIGKILL 渲染进程（forcefullyCrashRenderer 模拟 API 在 CI runner 上
    // 不触发 render-process-gone——实测；SIGKILL 必然触发 gone，且更接近真实崩溃场景；
    // 此后页面对象不可用，全程走主进程上下文，不得桥接 executeJavaScript——会 GC 错误）
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      ;(globalThis as any).__e2eCrashGone = false
      w.webContents.once('render-process-gone', () => {
        ;(globalThis as any).__e2eCrashGone = true
      })
      process.kill(w.webContents.getOSProcessId(), 'SIGKILL')
      return true
    })
    // 等崩溃生效（15s 覆盖 CI 慢环境；纯主进程轮询信号/isCrashed，无渲染桥接）
    const crashed = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if ((globalThis as any).__e2eCrashGone) return true
        if (w && !w.isDestroyed() && w.webContents.isCrashed()) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    })
    expect(crashed).toBe(true)

    // 状态机接管：visible → renderer-gone → L4 销毁重建（崩溃后 webContents 损坏、reload
    // 不可靠，探针实证）→ 新窗口 ready-to-show 收口直接 show。全程不需要 resume 信号。
    // L4 后窗口/渲染层重建，轮询需接受「原窗口销毁、取现存窗口」。
    const recovered = await app.evaluate(async ({ BrowserWindow }) => {
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
        if (w) {
          const wc = w.webContents
          if (!wc.isCrashed() && !wc.isLoading()) {
            try {
              const v = await wc.executeJavaScript('typeof window.qihebox', true)
              if (v === 'object' && w.isVisible()) return true
            } catch { /* 仍在加载 */ }
          }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })
    expect(recovered, '崩溃后应由状态机 L4 销毁重建并收口恢复显示').toBe(true)
    const log = await readLog()
    expect(log).toMatch(/renderer gone/)
    expect(log, '崩溃恢复应走 L4 销毁重建').toMatch(/L4 销毁重建/)
  })
})
