/**
 * 主进程入口（对照原 Go main.go / app.go）
 * - 单实例锁（requestSingleInstanceLock 替代 CreateMutex）
 * - 组装业务服务：BoxService + SharpThumbnailService（共享同一 workspace 实例）
 * - 注册 IPC 与 qihebox:// 文件协议
 * - 系统托盘 + 关闭隐藏到托盘 + 崩溃自愈骨架
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, protocol, safeStorage, Notification } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { BoxService } from './core'
import { WorkspaceService } from './core/workspace'
import { globalWorkspaceIndex } from './core/indexCache'
import { SharpThumbnailService } from './thumbnail'
import { registerIpc } from './ipc'
import { registerQiheboxProtocol } from './protocol'
import { AccountService } from './account'
import { startMemoryWatchdog } from './memoryWatchdog'
import { log, initLogger } from './log'
import { checkUpdate } from './updater'
import { computeNotifiable, type NotifyState } from './notify'
import { readJsonFile, writeJsonAtomic } from './core/paths'
import {
  createMainWindow,
  getMainWindow,
  ensureMainWindow,
  windowShow,
  windowHideToTray,
  windowQuit,
  setWindowCreateHandler,
  scheduleDestroy,
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

// —— 进程瘦身（v2.1.1）——
// 实测记录：
// 1. --single-process 极限合并：Deepin 上启动即崩（SIGTRAP，Chromium CHECK 失败），已放弃。
// 2. --no-zygote：去 3 个 zygote 孵化器（~118MB）；必须作为【启动参数】传入（appendSwitch 运行时
//    设置时机太晚不生效），故参数在 electron-builder.yml linux.executableArgs 中固化。
// 3. --disable-gpu：Deepin 本就软件渲染，GPU 进程 207MB → 90MB 空壳，无崩溃（区别于旧版
//    disableHardwareAcceleration 崩溃的环境）。
// 注：zygote 与 OS 级 sandbox 绑定，关闭需配 --no-sandbox；本机现状已有 --no-zygote-sandbox，
// 本地单用户工具 + webPreferences.sandbox:false，风险可控。

// —— 单实例锁（替代原 Go CreateMutex）——
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// —— v2.3.0 内存压制：frameless 无原生菜单，禁用默认菜单初始化（官方 Performance 清单）——
Menu.setApplicationMenu(null)

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
  // v2.2.1：did-finish-load 重置崩溃计数 —— 崩溃自愈成功后不再累计，避免数月内偶发崩溃提前退出
  win.webContents.on('did-finish-load', () => {
    rendererCrashes = 0
  })
  // GPU 进程崩溃 → 记录（后续自动切 --disable-gpu）
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') {
      void log('warn', 'gpu process gone, may fallback to software rendering')
    }
  })
}

// 关闭窗口 → 隐藏到托盘（对照原 Go beforeClose）；v2.3.0：隐藏后启动销毁倒计时（第三层休眠）
// e2e 模式（QIHEBOX_E2E=1，Playwright）：跳过隐藏托盘，让 app.close() 能正常退出（否则 Playwright 等待超时）
function setupCloseToTray(win: BrowserWindow): void {
  if (process.env.QIHEBOX_E2E === '1') return
  win.on('close', (e) => {
    if (isQuitting()) return
    e.preventDefault()
    void log('info', '[sleep] close 事件触发 → 隐藏到托盘 + 销毁倒计时')
    win.hide()
    scheduleDestroy()
  })
}

// 系统级退出（托盘退出菜单 / 应用退出）→ 置 quitting 放行窗口关闭
app.on('before-quit', () => {
  setQuitting(true)
})

// v2.3.0 分层休眠：窗口被休眠销毁（close → 托盘 → 2 分钟无活跃 → destroy）时，
// 必须监听 window-all-closed 阻止 Electron 默认退出（Windows/Linux 无监听时全窗口关闭即退出）。
// 空监听即视为自定义处理：主进程 + 托盘图标常驻，等待托盘点击 / 二次启动重建窗口。
// e2e 模式不注册：Playwright app.close() 需要全窗口关闭即退出。
if (process.env.QIHEBOX_E2E !== '1') {
  app.on('window-all-closed', () => {
    void log('info', '[window] 所有窗口已关闭（休眠态），主进程+托盘常驻等待唤醒')
  })
}

// —— 账号服务（v2.2.0：可选登录 + AI + 心跳）——
// token 优先 safeStorage 加密；Linux 无 keyring 时降级明文（本地单用户，JWT 过期即失效）。
function encryptToken(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    // fallthrough 到明文降级
  }
  return 'raw:' + plain
}

function decryptToken(encoded: string): string {
  try {
    if (encoded.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(encoded.slice(4), 'base64'))
    }
    if (encoded.startsWith('raw:')) {
      return encoded.slice(4)
    }
  } catch {
    return ''
  }
  return ''
}

const account = new AccountService({
  accountFile: path.join(app.getPath('userData'), 'account.json'),
  encrypt: encryptToken,
  decrypt: decryptToken,
  version: () => app.getVersion(),
  log: (level, msg) => void log(level, msg),
})

// —— v2.4.0 后台任务：更新检查 / 证书到期通知 / 回收站过期清理 ——

/** 静默更新检查：发现新版推送给所有窗口（无窗口则忽略，下次启动/次日再查）；失败仅 log */
async function runUpdateCheck(): Promise<void> {
  try {
    const info = await checkUpdate(app.getVersion())
    if (!info) return
    void log('info', `发现新版本 v${info.version}（当前 v${app.getVersion()}）`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('qihebox:event:update:available', info)
    }
  } catch (err) {
    void log('warn', `更新检查失败: ${String(err)}`)
  }
}

/** 系统通知：Electron Notification；Linux 无 libnotify 等环境不可用时 try/catch 静默降级 */
function sendSystemNotification(title: string, body: string): void {
  try {
    new Notification({ title, body }).show()
  } catch (err) {
    void log('warn', `系统通知不可用，已跳过: ${title}（${String(err)}）`)
  }
}

/** 证书到期通知：30 天内到期证书逐条通知；每日去重（userData/notified.json）；失败仅 log */
async function runCertNotify(box: BoxService): Promise<void> {
  let expiring: [string, string, string][]
  try {
    expiring = await box.dashboard.checkExpiringCerts()
  } catch (err) {
    void log('warn', `证书到期检查失败: ${String(err)}`)
    return
  }
  if (expiring.length === 0) return
  const notifiedFile = path.join(app.getPath('userData'), 'notified.json')
  const state = await readJsonFile<NotifyState>(notifiedFile)
  const { toNotify, nextState } = computeNotifiable(expiring, state)
  if (toNotify.length === 0) return
  // 先落盘去重记录再发送，避免发送环节失败导致同日反复打扰
  await writeJsonAtomic(notifiedFile, nextState).catch((err) =>
    void log('warn', `通知去重记录写入失败: ${String(err)}`),
  )
  for (const [productSet, fileName, expiry] of toNotify) {
    sendSystemNotification(
      '证书即将到期',
      `产品集「${productSet}」中 ${fileName} 将于 ${expiry} 到期，请及时处理`,
    )
  }
}

/** 启动后台任务（静默）：更新检查 → 证书到期通知 → 回收站过期清理（清理仅启动时执行一次） */
async function runStartupTasks(box: BoxService): Promise<void> {
  await runUpdateCheck()
  await runCertNotify(box)
  void box.trash.cleanupExpired().catch((err) => void log('warn', `回收站过期清理失败: ${String(err)}`))
}

// —— v2.4.x：工作区文件索引（Everything 式精简索引，事件驱动失效）——

let workspaceWatcher: fs.FSWatcher | null = null
/** 索引初始化代数：切换工作区时递增，过期异步结果作废（防竞态污染索引） */
let wsIndexGen = 0

/** 索引落盘根：userData/index/<workspaceHash>（哈希同缩略图：sha256(ws).slice(0,8)） */
function indexRootFor(ws: string): string {
  const hash = createHash('sha256').update(path.resolve(ws)).digest('hex').slice(0, 8)
  return path.join(app.getPath('userData'), 'index', hash)
}

/** 关闭当前工作区文件监听（切换 / 降级时调用） */
function closeWorkspaceWatcher(): void {
  if (workspaceWatcher) {
    try {
      workspaceWatcher.close()
    } catch {
      // 忽略
    }
    workspaceWatcher = null
  }
}

/**
 * 工作区文件监听（事件驱动失效）：
 * fs.watch(ws, { recursive: true }) → 文件/目录变化时 invalidate 对应目录，查询时重建快照，
 * 覆盖签名粒度盲区（同目录 mtime 下的文件内容覆盖等）。
 * recursive 创建即抛（Linux 不支持 / inotify 超限）或运行期报错（ENOSPC 等）→
 * 关闭监听降级为仅签名模式（每次查询 stat 比对签名兜底，功能正确性不受影响）。
 */
function startWorkspaceWatcher(box: BoxService, ws: string): void {
  closeWorkspaceWatcher()
  try {
    const watcher = fs.watch(ws, { recursive: true }, (_evt, filename) => {
      try {
        if (!filename) return
        // 工作区切换后旧监听仍可能触发事件 → 只处理当前工作区路径
        const cur = box.workspace.currentWorkspacePath()
        if (!cur || path.resolve(cur) !== path.resolve(ws)) return
        globalWorkspaceIndex.invalidate(path.dirname(path.join(ws, filename)))
      } catch {
        // 事件回调容错（文件名含非法编码等）
      }
    })
    watcher.on('error', (err) => {
      // 已被切换替换的新监听 → 交给新监听处理
      if (workspaceWatcher !== watcher) return
      void log('warn', `文件监听不可用，降级为仅签名模式: ${String(err)}`)
      try {
        watcher.close()
      } catch {
        // 忽略
      }
      workspaceWatcher = null
    })
    workspaceWatcher = watcher
  } catch (err) {
    void log('warn', `文件监听不可用，降级为仅签名模式: ${String(err)}`)
    workspaceWatcher = null
  }
}

/**
 * 初始化/重建工作区索引（启动恢复后与工作区切换时调用，异步不阻塞启动与 UI）：
 * 1. 文件监听事件驱动失效（先于加载，避免初始化期间的变更丢失）
 * 2. 落盘索引命中 → 后台逐目录 stat 校验签名，变化目录用 listRaw 重建（不落盘，运行中由监听/签名维护）
 * 3. 未命中 → build 全量快照 + save 落盘（二次启动免全量扫描）
 * 竞态防护：每次调用递增代数，异步返回后仍为当前代才写全局索引；切换竞态造成的残留
 * 由查询时的签名比对自愈（mtime 不一致即重建）。
 */
async function setupWorkspaceIndex(box: BoxService): Promise<void> {
  const gen = ++wsIndexGen
  const ws = box.workspace.currentWorkspacePath()
  if (!ws) return
  startWorkspaceWatcher(box, ws)
  const idxRoot = indexRootFor(ws)
  const loaded = await globalWorkspaceIndex.load(idxRoot)
  if (gen !== wsIndexGen) return // 加载期间已切换工作区 → 结果作废
  if (loaded) {
    const changed = await globalWorkspaceIndex.validate((d) => box.files.listRaw(d))
    if (gen !== wsIndexGen) return
    void log('info', `文件索引已加载（${changed} 个目录已重建）`)
  } else {
    const built = await globalWorkspaceIndex.build(ws, (d) => box.files.listRaw(d))
    if (gen !== wsIndexGen) return // 构建期间已切换 → 丢弃过期快照
    await globalWorkspaceIndex.save(idxRoot)
    void log('info', `文件索引已构建：${built} 个目录`)
  }
}

app.whenReady().then(() => {
  initLogger()
  // 单一 workspace 实例贯穿全部服务
  const workspace = new WorkspaceService()
  // v2.1.0：缩略图缓存根迁移到 userData（工作区不再被 .thumbnails 污染，坚果云不同步缓存）
  const thumbs = new SharpThumbnailService(workspace, {
    userDataThumbsDir: path.join(app.getPath('userData'), 'thumbs'),
  })
  const box = new BoxService(thumbs, workspace)

  registerIpc(box, account)
  registerQiheboxProtocol(box, () => thumbs.currentThumbsRoot())

  // 启动恢复/创建默认工作区（有最近工作区则恢复，无则自动创建）；
  // 恢复成功后初始化工作区索引（load/build + 文件监听，异步不阻塞）；随后跑后台任务（均静默）
  workspace
    .restoreOrCreateDefault()
    .then(() => {
      // v2.4.x：初始化工作区索引——加载/校验或全量构建 + 落盘 + 文件监听（失败仅 log，签名校验兜底）
      return setupWorkspaceIndex(box).catch((err) => void log('warn', `文件索引初始化失败: ${String(err)}`))
    })
    .catch((err) => {
      void log('warn', `默认工作区恢复失败: ${String(err)}`)
    })
    .then(() => {
      // v2.4.x：注册工作区切换钩子（含恢复失败路径）——setCurrentWorkspace 后重建索引与文件监听
      workspace.onWorkspaceChanged(() => {
        void setupWorkspaceIndex(box).catch((err) => void log('warn', `文件索引重建失败: ${String(err)}`))
      })
      return runStartupTasks(box)
    })

  // v2.3.0：统一窗口初始化钩子——休眠销毁后的重建（ensureMainWindow）自动带上崩溃自愈与托盘行为
  setWindowCreateHandler((win) => {
    setupCrashRecovery(win)
    setupCloseToTray(win)
    win.on('closed', () => {
      void log('info', '[window] 主窗口已销毁（休眠回收或退出）')
    })
  })

  const win = createMainWindow()
  setupTray()
  setupCrashRecovery(win)
  setupCloseToTray(win)

  // v2.4.0：每日定时任务（24h）——更新检查 + 证书到期通知；应用常驻托盘期间持续生效
  setInterval(() => {
    void runUpdateCheck()
    void runCertNotify(box)
  }, 24 * 3600 * 1000).unref()
})

app.on('activate', () => {
  // 休眠销毁窗口后，激活（macOS dock / Linux）即重建
  if (BrowserWindow.getAllWindows().length === 0) {
    ensureMainWindow()
  } else {
    windowShow()
  }
})

// 二次启动：聚焦已有窗口（替代原 FindWindow/SetForegroundWindow）；窗口被休眠销毁则重建
app.on('second-instance', () => {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    ensureMainWindow()
  }
})

// 主进程未捕获异常 → 日志落盘
process.on('uncaughtException', (err) => {
  void log('error', `uncaughtException: ${err?.stack ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  void log('error', `unhandledRejection: ${String(reason)}`)
})
