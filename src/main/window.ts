/**
 * 窗口管理（对照原 Go app.go 的窗口控制 + runtime.Window* 函数）
 * 主进程模块：负责无边框窗口创建与窗口控制 IPC 的实现。
 *
 * v2.3.0 分层休眠（最小化超时回收渲染进程 + 关窗到托盘倒计时销毁窗口）已于 v2.5.3 整体移除
 * （2026-08-18 用户拍板）：「不可见 reload / 销毁重建 + GPU 合成表面失效」的组合是历次白屏事故的
 * 总根因（v2.4.3/v2.4.7/v2.4.9/v2.5.2 多轮自愈链打补丁仍有漏网路径）——消除病因优先于自愈：
 * 关窗=仅隐藏到托盘、最小化不再回收，渲染进程常驻；托盘常驻内存相应上升（换可靠性，门禁基线改写）。
 *
 * v2.4.7（F10）系统休眠唤醒自愈：已按 v2.5.3 常驻轻壳设计（§4.4）收窄——旧的 L1→L2→L2.5→L3→L4
 * 分级链删除（L3 hide/show 曾扰动窗口映射且有窗口消失事故证据）；崩溃/无响应/双 token 明确失败
 * 才在隐藏态 L2 reload / L4 重建，验证通过才显示；unknown 全程不升级（原生重试/退出）。
 * JS ping 只作 Renderer 活性证据，不作画面通过证据（画面以 FrameWitness 新鲜帧验证为准）。
 *
 * v2.5.3（2026-08-18 真机白屏事故：最小化过夜→早晨恢复白屏常驻，日志仅「活性检查: ok」）：
 * - restore 路径统一补 settle 后 recoverAfterWake（L1→L4 像素级自愈链，正常画面仅一次无害重绘）——
 *   原仅 JS ping（结构性看不到 GPU 表面失效白屏，见下方自愈链背景）；本修复后被分层休眠移除方案吸收
 * - onWakeSignal 无窗早退补观测日志（区分「轮询未检测」与「窗口已销毁」）
 *
 * v2.5.3 常驻轻壳 T4（2026-08-18）：系统暂停/恢复统一入口 + 单时钟保险 + 崩溃接入状态机——
 * - suspend/lock-screen/时钟检测 → 暂停前可见则立即隐藏 + parking；resume/unlock-screen/广播
 *   仅「暂停前可见」才走隐藏预检恢复（wasVisibleBeforeSystemPause 语义，设计 §4.4 系统睡眠）
 * - Windows WM_POWERBROADCAST(0x0218) hookWindowMessage 解析（parsePowerBroadcast + WakeSignalGate
 *   交叉信号去重，同一恢复会话 resume 只放行一次；窗口销毁 unhook）
 * - 单时钟保险：单个可重排 .unref() timeout，可见 1s / 隐藏 30s（替代 v2.5.2 固定 30s interval）
 * - render-process-gone / unresponsive → 状态机（visible 先 hide 再隐藏态 reload；预检通过才显示）
 */
import { BrowserWindow, app, powerMonitor, screen, shell, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from './log'
import { classifyFrameWitness, type WitnessGridLayout, type WitnessVerdict } from './core/frame'
import { isSuspectedWake, parsePowerBroadcast, WakeSignalGate } from './core/wake'
import { WindowLifecycle, type HideSource } from './core/windowLifecycle'
import { writeJsonAtomic } from './core/paths'
import {
  WITNESS_GRID_N,
  WITNESS_CELL_DIP,
  WITNESS_GAP_DIP,
  WITNESS_GRID_X,
  WITNESS_GRID_Y,
  type WindowFirstFrameAckMessage,
  type WindowHideSource,
  type WindowParkedAckMessage,
  type WindowPrepareHideMessage,
  type WindowPrepareShowMessage,
  type WindowRestoredMessage,
  type WindowShowSource,
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let quitting = false

const WAKE_PING_TIMEOUT_MS = 2000 // v2.4.3（F3）：渲染进程活性 ping 超时
let wakePingInFlight = false // v2.4.3（F3）：活性检查互斥，避免并发 ping

// —— v2.5.3 常驻轻壳：窗口生命周期状态机（T1 实现于 core/windowLifecycle.ts）——
// 适配层：事件 → 状态机 → 动作列表执行；show/hide 前必经状态机（冷启动双闸门 / 隐藏预检链）。
const lifecycle = new WindowLifecycle()

/** FrameWitness 网格布局（DIP，渲染层 App.tsx 同锚点 WITNESS_GRID_X/Y；capturePage rect 用） */
function witnessGridLayout(): WitnessGridLayout {
  const gridW = WITNESS_GRID_N * WITNESS_CELL_DIP + (WITNESS_GRID_N - 1) * WITNESS_GAP_DIP
  // capturePage rect 略大于网格本体（含容差边距），避免采样边缘
  const pad = 8
  return {
    rect: { x: WITNESS_GRID_X - pad, y: WITNESS_GRID_Y - pad, width: gridW + pad * 2, height: gridW + pad * 2 },
    n: WITNESS_GRID_N,
    cell: WITNESS_CELL_DIP,
    gap: WITNESS_GAP_DIP,
    originX: WITNESS_GRID_X,
    originY: WITNESS_GRID_Y,
  }
}

/** 预检链辅助（T3 骨架：首个 token 验证一次；T4 扩展：L1 invalidate 前置、capturePage 有界等待、
 *  unknown 走 frame-subscription 兜底、ACK 超时两次有界 JS ping——设计 §4.4/§六） */
let firstFramePending: { generation: number; resolve: (ok: boolean) => void } | null = null
const FIRST_FRAME_ACK_TIMEOUT_MS = 500 // 设计 §六：FIRST_FRAME_ACK 有界等待
const CAPTURE_TIMEOUT_MS = 250 // 设计 §六：单次 capturePage / frame subscription 有界等待
const JS_PING_TIMEOUT_MS = 2000 // 有界 JS ping 超时（活性证据；沿用 v2.4.3 F3 的 WAKE_PING_TIMEOUT_MS 语义）
/** v2.5.3 L2 恢复链：invalidate 重绘完成等待（stale/blank 重捕前）。渲染器一帧 ~16ms，取 50ms 稳妥 */
const FRAME_SETTLE_MS = 50
/** v2.5.3 L2 恢复链：capture 超时后等待渲染器合成就绪再重试（崩溃 reload 后新进程 GPU 未就绪） */
const CAPTURE_RETRY_WAIT_MS = 200
/** v2.5.3 健康轮修复（2026-08-18 探针实证）：快速 hide/show 循环 ~15 轮后合成器「冷却」，
 *  capturePage(stayHidden) 从 22-61ms 变 1.7-2.7s（冷启动重合成；长时间隐藏后恢复实测正常）。
 * 首次 capture 仍用 250ms 快速探测（健康快路径不受影响）；unknown 重试与 stale/blank 重捕
 * 用本长超时——慢合成可在窗口内完成（match），真死（崩溃后 8s 10 次全挂）超时后走既有升级链 */
const CAPTURE_RETRY_TIMEOUT_MS = 3000

/** 有界等待（异步工具；timer.unref 不挂事件循环） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref()
  })
}
const JS_PING_ROUNDS = 2 // 设计 §六：两次有界 JS ping 均超时才判定确认无响应

// —— 背景节流引用计数（T4：双 token 重试会嵌套启动第二个 precheck）——
// 嵌套 precheck 若各自「恢复为进入时的值」，内层 finally 会把外层关闭的节流重新打开（隐藏态 rAF
// 被节流 → 渲染层画不出网格 → ACK 缺失）；引用计数保证只有最外层退出时才恢复原始值。
let precheckThrottleDepth = 0
let precheckThrottleOriginal: boolean | null = null

function enterPrecheck(win: BrowserWindow): void {
  if (precheckThrottleDepth === 0) {
    precheckThrottleOriginal = win.webContents.getBackgroundThrottling()
    win.webContents.setBackgroundThrottling(false)
  }
  precheckThrottleDepth += 1
}

function exitPrecheck(win: BrowserWindow): void {
  precheckThrottleDepth = Math.max(0, precheckThrottleDepth - 1)
  if (precheckThrottleDepth === 0 && precheckThrottleOriginal !== null && !win.isDestroyed()) {
    if (win.webContents.getBackgroundThrottling() !== precheckThrottleOriginal) {
      win.webContents.setBackgroundThrottling(precheckThrottleOriginal)
    }
    precheckThrottleOriginal = null
  }
}

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

async function writeWindowState(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  // 最大化/最小化时只落 maximized 标记，bounds 用最近一次普通态（恢复时不弹回最大化尺寸）
  const bounds = normalBounds ?? win.getBounds()
  const state: WindowState = { ...bounds, maximized: win.isMaximized() }
  // v2.5.3（P2-16a）：改走 jsonStore 原子写（tmp+rename）——writeFileSync 直接覆盖在写盘中断时
  // 可能截断 window-state.json（下次启动状态恢复失效）；durable:false 不 fsync（高频防抖写，够用）
  try {
    await writeJsonAtomic(windowStateFile(), state, { durable: false })
  } catch (err) {
    void log('warn', `[window] 窗口状态保存失败: ${String(err)}`)
  }
}

function scheduleStateSave(win: BrowserWindow): void {
  if (stateSaveTimer) clearTimeout(stateSaveTimer)
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null
    void writeWindowState(win)
  }, 500)
}

/** 立即落盘当前窗口状态（退出前调用：quit 走 destroy()，不触发 close 事件，防抖窗口内调整需显式刷新） */
export async function flushWindowState(): Promise<void> {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer)
    stateSaveTimer = null
  }
  if (mainWindow && !mainWindow.isDestroyed()) await writeWindowState(mainWindow)
}

/** 窗口重建钩子（index.ts 注册 setupCrashRecovery / setupCloseToTray） */
let onCreateHandler: ((win: BrowserWindow) => void) | null = null

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

/** 确保主窗口存在（首次启动前为 null；v2.5.3 起窗口不再被休眠销毁，此后恒存在），并执行窗口初始化钩子 */
export function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  void log('info', '[wake] 窗口不存在，创建中')
  const win = createMainWindow()
  onCreateHandler?.(win)
  return win
}

export function createMainWindow(): BrowserWindow {
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
    // v2.5.3 常驻轻壳（设计 §4.1）：禁用系统最小化（Windows）——最小化统一走 TitleBar 入口
    // 归一化为隐藏到托盘（渲染常驻，不 minimize 不销毁）；Linux 系统旁路经 minimize 事件兜底
    minimizable: false,
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

  // v2.4.3（F2）+ v2.5.3 常驻轻壳：ready-to-show 不再无条件 show——冷启动双闸门
  // （ready-to-show 与初始 first-frame-ack 齐备才首次 show，starting 态由状态机裁决；
  //  L4 重建后 recovering 态：ready-to-show → 状态机重新发 prepare-show 走 FrameWitness 预检）
  mainWindow.on('ready-to-show', () => {
    void log('info', '[wake] 窗口就绪（ready-to-show），交状态机裁决')
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    executeLifecycleActions(win, lifecycle.handle({ type: 'ready-to-show' }))
  })

  mainWindow.on('closed', () => {
    // Windows 电源广播 hook 随窗口销毁解除（设计 §4.4 系统睡眠第 1 条）
    if (process.platform === 'win32' && mainWindow) {
      try {
        mainWindow.unhookWindowMessage(0x0218)
      } catch {
        /* 已解除/平台不支持，静默 */
      }
    }
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
    if (mainWindow && !mainWindow.isDestroyed()) void writeWindowState(mainWindow)
    // v2.5.2（打磨）：最大化态广播——TitleBar 图标同步（双击标题栏/Win+方向键等系统路径不经 toggleMaximize IPC）
    sendMaximizedChanged(true)
  })
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) void writeWindowState(mainWindow)
    sendMaximizedChanged(false)
  })
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) void writeWindowState(mainWindow)
  })

  // v2.5.3 常驻轻壳（设计 §4.1）：最小化统一归一化为「隐藏到托盘」——系统旁路（Linux WM
  // 任务栏 / Win 快捷键等不经 TitleBar IPC 的 minimize 事件）→ 立即 hide 归一化；
  // Windows 经 minimizable:false 禁用系统最小化，TitleBar windowMinimize 为唯一入口。
  mainWindow.on('minimize', () => {
    const win = mainWindow
    if (!win || win.isDestroyed() || quitting) return
    void log('info', '[window] 系统最小化旁路 → 归一化隐藏到托盘')
    requestHide('minimize')
  })

  // v2.5.3（取消分层休眠）：最小化不再回收渲染进程——「不可见 reload + GPU 表面失效」组合是
  // 历次白屏总根因，消除病因优先于自愈（2026-08-18 用户拍板，见文件头）。
  // v2.5.3 T4：restore 只做最小化状态归一化，不是显示入口（设计 §4.4 系统睡眠第 6 条）——
  // 系统旁路最小化（Linux WM/Alt+F9）已由 minimize 事件归一化为隐藏；真正恢复只允许
  // 托盘/二次启动/activate/wake 经状态机 SHOW_REQUESTED 并过隐藏预检。旁路 restore 到达时
  // 若窗口意外可见（WM 直接恢复隐藏窗口），立即 hide 保持隐藏，不显示不预检。
  mainWindow.on('restore', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const s = lifecycle.state()
    if (s !== 'visible' && win.isVisible()) {
      void log('info', '[window] 系统 restore 旁路 → 保持隐藏（恢复只走状态机预检入口）')
      win.hide()
    } else {
      void log('info', '[window] 系统 restore 旁路（visible/已隐藏），无需动作')
    }
  })

  // v2.5.3 T4：渲染进程无响应（事件循环阻塞确认）→ 交状态机（visible 先 hide 再隐藏态 reload；
  // 无响应证据只允许一次 L2，恢复经 FrameWitness 预检，设计 §4.4 故障升级）
  mainWindow.webContents.on('unresponsive', () => {
    void log('warn', '[window] 渲染进程无响应（unresponsive），交状态机恢复')
    notifyRendererUnresponsive()
  })

  // v2.5.3 T4：Windows WM_POWERBROADCAST（0x0218）原生广播监听——powerMonitor 在 Windows
  // 从不触发 suspend/resume（electron#32576，2026-08-16 实测），原生 hook 为主入口；
  // 非 Windows 平台挂载无害（WM_POWERBROADCAST 仅 Windows 投递）。wParam 为 native 值 Buffer
  // （parsePowerBroadcast 取低 32 位）；与 powerMonitor 交叉信号经 WakeSignalGate 去重
  // （同一恢复会话 resume 只放行一次，设计 §4.4 系统睡眠第 2 条）。
  if (process.platform === 'win32') {
    mainWindow.hookWindowMessage(0x0218, (wParam) => {
      const kind = parsePowerBroadcast(wParam)
      const gen = lifecycle.generation()
      if (!wakeGate.shouldDispatch(gen, kind)) return
      if (kind === 'suspend') onSystemPause('WM_POWERBROADCAST')
      else if (kind === 'resume') onSystemResume('WM_POWERBROADCAST')
    })
  }

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
// 渲染假死（不触发 render-process-gone）时自动重建；每次唤醒（windowShow / 最小化恢复）调用。
async function pingRenderer(win: BrowserWindow): Promise<void> {
  if (wakePingInFlight || win.isDestroyed() || win.isMinimized()) return
  const wc = win.webContents
  if (wc.isCrashed()) {
    void log('warn', '[wake] 渲染进程已崩溃，重建恢复')
    reloadRenderer(win)
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
    void log('info', `[wake] 活性检查: ${ok ? 'ok' : '超时/无响应，重建渲染层'}`)
    if (!ok && !win.isDestroyed()) reloadRenderer(win)
  } catch (e) {
    void log('warn', `[wake] 活性检查异常: ${String(e)}`)
    if (!win.isDestroyed()) reloadRenderer(win)
  } finally {
    if (timer) clearTimeout(timer)
    wakePingInFlight = false
  }
}

/**
 * 渲染层重建（v2.5.3 T5 修复）：必须回 index.html，不能 wc.reload()——
 * 生产模式 file:// 下 SPA 路由（history.pushState）会把文档 URL 改成 file:///<route>，
 * 直接 reload() 会加载不存在的路径 → chrome-error://chromewebdata/ 死页（渲染层挂、JS ping
 * 却正常 → 恢复链卡死）。dev 模式回 dev server URL。
 */
function reloadRenderer(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.webContents.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// —— v2.5.3 常驻轻壳（T4）：系统暂停/恢复统一入口 + 单时钟保险（设计 §4.4 系统睡眠）——
// 背景：v2.4.3 起「窗口可见时休眠→唤醒白屏」依赖 powerMonitor + 分级自愈链（L1→L4）事后修复；
// v2.4.8 实证 powerMonitor resume 在 Windows 从不触发（electron#32576），v2.5.2 加 30s 轮询兜底。
// 常驻轻壳方案改「事前规避」：暂停/锁屏信号到达即隐藏窗口（渲染常驻），唤醒后仅在隐藏态
// 走 FrameWitness 新鲜帧预检，验证通过才显示——不再有「可见态画面失效后补救」的路径。
// 旧的 L1→L2→L2.5→L3→L4 分级自愈链整体删除（L3 hide/show 曾扰动窗口映射且有窗口消失事故证据）；
// JS ping 只作 Renderer 活性证据，不作画面通过证据（设计 §4.4）。

/** 暂停/锁屏前窗口可见 → 唤醒后自动走隐藏预检恢复；原本在托盘 → 唤醒后不得自行显示 */
let wasVisibleBeforeSystemPause = false
/** Windows 原生广播与 powerMonitor 交叉信号去重（同一恢复会话 resume 只放行一次） */
const wakeGate = new WakeSignalGate()

/**
 * 系统暂停统一入口（WM_POWERBROADCAST suspend / powerMonitor suspend / lock-screen / 时钟检测）：
 * 暂停前可见 → 立即同步隐藏（防睡眠瞬间 GPU 表面残留）+ 状态机 parking（prepare-hide 卸载重资源）；
 * 原本已在托盘 → 保持隐藏，唤醒后不自行显示（设计 §4.4 系统睡眠第 3 条）。
 */
function onSystemPause(source: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) {
    if (!quitting) void log('info', `[wake] 系统暂停（${source}）时无窗口，跳过`)
    return
  }
  wakeGate.reset() // 新暂停会话开始：允许本次唤醒的 resume 放行（同代多次暂停/恢复也正确）
  wasVisibleBeforeSystemPause = win.isVisible()
  if (!wasVisibleBeforeSystemPause) {
    void log('info', `[wake] 系统暂停（${source}），窗口原本在托盘，保持隐藏不动作`)
    return
  }
  void log('info', `[wake] 系统暂停（${source}），窗口可见 → 立即隐藏 + 卸载重资源（wasVisibleBeforeSystemPause=true）`)
  win.hide() // 同步隐藏，不等 IPC（睡眠瞬间画面不留残）
  executeLifecycleActions(win, lifecycle.handle({ type: 'hide-requested', source: 'system-pause' }))
}

/**
 * 系统唤醒统一入口（WM_POWERBROADCAST resume / powerMonitor resume / unlock-screen / 时钟检测）：
 * 仅「暂停前可见」才自动走隐藏预检恢复（FrameWitness 验证通过才 show）；原本在托盘不自行显示。
 */
function onSystemResume(source: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) return
  if (!wasVisibleBeforeSystemPause) {
    void log('info', `[wake] 系统唤醒（${source}），窗口原本在托盘/未记录暂停前可见，不自行显示`)
    return
  }
  wasVisibleBeforeSystemPause = false
  void log('info', `[wake] 系统唤醒（${source}），隐藏预检恢复（FrameWitness）`)
  executeLifecycleActions(win, lifecycle.handle({ type: 'show-requested', source: 'wake' }))
}

// —— 单时钟保险（设计 §4.4 系统睡眠第 4 条）——
// 单个可重排 .unref() timeout：窗口可见每 1s、隐藏每 30s 比较 Date.now()；系统睡眠时进程被冻结，
// 唤醒后首个 tick 的 Δ 突跳（> 间隔×3）即判定刚经历睡眠。检测到可见态长间隔 → 先同步隐藏，
// 再按「系统暂停前可见」处理（走隐藏预检恢复）。任一时刻仅一个 timeout；隐藏间隔 env 可覆盖
// （QIHEBOX_WAKE_POLL_MS，同 v2.5.2 惯例）。
const CLOCK_VISIBLE_MS = 1000
const CLOCK_HIDDEN_MS = Number(process.env.QIHEBOX_WAKE_POLL_MS) || 30 * 1000
let clockTimer: NodeJS.Timeout | null = null
let clockLastAt = Date.now()
let clockIntervalMs = CLOCK_HIDDEN_MS // 启动首轮按隐藏间隔（窗口未建）

/** 重排单时钟：先清旧再设新（任一时刻仅一个）；窗口可见 1s / 隐藏 30s；.unref() 不持事件循环 */
function scheduleClockCheck(): void {
  if (clockTimer) clearTimeout(clockTimer)
  const win = getMainWindow()
  const visible = !!win && !win.isDestroyed() && win.isVisible()
  clockIntervalMs = visible ? CLOCK_VISIBLE_MS : CLOCK_HIDDEN_MS
  clockTimer = setTimeout(() => {
    clockTimer = null
    clockTick(Date.now())
    scheduleClockCheck() // 每 tick 后按当前可见性重排
  }, clockIntervalMs)
  clockTimer.unref()
}

/** 单次时钟 tick：Δ > 间隔×3 判定刚经历系统睡眠（isSuspectedWake）→ 按暂停前可见处理 */
export function clockTick(now: number = Date.now()): void {
  const delta = now - clockLastAt
  clockLastAt = now
  if (!isSuspectedWake(delta, clockIntervalMs)) return
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) return
  void log('info', `[wake] 时钟检测到系统休眠恢复（Δ=${delta}ms，间隔=${clockIntervalMs}ms）`)
  if (win.isVisible()) {
    // 可见态长间隔：先同步隐藏，再按「暂停前可见」走完整恢复链（隐藏预检通过才显示）
    onSystemPause('clock-guard')
    onSystemResume('clock-guard')
  } else {
    // 隐藏态长间隔：无画面风险，仅观测日志（排查「信号未触发」与「无信号」）
    void log('info', '[wake] 时钟检测（隐藏态长间隔），无画面风险，仅记录')
  }
}

let wakeRecoveryRegistered = false

export function setupWakeRecovery(): void {
  if (wakeRecoveryRegistered) return
  wakeRecoveryRegistered = true
  // powerMonitor 交叉信号（Windows/Linux 同挂；Windows 主入口是 WM_POWERBROADCAST，此处为交叉）
  powerMonitor.on('suspend', () => onSystemPause('powerMonitor suspend'))
  powerMonitor.on('lock-screen', () => onSystemPause('lock-screen'))
  powerMonitor.on('resume', () => onSystemResume('powerMonitor resume'))
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'))
  // 单时钟保险：单 timeout（.unref()），可见 1s / 隐藏 30s，任一时刻仅一个
  clockLastAt = Date.now()
  scheduleClockCheck()
  // e2e 探针：wake-recovery.spec.ts 伪造时钟跳变触发时钟自愈（QIHEBOX_E2E 门控，同 setupCloseToTray 惯例）
  if (process.env.QIHEBOX_E2E === '1') {
    ;(globalThis as { __wakePollTick?: (now?: number) => void }).__wakePollTick = (now?: number) => clockTick(now ?? Date.now())
    // 故障注入：直接喂 witness 判定（token 缺省用当前 token；传错 token 可验证「旧 token 丢弃」，
    // window-lifecycle.spec.ts 用）
    ;(globalThis as { __injectWitnessVerdict?: (v: WitnessVerdict, token?: number) => void }).__injectWitnessVerdict = (
      v: WitnessVerdict,
      token?: number,
    ) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        executeLifecycleActions(win, lifecycle.handle({ type: 'witness', verdict: v, token: token ?? lifecycle.token() }))
      }
    }
  }
}

// —— v2.5.3 T4：崩溃/无响应 → 状态机（index.ts setupCrashRecovery 与 unresponsive 监听调用）——
// visible 态：先 hide 再隐藏态 reload（状态机裁决）；presenting/recovering：走既有升级链。
export function notifyRendererGone(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'renderer-gone' }))
}

export function notifyRendererUnresponsive(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'renderer-unresponsive' }))
}

// —— 窗口控制（对照 app.go Window* 方法）——
// —— v2.5.3 常驻轻壳：hide/show 一律经状态机裁决（发 prepare-hide/show + 预检链）——

/** 状态机 hide 入口：visible → parking（发 prepare-hide + hide）；窗口不存在则直接隐藏 */
function requestHide(source: HideSource): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'hide-requested', source }))
  scheduleClockCheck() // 单时钟按可见性重排：隐藏 30s（省电）
}

/**
 * 状态机 show 入口：parked/parking → presenting（发 prepare-show + FrameWitness 预检链）；
 * 起始态（窗口从未显示）→ ensureMainWindow 后交冷启动双闸门，不提前 show。
 */
export function windowShow(): void {
  const win = ensureMainWindow()
  if (win.isDestroyed()) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'show-requested', source: 'tray' }))
}

export function windowHideToTray(): void {
  requestHide('close')
}

/** v2.5.3：最小化统一归一化为隐藏到托盘（TitleBar 唯一入口；渲染常驻不 minimize） */
export function windowMinimize(): void {
  requestHide('minimize')
}

/** v2.5.3 L4 重建标志：destroyAndRebuild 销毁窗口到新窗口构造完成前，阻止 window-all-closed 退出
 *  （e2e 下不注册空监听会默认退出；此标志 + getMainWindow 检查双保险，2026-08-18 定案） */
export let l4Rebuilding = false

// —— v2.5.3 常驻轻壳：生命周期动作执行（状态机 → Electron 适配）——

/** 执行状态机返回的动作列表（show/hide/send/invalidate/reload/destroyAndRebuild/notify） */
function executeLifecycleActions(win: BrowserWindow, actions: ReturnType<WindowLifecycle['handle']>): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'show':
        // 状态机裁决通过（match / 冷启动双闸门齐备）→ 真正 show+focus；
        // source 区分冷启动（startup，不发 restored）与恢复（restore，发 restored 回首页）
        showWindowNow(win, a.source)
        break
      case 'hide':
        win.hide()
        void log('info', '[window] 已隐藏到托盘（渲染常驻）')
        break
      case 'invalidate':
        win.webContents.invalidate()
        break
      case 'reload':
        void log('warn', '[window] L2 reload 渲染进程（双 token 明确失败）')
        reloadRenderer(win)
        break
      case 'destroyAndRebuild':
        void log('warn', '[window] L4 销毁重建窗口（升级链触顶）')
        l4Rebuilding = true
        win.destroy()
        ensureMainWindow()
        // window-all-closed 在 destroy 完成后异步派发；100ms 后清除重建标志（新窗口已构造，
        // getMainWindow 检查兜底；100ms 足够事件派发与窗口构造）
        setTimeout(() => {
          l4Rebuilding = false
        }, 100)
        break
      case 'notifyRetryOrQuit':
        void showRecoveryDialog()
        break
      case 'send':
        if (a.channel === 'window:prepare-hide') sendPrepareHide(win, a.generation, a.source as WindowHideSource)
        else if (a.frameToken !== undefined)
          sendPrepareShow(win, a.generation, a.source as Exclude<WindowShowSource, 'startup'>, a.frameToken)
        else
          void log('warn', `[window] prepare-show 缺 frameToken（gen=${a.generation}），跳过预检`)
        break
    }
  }
}

/** show+focus 并通知渲染层 restored（带 generation）；加载中延迟到 did-finish-load 再发。
 *  source=startup（冷启动首显）不发 restored：冷启动无「恢复业务层」语义，渲染层初始业务层
 *  已挂载，由 v2.3.0 lastRoute 恢复逻辑决定初始路由；发 restored 会触发渲染层 navigate('/')，
 *  造成「冷启动恢复上次页面」失效 + SPA URL 被改写（P0，2026-08-18 验收定案）。 */
function showWindowNow(win: BrowserWindow, source: 'startup' | 'restore'): void {
  if (win.isDestroyed() || quitting) return
  win.show()
  win.focus()
  void pingRenderer(win)
  scheduleClockCheck() // 单时钟按可见性重排：可见 1s（系统睡眠检测即时生效）
  const sendRestored = () => {
    if (win.isDestroyed() || quitting) return
    const msg: WindowRestoredMessage = { generation: lifecycle.generation() }
    try {
      win.webContents.send('qihebox:event:window:restored', msg)
    } catch {
      /* 窗口销毁竞态，静默 */
    }
  }
  if (source === 'startup') return // 冷启动首显不发 restored
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', sendRestored)
  } else {
    sendRestored()
  }
}

/** 发 prepare-hide（渲染层卸载重资源）；1s 未收 parked-ack 仅 warn（不销毁不 reload） */
function sendPrepareHide(win: BrowserWindow, generation: number, source: HideSource): void {
  const msg: WindowPrepareHideMessage = { generation, source, sentAt: Date.now() }
  try {
    win.webContents.send('qihebox:event:window:prepare-hide', msg)
  } catch {
    /* 渲染层不可用（崩溃/加载中）：hide 仍照常（窗口已隐藏，恢复预检兜底） */
  }
  const t = setTimeout(() => {
    if (!win.isDestroyed() && !quitting && lifecycle.state() === 'parking') {
      void log('warn', `[window] prepare-hide 后 1s 未收到 parked-ack（generation=${generation}），强制归 parked`)
      executeLifecycleActions(win, lifecycle.handle({ type: 'parked-ack', generation }))
    }
  }, 1000)
  t.unref()
}

/** 发 prepare-show 并启动 FrameWitness 预检链（T4：ACK 有界等待 → L1 invalidate → 有界 capturePage → 兜底） */
function sendPrepareShow(win: BrowserWindow, generation: number, source: Exclude<WindowShowSource, 'startup'>, frameToken: number): void {
  const msg: WindowPrepareShowMessage = { generation, source, sentAt: Date.now(), frameToken }
  try {
    win.webContents.send('qihebox:event:window:prepare-show', msg)
  } catch {
    void log('warn', `[window] prepare-show 发送失败（generation=${generation}）`)
  }
  void runShowPrecheck(win, generation, frameToken)
}

/**
 * 隐藏预检链（设计 §4.4/§六）：关关节流 → 等 first-frame-ack（500ms；超时 → 两次有界 JS ping，
 * 均失败判定确认无响应 → reload；任一正常 → 协议 unknown 弹重试/退出）→ L1 invalidate →
 * capturePage(stayHidden, 250ms) → classify → unknown 时 frame-subscription 兜底（250ms，成对 end）
 * → 喂回状态机 witness。日志带 generation/证据分类/尝试次数/耗时（设计 §4.4 第 5 条）。
 */
async function runShowPrecheck(win: BrowserWindow, generation: number, token: number): Promise<void> {
  // 恢复期间关闭背景节流：隐藏态渲染进程默认节流 rAF，FrameWitness 网格与 first-frame-ack 依赖
  // rAF 驱动——不关闭则渲染层「画不出新帧」（设计 §4.3 预检链；引用计数，最外层退出才恢复）
  enterPrecheck(win)
  const t0 = performance.now()
  try {
    const ackOk = await waitForFirstFrameAck(generation, FIRST_FRAME_ACK_TIMEOUT_MS)
    if (win.isDestroyed() || quitting) return
    if (!ackOk) {
      // ACK 缺失：两次有界 JS ping——活性证据正常则协议 unknown（不升级，弹重试/退出）；
      // 两次均超时 → RENDERER_UNRESPONSIVE_CONFIRMED（隐藏态一次 L2 reload，设计 §六）
      void log('warn', `[window] first-frame-ack 超时（generation=${generation}），执行两次有界 JS ping`)
      const pingOk = await boundedJsPing(win)
      if (win.isDestroyed() || quitting) return
      if (!pingOk) {
        void log('warn', `[window] 两次 JS ping 均超时 → RENDERER_UNRESPONSIVE_CONFIRMED（gen=${generation}，L2 reload）`)
        executeLifecycleActions(win, lifecycle.handle({ type: 'renderer-unresponsive' }))
        return
      }
      void log('warn', `[window] ACK 缺失但 JS 正常 → 生命周期协议 unknown（gen=${generation}），弹重试/退出（不 reload）`)
      executeLifecycleActions(win, lifecycle.handle({ type: 'witness', verdict: 'unknown', token }))
      return
    }
    // ACK 齐备：L1 invalidate 全量重绘（设计 §4.4 托盘恢复第 2 条），再做隐藏新鲜帧预检
    win.webContents.invalidate()
    let img = await capturePageBounded(win)
    if (win.isDestroyed() || quitting) return
    let verdict = img ? classifyFrameWitness(img, token, witnessGridLayout()) : 'unknown'
    // v2.5.3 L2 恢复链修复（2026-08-18 定案）：capturePage(stayHidden) 返回渲染器「最后提交的帧」
    // （缓存帧）。stale = 帧有内容但 token 不匹配（重绘延迟缓存帧）——等待一帧重绘时间后重捕；
    // blank = 空帧：presenting 态（健康/托盘恢复）为「真空白」，按原语义升级（不掩盖注入的
    // 双 blank 判定）；recovering 态（崩溃/故障 reload 后）为「新渲染进程尚未提交任何帧」的
    // 缓存空白——重捕等网格提交。重捕结果仍失败才走既有升级链。健康路径多数首次即 match。
    const needRecapture = verdict === 'stale' || (verdict === 'blank' && lifecycle.state() === 'recovering')
    if (needRecapture) {
      await sleep(FRAME_SETTLE_MS)
      if (win.isDestroyed() || quitting) return
      // 重捕用长超时：合成器冷却场景（快速切换后）capture 需 1.7-2.7s 冷启动完成
      const img2 = await capturePageBounded(win, CAPTURE_RETRY_TIMEOUT_MS)
      if (win.isDestroyed() || quitting) return
      if (img2) {
        const v2 = classifyFrameWitness(img2, token, witnessGridLayout())
        if (v2 === 'match' || v2 !== 'unknown') verdict = v2
      }
      void log('info', `[window] FrameWitness 重捕（gen=${generation} ${verdict}，state=${lifecycle.state()}）`) // 升级链观测
    }
    if (verdict === 'unknown') {
      // v2.5.3 L2 恢复链修复（2026-08-18 定案）：崩溃/故障 reload 后新渲染进程的 GPU 合成器
      // 尚未就绪，capturePage(stayHidden) 会挂起至超时（null）。等待合成就绪后重试一次——
      // 重试用长超时（3s）：健康轮快速切换 ~15 轮后合成器冷却、capture 慢至 1.7-2.7s
      // （探针实证 2026-08-18），长窗口内可完成（match）；崩溃后真死场景重试仍超时 → 走
      // frame-subscription 兜底（250ms 有界）→ unknown 升级链。
      await sleep(CAPTURE_RETRY_WAIT_MS)
      if (win.isDestroyed() || quitting) return
      const imgRetry = await capturePageBounded(win, CAPTURE_RETRY_TIMEOUT_MS)
      if (win.isDestroyed() || quitting) return
      if (imgRetry) {
        const vRetry = classifyFrameWitness(imgRetry, token, witnessGridLayout())
        if (vRetry !== 'unknown') verdict = vRetry
      }
      void log('info', `[window] FrameWitness capture 重试（gen=${generation} → ${verdict}）`) // 升级链观测
      if (verdict === 'unknown') {
        // 截图故障/畸形/超时：frame-subscription 兜底（成对 end；仍 unknown 不升级）。
        // 超时按状态区分：presenting 长超时（合成器冷却时 sub 慢至秒级，3s 内取真帧）；
        // recovering 保持 250ms 快速失败（崩溃后合成器真死，快速升级 L4）
        const subTimeout = lifecycle.state() === 'recovering' ? CAPTURE_TIMEOUT_MS : CAPTURE_RETRY_TIMEOUT_MS
        verdict = (await captureViaFrameSubscription(win, token, subTimeout)) ?? 'unknown'
        if (win.isDestroyed() || quitting) return
      }
    }
    const ms = performance.now() - t0
    void log('info', `[window] FrameWitness 验证（gen=${generation} token=${token} 尝试=${lifecycle.failedStreak() + 1} 耗时=${ms.toFixed(0)}ms）→ ${verdict}`)
    executeLifecycleActions(win, lifecycle.handle({ type: 'witness', verdict, token }))
  } catch (err) {
    // 捕获链异常（API 故障）：unknown——不升级 L2/L4，弹原生重试/退出（设计 §4.4 故障升级）
    void log('warn', `[window] 预检异常: ${String(err)} → unknown（不升级）`)
    executeLifecycleActions(win, lifecycle.handle({ type: 'witness', verdict: 'unknown', token }))
  } finally {
    // 恢复背景节流设置（引用计数：仅最外层 precheck 退出时恢复原始值；帧订阅已由
    // captureViaFrameSubscription 成对 end）
    exitPrecheck(win)
  }
}

/** 两次有界 JS ping（活性证据，非画面证据；设计 §六）：任一成功返回 true */
async function boundedJsPing(win: BrowserWindow): Promise<boolean> {
  for (let round = 1; round <= JS_PING_ROUNDS; round++) {
    let timer: NodeJS.Timeout | null = null
    try {
      const ok = await Promise.race([
        win.webContents.executeJavaScript('document.readyState === "complete"', true).catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), JS_PING_TIMEOUT_MS)
          timer.unref()
        }),
      ])
      if (ok) return true
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return false
}

/** capturePage(stayHidden) 有界等待（默认 250ms 快速探测，设计 §六；重试/重捕可传长超时）；
 *  超时/异常 → null。注意：超时后挂起的 capture promise 不取消（Electron 无取消 API），
 *  慢合成场景首次探测超时后其结果自然作废，以重试结果为准。 */
async function capturePageBounded(win: BrowserWindow, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<Electron.NativeImage | null> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      win.webContents.capturePage(witnessGridLayout().rect, { stayHidden: true }),
      new Promise<Electron.NativeImage | null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref()
      }),
    ])
  } catch (err) {
    // v2.5.3 诊断（295 用例契约）：截图 API 故障不升级、走 unknown→frame-subscription 兜底，
    // 但必须留日志（预检截屏失败），否则「capturePage 抛错」路径无迹可循
    void log('warn', `[window] 预检截屏失败: ${String(err)}`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** frame-subscription 兜底（有界等待，成对 end）：整帧 → crop 预检 rect → classify；可判定即收，超时 null。
 *  超时按状态区分（2026-08-18 探针实证）：presenting 态（健康/托盘恢复）合成器冷却时 sub 也慢至秒级
 *  ——长超时（3s）等真帧；recovering 态（崩溃后合成器真死）保持快速失败（250ms）升级 L4。 */
function captureViaFrameSubscription(win: BrowserWindow, token: number, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<WitnessVerdict | null> {
  return new Promise<WitnessVerdict | null>((resolve) => {
    let done = false
    const finish = (v: WitnessVerdict | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        win.webContents.endFrameSubscription()
      } catch {
        /* 已结束/销毁竞态 */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref()
    try {
      win.webContents.beginFrameSubscription(false, (img) => {
        if (done || !img) return
        try {
          const v = classifyFrameWitness(img.crop(witnessGridLayout().rect), token, witnessGridLayout())
          if (v !== 'unknown') finish(v) // 得到可判定结论即收；始终 unknown 等 250ms 兜底结束
        } catch {
          finish(null)
        }
      })
    } catch (err) {
      void log('warn', `[window] beginFrameSubscription 失败: ${String(err)}`)
      finish(null)
    }
  })
}

/** 等待渲染层 first-frame-ack（带 generation 匹配）；超时返回 false */
function waitForFirstFrameAck(generation: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (firstFramePending) firstFramePending.resolve(false) // 作废上一次等待
    const timer = setTimeout(() => {
      if (firstFramePending && firstFramePending.generation === generation) {
        firstFramePending = null
        resolve(false)
      }
    }, timeoutMs)
    timer.unref()
    firstFramePending = { generation, resolve: (ok) => {
      if (timer) clearTimeout(timer)
      firstFramePending = null
      resolve(ok)
    } }
  })
}

/** renderer → main：parked-ack（渲染层已卸载重资源）——ipc.ts 薄壳透传入口 */
export function windowLifecycleParked(sender: Electron.WebContents, msg: unknown): void {
  if (!isMainSender(sender)) return
  const m = msg as Partial<WindowParkedAckMessage>
  const generation = typeof m?.generation === 'number' ? m.generation : -1
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'parked-ack', generation }))
}

/** renderer → main：first-frame-ack（FrameWitness 轻壳已提交）——ipc.ts 薄壳透传入口 */
export function windowLifecycleFirstFrame(sender: Electron.WebContents, msg: unknown): void {
  if (!isMainSender(sender)) return
  const m = msg as Partial<WindowFirstFrameAckMessage>
  const generation = typeof m?.generation === 'number' ? m.generation : -1
  // 1) 冷启动双闸门（starting 态）：首帧 ACK 喂状态机，与 ready-to-show 齐备才首次 show
  const win = getMainWindow()
  if (win && !win.isDestroyed() && lifecycle.state() === 'starting') {
    executeLifecycleActions(win, lifecycle.handle({ type: 'first-frame-ack', generation }))
    return
  }
  // 2) 恢复预检链（presenting 态）：唤醒等待中的 first-frame-ack 等待者
  if (firstFramePending && firstFramePending.generation === generation) {
    firstFramePending.resolve(true)
  }
}

/** IPC sender 校验：仅接受主窗口渲染进程（防伪造） */
function isMainSender(sender: Electron.WebContents): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) return true
  void log('warn', '[window] 生命周期 ACK 来源校验失败（非主窗口渲染进程）')
  return false
}

/** unknown 判定：原生重试/退出对话框（不升级不 reload）；e2e 模式跳过弹框直接走「重试」（日志可断言） */
async function showRecoveryDialog(): Promise<void> {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (process.env.QIHEBOX_E2E === '1') {
    // 原生模态框会挂住 e2e：记录后直接重试（链路本体照走；对话框呈现由真机验收覆盖）
    void log('warn', '[window] unknown 出口：原生「重试/退出」对话框（e2e 模式自动选重试）')
    const actions = lifecycle.handle({ type: 'show-requested', source: 'recovery' })
    executeLifecycleActions(win, actions)
    return
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '画面恢复失败',
    message: '窗口画面无法确认，请重试或重启应用。',
    buttons: ['重试', '退出'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    const actions = lifecycle.handle({ type: 'show-requested', source: 'recovery' })
    executeLifecycleActions(win, actions)
  } else {
    setQuitting(true)
    await flushWindowState()
    win.destroy()
    app.quit()
  }
}

/** v2.5.2：最大化态广播（TitleBar 图标同步）；窗口销毁/加载中发送失败静默——TitleBar onMount 查询兜底 */
function sendMaximizedChanged(maximized: boolean): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('qihebox:event:window:maximized-changed', maximized)
    }
  } catch {
    /* 窗口销毁竞态，静默 */
  }
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

export async function windowQuit(): Promise<void> {
  setQuitting(true)
  // v2.4.7（评审 P2）：退出前落盘窗口状态——destroy() 不触发 close 事件，防抖窗口内的最后调整也在此刷新
  await flushWindowState()
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
