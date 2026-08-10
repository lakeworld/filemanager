/**
 * 窗口管理（对照原 Go app.go 的窗口控制 + runtime.Window* 函数）
 * 主进程模块：负责无边框窗口创建与窗口控制 IPC 的实现。
 *
 * v2.3.0 分层休眠（用户方案落地）：
 * - 第二层：最小化 2 分钟无恢复 → 渲染进程 reload 回收（不可见无感）
 * - 第三层：关闭（隐藏到托盘）2 分钟无活跃 → 销毁 BrowserWindow，内存只留主进程；
 *   托盘点击 / 二次启动时 ensureMainWindow 重建，秒开。
 *
 * v2.4.3 唤醒修复（docs/PLAN-v2.4.3.md，F1-F4 / F6）：
 * - F1 加载底色改浅色，唤醒重建期不再露出深蓝近黑空窗
 * - F2 重建窗口不提前 show，交给 ready-to-show（黑屏根因之一）
 * - F3 唤醒活性检查（ping）：渲染假死（非崩溃）自动 reload，解决"黑屏无唤醒机制"
 * - F4 最小化不可见 reload 后置标记，恢复时在可见状态再校验一次活性
 * - F6 休眠定时器支持 env 覆盖（QIHEBOX_DESTROY_DELAY_MS / QIHEBOX_MINIMIZE_RECOVER_MS）+ 唤醒路径日志
 */
import { BrowserWindow, app, shell } from 'electron'
import path from 'node:path'
import { log } from './log'

let mainWindow: BrowserWindow | null = null
let quitting = false

// —— 分层休眠定时器 ——
// v2.4.3（F6）：支持 env 覆盖（默认 2 分钟），验证/自查时缩到 10 秒跑完整休眠→唤醒循环
const DESTROY_DELAY_MS = Number(process.env.QIHEBOX_DESTROY_DELAY_MS) || 2 * 60 * 1000 // 第三层：隐藏后 2 分钟销毁窗口
const MINIMIZE_RECOVER_MS = Number(process.env.QIHEBOX_MINIMIZE_RECOVER_MS) || 2 * 60 * 1000 // 第二层：最小化后 2 分钟渲染进程回收
const WAKE_PING_TIMEOUT_MS = 2000 // v2.4.3（F3）：渲染进程活性 ping 超时
let destroyTimer: NodeJS.Timeout | null = null
let minimizeRecoverTimer: NodeJS.Timeout | null = null
let reloadedWhileHidden = false // v2.4.3（F4）：最小化不可见 reload 标记
let wakePingInFlight = false // v2.4.3（F3）：活性检查互斥，避免并发 ping

/** 窗口重建钩子（index.ts 注册 setupCrashRecovery / setupCloseToTray） */
let onCreateHandler: ((win: BrowserWindow) => void) | null = null

function clearTimer(timer: NodeJS.Timeout | null): NodeJS.Timeout | null {
  if (timer) clearTimeout(timer)
  return null
}

export function setWindowCreateHandler(h: (win: BrowserWindow) => void): void {
  onCreateHandler = h
}

export function setQuitting(v: boolean): void {
  quitting = v
}

export function isQuitting(): boolean {
  return quitting
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 确保主窗口存在（被休眠销毁后重建），并执行窗口初始化钩子 */
export function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  void log('info', '[wake] 窗口已被休眠销毁，重建中')
  const win = createMainWindow()
  onCreateHandler?.(win)
  return win
}

export function createMainWindow(): BrowserWindow {
  destroyTimer = clearTimer(destroyTimer) // 新建即取消待销毁
  mainWindow = new BrowserWindow({
    title: '启禾文件管理',
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    frame: false, // 无边框：前端 TitleBar 用 -webkit-app-region 实现拖拽
    // v2.4.3（F1）：加载底色与界面 bg-surface-50 一致——唤醒重建时不再露出深蓝近黑空窗
    backgroundColor: '#f8fafc',
    icon: path.join(app.getAppPath(), 'build/appicon.png'), // Linux 任务栏/窗口图标
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ESM preload 需要；阶段 6 安全评估
      spellcheck: false, // v2.1.0：关拼写检查，省渲染进程资源
      webgl: false, // v2.3.0：应用无 WebGL 场景，禁用以省 GPU 上下文初始化
    },
  })

  // v2.4.3（F2）：重建窗口只在这里 show+focus（渲染就绪才显示），windowShow 不再提前 show
  mainWindow.on('ready-to-show', () => {
    void log('info', '[wake] 窗口就绪（ready-to-show）')
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 第二层：最小化 2 分钟无恢复 → 渲染进程 reload 回收（窗口不可见，无感）
  mainWindow.on('minimize', () => {
    minimizeRecoverTimer = clearTimer(minimizeRecoverTimer)
    minimizeRecoverTimer = setTimeout(() => {
      minimizeRecoverTimer = null
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) return
      if (mainWindow && !mainWindow.isDestroyed() && !quitting) {
        mainWindow.webContents.reload()
        // v2.4.3（F4）：不可见状态 reload 后置标记，恢复时在可见状态再校验一次活性
        reloadedWhileHidden = true
        void log('info', '[sleep] 最小化超时：渲染进程已 reload 回收（标记恢复检查）')
      }
    }, MINIMIZE_RECOVER_MS)
  })
  mainWindow.on('restore', () => {
    minimizeRecoverTimer = clearTimer(minimizeRecoverTimer)
    // v2.4.3（F4）：不可见 reload 后的恢复——可见状态补一次活性检查
    if (reloadedWhileHidden) {
      reloadedWhileHidden = false
      const win = mainWindow
      if (win && !win.isDestroyed()) void pingRenderer(win)
    }
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

// —— v2.4.3（F3）：渲染进程活性检查（唤醒机制本体）——
// 渲染假死（不触发 render-process-gone）时自动 reload；每次唤醒（windowShow / 最小化恢复）调用。
async function pingRenderer(win: BrowserWindow): Promise<void> {
  if (wakePingInFlight || win.isDestroyed() || win.isMinimized()) return
  const wc = win.webContents
  if (wc.isCrashed()) {
    void log('warn', '[wake] 渲染进程已崩溃，reload 恢复')
    wc.reload()
    return
  }
  if (wc.isLoading()) return // 加载中：ready-to-show 会兜底显示，无需干预
  wakePingInFlight = true
  let timer: NodeJS.Timeout | null = null
  try {
    const ok = await Promise.race([
      wc.executeJavaScript('document.readyState === "complete"', true).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), WAKE_PING_TIMEOUT_MS)
      }),
    ])
    void log('info', `[wake] 活性检查: ${ok ? 'ok' : '超时/无响应，执行 reload'}`)
    if (!ok && !win.isDestroyed()) wc.reload()
  } catch (e) {
    void log('warn', `[wake] 活性检查异常: ${String(e)}`)
    if (!win.isDestroyed()) wc.reload()
  } finally {
    if (timer) clearTimeout(timer)
    wakePingInFlight = false
  }
}

// —— 窗口控制（对照 app.go Window* 方法）——
export function windowHideToTray(): void {
  mainWindow?.hide()
  scheduleDestroy() // 第三层：隐藏后启动销毁倒计时
}

/** 第三层：隐藏（关闭到托盘）后 2 分钟无活跃 → 销毁窗口 */
export function scheduleDestroy(): void {
  destroyTimer = clearTimer(destroyTimer)
  void log('info', '[sleep] 已排定销毁倒计时（2 分钟）')
  destroyTimer = setTimeout(() => {
    destroyTimer = null
    void log(
      'info',
      `[sleep] 倒计时到期: mainWindow=${!!mainWindow} destroyed=${mainWindow?.isDestroyed() ?? 'n/a'} quitting=${quitting} visible=${mainWindow?.isVisible() ?? 'n/a'}`,
    )
    // v2.4.x 修复：倒计时到期时窗口若已恢复显示（用户操作中），不得销毁——
    // 此前 windowShow 未取消倒计时，用户恢复窗口后继续操作会在 2 分钟时被强制销毁（界面突然消失）
    if (mainWindow && !mainWindow.isDestroyed() && !quitting && !mainWindow.isVisible()) {
      mainWindow.destroy()
      void log('info', '[sleep] 已销毁窗口（渲染进程回收）')
    } else {
      void log('info', '[sleep] 窗口已恢复显示或退出中，取消休眠销毁')
    }
  }, DESTROY_DELAY_MS)
}

/** 取消销毁倒计时（窗口被重新展示/新建时） */
export function cancelDestroy(): void {
  destroyTimer = clearTimer(destroyTimer)
}

export function windowShow(): void {
  // 窗口可能已被休眠销毁 → 重建
  const win = ensureMainWindow()
  const wc = win.webContents
  if (win.isMinimized()) win.restore()
  // v2.4.3（F2）：刚重建/加载中的窗口不提前 show——交给 ready-to-show 显示（避免渲染未就绪时露出深色空窗）
  if (!wc.isLoading()) {
    win.show()
    win.focus()
  }
  // v2.4.x 修复：恢复显示必须取消休眠销毁倒计时（否则操作中会被强制销毁）
  cancelDestroy()
  // v2.4.3（F3）：唤醒即做活性检查（加载中自动跳过，ready-to-show 兜底）
  void pingRenderer(win)
}

export function windowMinimize(): void {
  mainWindow?.minimize()
}

export function windowToggleMaximize(): void {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
}

export function windowIsMaximised(): boolean {
  return mainWindow?.isMaximized() ?? false
}

export function windowQuit(): void {
  setQuitting(true)
  mainWindow?.destroy()
  app.quit()
}

export function windowGetSize(): { w: number; h: number } {
  const [w, h] = mainWindow ? mainWindow.getSize() : [1280, 900]
  return { w, h }
}

export function windowSetSize(w: number, h: number): void {
  mainWindow?.setSize(w, h)
}

export function windowGetPosition(): { x: number; y: number } {
  const [x, y] = mainWindow ? mainWindow.getPosition() : [0, 0]
  return { x, y }
}

export function windowSetPosition(x: number, y: number): void {
  mainWindow?.setPosition(x, y)
}
