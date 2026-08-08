/**
 * 内存水位监控（v2.2.1）：长期运行内存的最后防线。
 *
 * 策略：
 * - 启动 5 分钟后记录渲染进程基线（热身完成）
 * - 每 60s 采样 app.getAppMetrics()，渲染进程 RSS 超阈值（800MB 或基线+300MB）
 *   持续 3 个周期 → 日志 + 优雅 reload（清堆碎片与 Blink 图像缓存）
 * - 24h 定时 reload 保底（VSCode/Slack 同款思路：常驻应用定期重置渲染进程）
 * - reload 仅在空闲时执行：主窗口隐藏（托盘常驻）且无预览窗口打开
 */
import { app, BrowserWindow } from 'electron'
import { log } from './log'

const BASELINE_DELAY_MS = 5 * 60 * 1000
const SAMPLE_INTERVAL_MS = 60 * 1000
const RENDERER_LIMIT_BYTES = 800 * 1024 * 1024
const RENDERER_DELTA_BYTES = 300 * 1024 * 1024
const CONSECUTIVE_LIMIT = 3
const RELOAD_INTERVAL_MS = 24 * 60 * 60 * 1000
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000

interface WatchdogOptions {
  getMainWindow: () => BrowserWindow | null
  /** 忙碌判定：可见且聚焦的主窗口视为用户在使用（不打扰 reload） */
  isBusy: () => boolean
}

export function startMemoryWatchdog(opts: WatchdogOptions): void {
  let baseline = 0
  let consecutive = 0
  let lastReload = 0
  let started = false

  const rendererRSS = (): number => {
    let total = 0
    try {
      for (const m of app.getAppMetrics()) {
        if (m.type === 'Tab' || m.type === 'renderer') {
          total += m.memory?.workingSetSize ?? 0
        }
      }
    } catch {
      // 采样失败按 0 处理
    }
    return total
  }

  const reloadIfIdle = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastReload < RELOAD_COOLDOWN_MS) return
    const win = opts.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (opts.isBusy()) return
    lastReload = now
    void log('info', '[watchdog] 触发渲染进程优雅 reload（内存回收）')
    try {
      win.webContents.reload()
    } catch (err) {
      void log('warn', `[watchdog] reload 失败: ${String(err)}`)
    }
  }

  // 基线：启动 5 分钟后（此时首屏/缩略图热身完成）
  setTimeout(() => {
    baseline = rendererRSS()
    started = true
    const limit = Math.max(RENDERER_LIMIT_BYTES, baseline + RENDERER_DELTA_BYTES)
    void log('info', `[watchdog] 基线渲染内存 ${Math.round(baseline / 1048576)}MB，超限阈值 ${Math.round(limit / 1048576)}MB`)
  }, BASELINE_DELAY_MS)

  // 周期采样
  setInterval(() => {
    if (!started) return
    const rss = rendererRSS()
    const limit = Math.max(RENDERER_LIMIT_BYTES, baseline + RENDERER_DELTA_BYTES)
    if (rss > limit) {
      consecutive++
      void log('warn', `[watchdog] 渲染进程内存 ${Math.round(rss / 1048576)}MB 超阈值，连续 ${consecutive}/${CONSECUTIVE_LIMIT}`)
      if (consecutive >= CONSECUTIVE_LIMIT) {
        consecutive = 0
        void reloadIfIdle()
      }
    } else if (consecutive > 0) {
      consecutive = 0
    }
  }, SAMPLE_INTERVAL_MS)

  // 24h 定时 reload 保底
  setInterval(() => {
    void reloadIfIdle()
  }, RELOAD_INTERVAL_MS)
}
