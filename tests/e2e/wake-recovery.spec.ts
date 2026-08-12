import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 休眠唤醒自愈回归（v2.4.7 F10；v2.4.8 根治：监听加固 + 分级自愈链）。
 * 覆盖：
 * 1. 正常窗口 resume 后不被打扰（L1 invalidate 重绘 + capturePage 复检正常 → 不 reload，保留页面状态）
 * 2. 正常窗口 unlock-screen 后不被打扰（监听加固：resume 之外的唤醒入口，行为同 1）
 * 3. 渲染进程崩溃后 resume → 自动 reload 恢复（launch 时 QIHEBOX_CRASH_RECOVER_MS=10000
 *    拉长既有 crash-recovery 的 500ms 兜底，使恢复只能来自自愈链，真判别而非 false-green）
 * 注：真实「GPU 表面失效蓝/白屏」在 e2e 环境无法构造，L2/L3/L4 升级路径由 core/frame.ts
 * 单测（判定色）+ 每级 [wake] 日志 + 真机合盖验证兜底。
 */
test.describe('休眠唤醒自愈', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        // 评审 P1：把 crash-recovery 的 500ms reload 延迟拉长到 10s——崩溃用例的恢复
        // 只能来自 F10（resume → 1.5s → isCrashed → reload），排除既有 crash-recovery 兜底
        QIHEBOX_CRASH_RECOVER_MS: '10000',
      },
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

  /** 触发休眠唤醒信号（模拟系统休眠唤醒 / 解锁屏幕） */
  const fireWake = (signal: 'resume' | 'unlock-screen') =>
    app.evaluate(({ powerMonitor }, sig) => {
      powerMonitor.emit(sig)
      return true
    }, signal)

  test('正常窗口 resume 后不被 reload（L1 重绘即恢复，保留页面状态）', async () => {
    // 页面标记：reload 会丢失
    await page.evaluate(() => {
      (window as any).__wakeMarker = 'alive'
    })

    await fireWake('resume')
    // 等待：1.5s 稳定 + L1 invalidate + 2s 复检（v2.4.8 根治：分级自愈链 L1 完成）
    await page.waitForTimeout(4500)

    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker).toBe('alive')
    const hasApi = await page.evaluate(() => typeof (window as any).qihebox?.app?.version === 'function')
    expect(hasApi).toBe(true)
  })

  test('正常窗口 unlock-screen 后不被 reload（监听加固：resume 之外的唤醒入口）', async () => {
    await page.evaluate(() => {
      (window as any).__wakeMarker = 'alive'
    })

    await fireWake('unlock-screen')
    await page.waitForTimeout(4500)

    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker).toBe('alive')
    const hasApi = await page.evaluate(() => typeof (window as any).qihebox?.app?.version === 'function')
    expect(hasApi).toBe(true)
  })

  test('托盘恢复（关窗→托盘→点开）触发画面自愈且不丢页面状态（v2.4.9 修复）', async () => {
    // v2.4.9 修复回归：用户实测「关窗→托盘→恢复显示」白屏——windowShow 路径此前只做 JS 活性
    // 检查（pingRenderer），隐藏期间 GPU 合成表面失效时画面空白、JS 活着，白屏无自愈入口。
    // 修复：windowShow 恢复显示后追加 recoverAfterWake（画面自愈链）。本用例验证：
    // 1) 托盘恢复路径触发画面自愈（日志出现 L1 重绘，正常画面仅一次无害 invalidate）
    // 2) 正常画面不被误 reload（页面状态 marker 保留）
    await page.evaluate(() => {
      ;(window as any).__wakeMarker = 'alive'
    })
    // 主进程日志探针：记录 windowShow 路径自愈链是否被触发（L1 调度即证明 recoverAfterWake 已挂上）
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const logPath = path.join(userData, 'logs', `main-${new Date().toISOString().slice(0, 10)}.log`)
    const before = (await fsp.readFile(logPath, 'utf8')).length

    // 关窗→托盘（隐藏窗口 + 30s 销毁倒计时）
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForTimeout(300)

    // 点托盘恢复显示（windowShow：ensureMainWindow + show + pingRenderer + recoverAfterWake）
    await page.evaluate(() => (window as any).qihebox.window.show())
    // 等 L1 invalidate + 2s 复检（正常画面 L1 即通过，不 reload）
    await page.waitForTimeout(4500)

    // 页面状态保留（未被误 reload）
    const marker = await page.evaluate(() => (window as any).__wakeMarker ?? null)
    expect(marker).toBe('alive')
    const hasApi = await page.evaluate(() => typeof (window as any).qihebox?.app?.version === 'function')
    expect(hasApi).toBe(true)
    // 画面自愈链确实在 windowShow 路径触发（新增日志：L1 已调度 / 画面正常）
    const after = (await fsp.readFile(logPath, 'utf8')).slice(before)
    expect(after).toMatch(/\[wake\] L1 已调度全量重绘|\[wake\] 画面正常（L1 复检通过）/)
  })

  test('渲染进程崩溃后 resume → 自动 reload 恢复', async () => {
    // 环境适配：崩溃模拟（SIGKILL 渲染进程）在 GitHub runner 上时序不可靠（本地 xvfb 实测连续跑
    // 也偶发 flaky，CI 更甚）——本用例在 CI 跳过，由本地/开发机 xvfb 完整验证 F10 崩溃恢复路径
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

    await fireWake('resume')

    // 等自愈 reload + 重新加载完成（主进程轮询：不崩溃、不加载中、window.qihebox 可用）
    const recovered = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (!w || w.isDestroyed()) return false
        const wc = w.webContents
        if (!wc.isCrashed() && !wc.isLoading()) {
          try {
            const v = await wc.executeJavaScript('typeof window.qihebox', true)
            if (v === 'object') return true
          } catch { /* 仍在加载 */ }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })
    expect(recovered).toBe(true)
  })
})
