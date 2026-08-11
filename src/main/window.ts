/**
 * 窗口管理（对照原 Go app.go 的窗口控制 + runtime.Window* 函数）
 * 主进程模块：负责无边框窗口创建与窗口控制 IPC 的实现。
 *
 * v2.3.0 分层休眠（用户方案落地）：
 * - 第二层：最小化 2 分钟无恢复 → 渲染进程 reload 回收（不可见无感）
 * - 第三层：关闭（隐藏到托盘）30 秒无活跃 → 销毁 BrowserWindow，内存只留主进程；
 *   托盘点击 / 二次启动时 ensureMainWindow 重建，秒开。
 *   （v2.4.5 T3：2 分钟 → 30 秒提速——30s 内回切零成本，超期重建由 v2.4.3 唤醒修复保障体验）
 *
 * v2.4.3 唤醒修复（docs/PLAN-v2.4.3.md，F1-F4 / F6）：
 * - F1 加载底色改浅色，唤醒重建期不再露出深蓝近黑空窗
 * - F2 重建窗口不提前 show，交给 ready-to-show（黑屏根因之一）
 * - F3 唤醒活性检查（ping）：渲染假死（非崩溃）自动 reload，解决"黑屏无唤醒机制"
 * - F4 最小化不可见 reload 后置标记，恢复时在可见状态再校验一次活性
 * - F6 休眠定时器支持 env 覆盖（QIHEBOX_DESTROY_DELAY_MS / QIHEBOX_MINIMIZE_RECOVER_MS）+ 唤醒路径日志
 */
import { BrowserWindow, app, powerMonitor, screen, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from './log'
import { isBlankFrameLike } from './core/frame'

let mainWindow: BrowserWindow | null = null
let quitting = false

// —— 分层休眠定时器 ——
// v2.4.3（F6）：支持 env 覆盖，验证/自查时缩到 10 秒跑完整休眠→唤醒循环
// v2.4.5（T3）：第三层默认 2 分钟 → 30 秒（托盘常驻内存快速回落；重建体验由 F1-F4 保障）
const DESTROY_DELAY_MS = Number(process.env.QIHEBOX_DESTROY_DELAY_MS) || 30 * 1000 // 第三层：隐藏后 30 秒销毁窗口
const MINIMIZE_RECOVER_MS = Number(process.env.QIHEBOX_MINIMIZE_RECOVER_MS) || 2 * 60 * 1000 // 第二层：最小化后 2 分钟渲染进程回收
const WAKE_PING_TIMEOUT_MS = 2000 // v2.4.3（F3）：渲染进程活性 ping 超时
let destroyTimer: NodeJS.Timeout | null = null
let minimizeRecoverTimer: NodeJS.Timeout | null = null
let reloadedWhileHidden = false // v2.4.3（F4）：最小化不可见 reload 标记
let wakePingInFlight = false // v2.4.3（F3）：活性检查互斥，避免并发 ping

// —— v2.4.7（评审 P2）：窗口状态记忆（userData/window-state.json）——
// 记录 bounds/maximized，启动时恢复；多显示器布局变化（拔屏等）导致越界时钳制回可视区
interface WindowState {
  x?: number
  y?: number
  width?: number
  height?: number
  maximized?: boolean
}

const WINDOW_STATE_FILE = 'window-state.json'
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 900
/** 越界判定：窗口与显示器可视区重叠小于此面积即视为不可见（拔屏/分辨率缩小场景） */
const MIN_VISIBLE_AREA = 100 * 40
let stateSaveTimer: NodeJS.Timeout | null = null
/** 最近一次普通态（非最大化）bounds——最大化期间 move/resize 不覆盖，恢复时不弹回最大化尺寸 */
let normalBounds: Electron.Rectangle | null = null

function windowStateFile(): string {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE)
}

function loadWindowState(): WindowState | null {
  try {
    const raw = fs.readFileSync(windowStateFile(), 'utf8')
    const s = JSON.parse(raw) as WindowState
    if (![s.x, s.y, s.width, s.height].every((v) => typeof v === 'number')) return null
    return s
  } catch {
    return null // 首次启动 / 文件损坏
  }
}

/** 多显示器越界钳制：完全不与任何显示器可视区重叠（拔屏/布局变化）→ 回主屏居中；尺寸超可视区（分辨率缩小）→ 收缩 */
function clampWindowState(s: WindowState): WindowState {
  const displays = screen.getAllDisplays()
  let best: Electron.Display | null = null
  let bestOverlap = 0
  for (const d of displays) {
    const wa = d.workArea
    const overlapW = Math.min(s.x! + s.width!, wa.x + wa.width) - Math.max(s.x!, wa.x)
    const overlapH = Math.min(s.y! + s.height!, wa.y + wa.height) - Math.max(s.y!, wa.y)
    const overlap = overlapW * overlapH
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = d
    }
  }
  if (!best || bestOverlap < MIN_VISIBLE_AREA) {
    // 越界（显示器被拔 / 布局变化）：回主屏可视区内居中，尺寸不超过可视区
    void log('warn', '[window] 上次窗口位置越界（显示器布局变化），回退主屏居中')
    const wa = screen.getPrimaryDisplay().workArea
    const width = Math.min(s.width!, wa.width)
    const height = Math.min(s.height!, wa.height)
    return {
      ...s,
      width,
      height,
      x: wa.x + Math.round((wa.width - width) / 2),
      y: wa.y + Math.round((wa.height - height) / 2),
    }
  }
  // 位置可见但尺寸超出可视区（分辨率缩小）→ 收缩到可视区
  const wa = best.workArea
  const width = Math.min(s.width!, wa.width)
  const height = Math.min(s.height!, wa.height)
  if (width === s.width && height === s.height) return s
  return { ...s, width, height }
}

function writeWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // 最大化/最小化时只落 maximized 标记，bounds 用最近一次普通态（恢复时不弹回最大化尺寸）
  const bounds = normalBounds ?? win.getBounds()
  const state: WindowState = { ...bounds, maximized: win.isMaximized() }
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(state))
  } catch (err) {
    void log('warn', `[window] 窗口状态保存失败: ${String(err)}`)
  }
}

function scheduleStateSave(win: BrowserWindow): void {
  if (stateSaveTimer) clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null
    writeWindowState(win)
  }, 500)
}

/** 立即落盘当前窗口状态（退出前调用：quit 走 destroy()，不触发 close 事件，防抖窗口内调整需显式刷新） */
export function flushWindowState(): void {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer)
    stateSaveTimer = null
  }
  if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow)
}

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
  // v2.4.7（评审 P2）：恢复上次窗口 bounds/maximized；越界（拔屏/布局变化）已钳制回可视区
  const loaded = loadWindowState()
  const saved: WindowState = loaded ? clampWindowState(loaded) : {}
  normalBounds =
    saved.x !== undefined && saved.y !== undefined
      ? { x: saved.x, y: saved.y, width: saved.width ?? DEFAULT_WIDTH, height: saved.height ?? DEFAULT_HEIGHT }
      : null
  mainWindow = new BrowserWindow({
    title: '启禾文件管理',
    width: saved.width ?? DEFAULT_WIDTH,
    height: saved.height ?? DEFAULT_HEIGHT,
    minWidth: 1024,
    minHeight: 720,
    // 仅当有历史记录才指定位置，否则交给系统窗口管理器默认摆放
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
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
      // v2.4.6：V8 code cache 落盘复用——降低启动/重建窗口时的重复编译 CPU 开销，内存轻微正收益
      v8CacheOptions: 'code',
    },
  })

  // v2.4.7（评审 P2）：上次是最大化 → 恢复最大化（show 前设置，避免先以普通尺寸闪现）
  if (saved.maximized) mainWindow.maximize()

  // v2.4.3（F2）：重建窗口只在这里 show+focus（渲染就绪才显示），windowShow 不再提前 show
  mainWindow.on('ready-to-show', () => {
    void log('info', '[wake] 窗口就绪（ready-to-show）')
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // v2.4.7（评审 P2）：窗口状态记忆——move/resize 防抖落盘；maximize/unmaximize/close 立即落盘
  mainWindow.on('resize', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (!win.isMaximized() && !win.isMinimized()) normalBounds = win.getBounds()
    scheduleStateSave(win)
  })
  mainWindow.on('move', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (!win.isMaximized() && !win.isMinimized()) normalBounds = win.getBounds()
    scheduleStateSave(win)
  })
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow)
  })
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow)
  })
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) writeWindowState(mainWindow)
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

// —— v2.4.7（F10）：系统休眠唤醒自愈（powerMonitor resume）——
// 背景：v2.4.3 只把加载底色从深蓝改浅色（黑屏→白屏），「窗口一直可见时休眠」的唤醒
// 场景没有任何自愈触发点（windowShow 只覆盖托盘/激活/二次启动路径）——系统 suspend 期间
// GPU 渲染表面在 Linux 上失效，resume 后画面空白（露出浅色底色），JS 仍响应（ping 检测不到）。
// 策略：resume 后延迟等渲染恢复，分层检查（比 F3 多一层「画面像素检测」，能抓到 ping 抓不到的
// 表面失效白屏；正常画面不打扰，保留用户状态）：
// - 渲染崩溃 → reload；加载中 → 交给 ready-to-show；最小化 → 交给 restore（F4 已覆盖）
// - 窗口不可见（用户隐藏到托盘）→ 不打扰，托盘点击自会恢复（评审 P1：不得强行弹出）
// - 可见窗口 → capturePage 截屏像素检测：接近加载底色/纯白（白屏）→ reload；正常 → 不动
// 判定逻辑在 core/frame.ts（纯函数，单测覆盖）。
let wakeRecoveryRegistered = false
let wakeRecoveryInFlight = false // 互斥：部分环境 resume 可能触发两次，避免并发 capturePage/双 reload
export function setupWakeRecovery(): void {
  if (wakeRecoveryRegistered) return
  wakeRecoveryRegistered = true
  powerMonitor.on('resume', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || quitting) return
    void log('info', '[wake] 系统休眠恢复（powerMonitor resume），启动自愈检查')
    // 等 GPU/渲染进程从系统挂起中恢复稳定（1.5s；过早检查 capturePage 会误判空白）
    setTimeout(() => {
      if (!win.isDestroyed() && !quitting && !wakeRecoveryInFlight) {
        void recoverAfterWake(win)
      }
    }, 1500)
  })
}

async function recoverAfterWake(win: BrowserWindow): Promise<void> {
  wakeRecoveryInFlight = true
  try {
    if (win.isDestroyed()) return
    if (win.isMinimized()) return // restore 路径已带 F4 活性检查
    const wc = win.webContents
    if (wc.isCrashed()) {
      void log('warn', '[wake] 渲染进程崩溃，reload 自愈')
      wc.reload()
      return
    }
    if (wc.isLoading()) {
      void log('info', '[wake] 渲染加载中，ready-to-show 兜底')
      return
    }
    if (!win.isVisible()) {
      // 用户主动隐藏到托盘（windowHideToTray）：不自行复活窗口，托盘点击路径会恢复
      void log('info', '[wake] 窗口隐藏于托盘，跳过自愈（托盘点击恢复）')
      return
    }
    // 画面自愈：截屏像素检测——GPU 表面失效时捕获为接近加载底色的空窗 → reload；正常 → 不打扰
    try {
      const img = await wc.capturePage()
      if (isBlankFrameLike(img)) {
        void log('warn', '[wake] 画面为空窗（渲染表面失效），reload 自愈')
        if (!win.isDestroyed()) wc.reload()
      } else {
        void log('info', '[wake] 画面捕获正常，无需干预')
      }
    } catch (e) {
      void log('warn', `[wake] 画面捕获异常，reload 自愈: ${String(e)}`)
      if (!win.isDestroyed()) wc.reload()
    }
  } finally {
    wakeRecoveryInFlight = false
  }
}

// —— 窗口控制（对照 app.go Window* 方法）——
export function windowHideToTray(): void {
  mainWindow?.hide()
  scheduleDestroy() // 第三层：隐藏后启动销毁倒计时
}

/** 第三层：隐藏（关闭到托盘）后 30 秒无活跃 → 销毁窗口（v2.4.5 T3：2 分钟 → 30 秒） */
export function scheduleDestroy(): void {
  destroyTimer = clearTimer(destroyTimer)
  void log('info', '[sleep] 已排定销毁倒计时（30 秒）')
  destroyTimer = setTimeout(() => {
    destroyTimer = null
    void log(
      'info',
      `[sleep] 倒计时到期: mainWindow=${!!mainWindow} destroyed=${mainWindow?.isDestroyed() ?? 'n/a'} quitting=${quitting} visible=${mainWindow?.isVisible() ?? 'n/a'}`,
    )
    // v2.4.x 修复：倒计时到期时窗口若已恢复显示（用户操作中），不得销毁——
    // 此前 windowShow 未取消倒计时，用户恢复窗口后继续操作会被强制销毁（界面突然消失）
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
  // v2.4.7（评审 P2）：退出前落盘窗口状态——destroy() 不触发 close 事件，防抖窗口内的最后调整也在此刷新
  flushWindowState()
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
