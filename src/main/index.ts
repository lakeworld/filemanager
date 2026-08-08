/**
 * 主进程入口（对照原 Go main.go / app.go）
 * - 单实例锁（requestSingleInstanceLock 替代 CreateMutex）
 * - 组装业务服务：BoxService + SharpThumbnailService（共享同一 workspace 实例）
 * - 注册 IPC 与 qihebox:// 文件协议
 * - 系统托盘 + 关闭隐藏到托盘 + 崩溃自愈骨架
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, protocol } from 'electron'
import path from 'node:path'
import { BoxService } from './core'
import { WorkspaceService } from './core/workspace'
import { SharpThumbnailService } from './thumbnail'
import { registerIpc } from './ipc'
import { registerQiheboxProtocol } from './protocol'
import { log, initLogger } from './log'
import {
  createMainWindow,
  getMainWindow,
  windowShow,
  windowHideToTray,
  windowQuit,
  setQuitting,
  isQuitting,
} from './window'

// —— 自定义协议特权注册（必须在 app ready 前）——
// 声明 qihebox:// 为 standard/secure scheme，支持 fetch 与流式响应
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'qihebox',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

// 主进程堆上限（防止长时间运行内存膨胀）

// —— 单实例锁（替代原 Go CreateMutex）——
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let tray: Tray | null = null
let rendererCrashes = 0

function setupTray(): void {
  const iconPath = path.join(app.getAppPath(), 'build/trayicon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('启禾文件管理 - 常驻后台运行中')
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => windowShow() },
    { label: '隐藏到托盘', click: () => windowHideToTray() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        setQuitting(true)
        windowQuit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => windowShow())
}

function setupCrashRecovery(win: BrowserWindow): void {
  // 渲染进程崩溃 → 自动 reload（最多 3 次，避免死循环）
  win.webContents.on('render-process-gone', (_e, details) => {
    void log('error', `renderer gone: ${details.reason}`)
    rendererCrashes++
    if (rendererCrashes > 3) {
      setQuitting(true)
      app.quit()
      return
    }
    setTimeout(() => {
      if (!win.isDestroyed()) win.reload()
    }, 500)
  })
  // GPU 进程崩溃 → 记录（后续自动切 --disable-gpu）
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') {
      void log('warn', 'gpu process gone, may fallback to software rendering')
    }
  })
}

// 关闭窗口 → 隐藏到托盘（对照原 Go beforeClose）
function setupCloseToTray(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (isQuitting()) return
    e.preventDefault()
    win.hide()
  })
}

// 系统级退出（托盘退出菜单 / 应用退出）→ 置 quitting 放行窗口关闭
app.on('before-quit', () => {
  setQuitting(true)
})

app.whenReady().then(() => {
  initLogger()
  // 单一 workspace 实例贯穿全部服务
  const workspace = new WorkspaceService()
  // v2.1.0：缩略图缓存根迁移到 userData（工作区不再被 .thumbnails 污染，坚果云不同步缓存）
  const thumbs = new SharpThumbnailService(workspace, {
    userDataThumbsDir: path.join(app.getPath('userData'), 'thumbs'),
  })
  const box = new BoxService(thumbs, workspace)

  registerIpc(box)
  registerQiheboxProtocol(box, () => thumbs.currentThumbsRoot())

  // 启动恢复/创建默认工作区（有最近工作区则恢复，无则自动创建）
  workspace.restoreOrCreateDefault().catch((err) => {
    void log('warn', `默认工作区恢复失败: ${String(err)}`)
  })

  const win = createMainWindow()
  setupTray()
  setupCrashRecovery(win)
  setupCloseToTray(win)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const win = createMainWindow()
    setupCrashRecovery(win)
    setupCloseToTray(win)
  }
})

// 二次启动：聚焦已有窗口（替代原 FindWindow/SetForegroundWindow）
app.on('second-instance', () => {
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

// 主进程未捕获异常 → 日志落盘
process.on('uncaughtException', (err) => {
  void log('error', `uncaughtException: ${err?.stack ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  void log('error', `unhandledRejection: ${String(reason)}`)
})
