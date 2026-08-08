/**
 * 按需预览窗口（v2.2.1）：PDF/图片预览在独立 BrowserWindow（独立渲染进程）中打开，
 * 关闭即销毁释放内存 —— 常驻内存最小化（主窗口不再内嵌大文件预览）。
 *
 * 设计：
 * - 单例：同时最多一个预览窗口；点击新文件复用窗口并导航到新文件
 * - 载荷：`#/preview?file=<encodeURIComponent(filePath)>`（dev 与打包统一走 hash）
 * - 预览窗口共享主进程全部 IPC（preload 相同），可访问 qihebox:// 文件协议、metadata、AI
 * - 关闭 → BrowserWindow 销毁（渲染进程随之退出，pdfjs/解码内存全部释放）
 */
import { BrowserWindow, app } from 'electron'
import path from 'node:path'

let previewWindow: BrowserWindow | null = null

function createPreviewWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: '文件预览',
    width: 1100,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    icon: path.join(app.getAppPath(), 'build/appicon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    if (previewWindow === win) previewWindow = null
  })

  // 主窗口退出时预览窗口一并销毁
  win.on('close', () => {
    // 正常关闭即销毁（内存释放）
  })

  return win
}

/**
 * 打开（或切换到）指定文件的预览窗口。
 * @param filePath 工作区内文件绝对路径
 */
export async function openPreviewWindow(filePath: string): Promise<void> {
  const hash = `#/preview?file=${encodeURIComponent(filePath)}`

  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = createPreviewWindow()
  }
  const win = previewWindow
  win.setTitle('文件预览')

  if (process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash}`)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: `/preview?file=${encodeURIComponent(filePath)}` })
  }
  if (!win.isDestroyed()) {
    win.show()
    win.focus()
  }
}

/** 预览窗口是否打开（供内存监控/退出流程判断） */
export function hasPreviewWindow(): boolean {
  return !!previewWindow && !previewWindow.isDestroyed()
}

/** 关闭预览窗口（内存立即释放） */
export function closePreviewWindow(): void {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.destroy()
  }
  previewWindow = null
}
