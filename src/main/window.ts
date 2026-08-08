/**
 * 窗口管理（对照原 Go app.go 的窗口控制 + runtime.Window* 函数）
 * 主进程模块：负责无边框窗口创建与窗口控制 IPC 的实现。
 *
 * v2.3.0 分层休眠（用户方案落地）：
 * - 第二层：最小化 2 分钟无恢复 → 渲染进程 reload 回收（不可见无感）
 * - 第三层：关闭（隐藏到托盘）2 分钟无活跃 → 销毁 BrowserWindow，内存只留主进程；
 *   托盘点击 / 二次启动时 ensureMainWindow 重建，秒开。
 */
import { BrowserWindow, app, shell } from 'electron'
import path from 'node:path'
import { log } from './log'

let mainWindow: BrowserWindow | null = null
let quitting = false

// —— 分层休眠定时器 ——
const DESTROY_DELAY_MS = 2 * 60 * 1000 // 第三层：隐藏后 2 分钟销毁窗口
const MINIMIZE_RECOVER_MS = 2 * 60 * 1000 // 第二层：最小化后 2 分钟渲染进程回收
let destroyTimer: NodeJS.Timeout | null = null
let minimizeRecoverTimer: NodeJS.Timeout | null = null

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
    backgroundColor: '#0f172a',
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

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
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
      }
    }, MINIMIZE_RECOVER_MS)
  })
  mainWindow.on('restore', () => {
    minimizeRecoverTimer = clearTimer(minimizeRecoverTimer)
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
      `[sleep] 倒计时到期: mainWindow=${!!mainWindow} destroyed=${mainWindow?.isDestroyed() ?? 'n/a'} quitting=${quitting}`,
    )
    if (mainWindow && !mainWindow.isDestroyed() && !quitting) {
      mainWindow.destroy()
      void log('info', '[sleep] 已销毁窗口（渲染进程回收）')
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
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
