/**
 * 窗口管理（对照原 Go app.go 的窗口控制 + runtime.Window* 函数）
 * 主进程模块：负责无边框窗口创建与窗口控制 IPC 的实现。
 *
 * v2.3.0 分层休眠（最小化超时回收渲染进程 + 关窗到托盘倒计时销毁窗口）已于 v2.5.3 整体移除
 * （2026-08-18 用户拍板）：「不可见 reload / 销毁重建 + GPU 合成表面失效」的组合是历次白屏事故的
 * 总根因（v2.4.3/v2.4.7/v2.4.9/v2.5.2 多轮自愈链打补丁仍有漏网路径）——消除病因优先于自愈：
 * 关窗=仅隐藏到托盘、最小化不再回收，渲染进程常驻；托盘常驻内存相应上升（换可靠性，门禁基线改写）。
 *
 * v2.5.3 热修（2026-08-19，托盘长时隐藏冻结事故定案，用户拍板）：**删 FrameWitness 隐藏预检，
 * 改「先显示、后验证」**。事故取证（动作-2026-08-19-托盘长时隐藏冻结定位.md）：软渲染下隐藏
 * 2.6h 后合成器彻底休眠，隐藏态 capturePage 永远抓不到帧 → 预检永远 unknown → 无限弹「重试/退出」
 * 模态框（挂隐藏父窗口吞掉托盘点击）→ 唤不醒。教训：唤不醒比白屏更糟。新范式：
 * - 托盘/activate/二次实例/系统唤醒 → 状态机直接 show+focus（普通 Electron 应用语义）；
 * - 白屏兜底 = 显示后像素自检（show 后 300ms 可见态抓帧 isBlankFrameLike 判定，blank →
 *   invalidate 复检 → 仍 blank 喂状态机 blank-confirmed → 可见态 L2 reload 单发收口）；
 * - 崩溃 render-process-gone → L4 销毁重建；无响应 unresponsive → 先 hide 再 L2 reload；
 *   收口（did-finish-load / ready-to-show / 用户手动点托盘）直接 show。全链无任何弹框。
 *
 * v2.4.7（F10）系统休眠唤醒：暂停/锁屏信号到达即隐藏窗口（渲染常驻事前规避）；唤醒后
 * 经状态机直接 show 恢复 + 显示后自检兜底（替代原 FrameWitness 隐藏预检，2026-08-19 废止）。
 * - Windows WM_POWERBROADCAST(0x0218) hookWindowMessage 解析（parsePowerBroadcast + WakeSignalGate
 *   交叉信号去重，同一恢复会话 resume 只放行一次；窗口销毁 unhook）
 * - 单时钟保险：单个可重排 .unref() timeout，可见 1s / 隐藏 30s（替代 v2.5.2 固定 30s interval）
 */
import { BrowserWindow, Menu, app, powerMonitor, screen, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from './log'
import { isBlankFrameLike, BLANK_TARGETS_WAKE } from './core/frame'
import { isSuspectedWake, parsePowerBroadcast, WakeSignalGate } from './core/wake'
import { WindowLifecycle, type HideSource } from './core/windowLifecycle'
import { writeJsonAtomic } from './core/paths'
import { buildEditMenu } from './core/editMenu'
import {
  type WindowFirstFrameAckMessage,
  type WindowHideSource,
  type WindowParkedAckMessage,
  type WindowPrepareHideMessage,
  type WindowRestoredMessage,
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let quitting = false

const WAKE_PING_TIMEOUT_MS = 2000 // v2.4.3（F3）：渲染进程活性 ping 超时
let wakePingInFlight = false // v2.4.3（F3）：活性检查互斥，避免并发 ping

// —— v2.5.3 常驻轻壳：窗口生命周期状态机（core/windowLifecycle.ts）——
// 适配层：事件 → 状态机 → 动作列表执行；show/hide 前必经状态机（冷启动双闸门 / 直接 show 恢复）。
const lifecycle = new WindowLifecycle()

/** 有界等待（异步工具；timer.unref 不挂事件循环） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref()
  })
}

// —— v2.5.3 热修：显示后白屏自检（「先显示、后验证」的验证半边）——
// parked 恢复 show 后 300ms 抓帧（可见态 capturePage 可靠，无隐藏态休眠问题）；
// blank → invalidate 重绘 + 200ms 复检；仍 blank → 喂状态机 blank-confirmed（可见态 L2 reload 收口）。
// 抓帧失败/超时（unknown）仅告警不升级——unknown 不升级原则（2026-08-19 事故教训：截图故障
// 不能伪装成画面故障，更不能阻塞唤醒）。自检仅武装 parked 恢复 show（托盘/activate/二次实例/wake）；
// recovering 收口 show 不武装（新渲染进程 load 期间必绘帧，且收口后不自检 → blank 链单发天然收口）。
// 命中加载中（高负载下 300ms 自检点常在加载）：有界等待至多 5s 加载 settle 后真正跑自检，
// 超时仍加载中按 unknown 不升级（2026-08-25 flake 修复：旧行为静默跳过无痕迹）。
const POST_SHOW_CHECK_DELAY_MS = 300 // show 后首次抓帧延迟（等业务层重挂一帧）
const POST_SHOW_RECHECK_DELAY_MS = 200 // invalidate 重绘后复检延迟
const POST_SHOW_CAPTURE_TIMEOUT_MS = 1000 // 可见态抓帧有界等待（正常 <100ms，1s 兜底）
const POST_SHOW_WAIT_LOAD_MS = 5000 // 自检命中加载中的有界等待（100ms 轮询至加载 settle；正常 <100ms，5s 兜底）

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
  //  L4 重建后 recovering 态：ready-to-show → 状态机收口直接 show，2026-08-19 热修）
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

  // v2.5.7（A2）：原生右键编辑菜单——输入框/Crepe 编辑区（contenteditable）缺失的右键能力。
  // 菜单项构建 = 纯函数 core/editMenu.ts（参数矩阵单测）；此处只做 buildFromTemplate + popup。
  // 非编辑元素有文本选区 → 仅「复制」；其余不弹（渲染层既有自定义右键作用于非编辑元素，不双菜单）。
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items = buildEditMenu({
      isEditable: params.isEditable,
      hasSelection: (params.selectionText ?? '').length > 0,
    })
    if (items.length === 0) return
    void log('info', `[context-menu] isEditable=${params.isEditable} selection=${items.length > 1 ? 'full' : 'copy'} 项数=${items.length}`)
    Menu.buildFromTemplate(items as Electron.MenuItemConstructorOptions[]).popup({ window: mainWindow! })
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
  // restore 只做最小化状态归一化，不是显示入口：系统旁路最小化（Linux WM/Alt+F9）已由
  // minimize 事件归一化为隐藏；真正恢复走托盘/二次启动/activate/wake 经状态机 SHOW_REQUESTED
  // 直接 show。旁路 restore 到达时若窗口意外可见（WM 直接恢复隐藏窗口），立即 hide 保持隐藏。
  mainWindow.on('restore', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const s = lifecycle.state()
    if (s !== 'visible' && win.isVisible()) {
      void log('info', '[window] 系统 restore 旁路 → 保持隐藏（恢复只走状态机入口）')
      win.hide()
    } else {
      void log('info', '[window] 系统 restore 旁路（visible/已隐藏），无需动作')
    }
  })

  // v2.5.3：渲染进程无响应（事件循环阻塞确认）→ 交状态机（visible 先 hide 再隐藏态 reload；
  // 收口 did-finish-load 直接 show，2026-08-19 热修语义）
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
// 常驻轻壳方案「事前规避」：暂停/锁屏信号到达即隐藏窗口（渲染常驻）；2026-08-19 热修后唤醒
// 恢复 = 状态机直接 show + 显示后白屏自检兜底（invalidate 复检 → reload），替代已废止的
// FrameWitness 隐藏预检（长时隐藏抓不到帧，反而堵死唤醒，见文件头事故定案）。

/** 暂停/锁屏前窗口可见 → 唤醒后自动恢复显示；原本在托盘 → 唤醒后不得自行显示 */
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
 * 仅「暂停前可见」才自动恢复——状态机直接 show + 显示后白屏自检；原本在托盘不自行显示。
 */
function onSystemResume(source: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || quitting) return
  if (!wasVisibleBeforeSystemPause) {
    void log('info', `[wake] 系统唤醒（${source}），窗口原本在托盘/未记录暂停前可见，不自行显示`)
    return
  }
  wasVisibleBeforeSystemPause = false
  void log('info', `[wake] 系统唤醒（${source}），直接恢复显示（显示后自检兜底）`)
  executeLifecycleActions(win, lifecycle.handle({ type: 'show-requested', source: 'wake' }))
}

// —— 单时钟保险（设计 §4.4 系统睡眠第 4 条）——
// 单个可重排 .unref() timeout：窗口可见每 1s、隐藏每 30s 比较 Date.now()；系统睡眠时进程被冻结，
// 唤醒后首个 tick 的 Δ 突跳（> 间隔×3）即判定刚经历睡眠。检测到可见态长间隔 → 先同步隐藏，
// 再按「系统暂停前可见」处理（直接 show 恢复）。任一时刻仅一个 timeout；隐藏间隔 env 可覆盖
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
    // 可见态长间隔：先同步隐藏，再按「暂停前可见」走恢复（直接 show + 显示后自检）
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
    // 故障注入：直接喂 blank-confirmed（显示后白屏自检确认语义），window-lifecycle.spec.ts 用
    // （L4 重建后探针自动跟随新窗口——getMainWindow 读模块级引用，2026-08-19 热修探针定案）
    ;(globalThis as { __injectBlankConfirmed?: () => void }).__injectBlankConfirmed = () => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        executeLifecycleActions(win, lifecycle.handle({ type: 'blank-confirmed' }))
      }
    }
  }
}

// —— v2.5.3：崩溃/无响应 → 状态机（index.ts setupCrashRecovery 与 unresponsive 监听调用）——
// visible 态：崩溃直接 L4 重建 / 无响应先 hide 再隐藏态 L2 reload（状态机裁决）；
// recovering 态再崩溃/假死 → L4（连续升级封顶，见状态机契约）。
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
// —— v2.5.3 常驻轻壳：hide/show 一律经状态机裁决；2026-08-19 热修起恢复 = 直接 show + 显示后自检 ——

/** 状态机 hide 入口：visible → parking（发 prepare-hide + hide）；窗口不存在则直接隐藏 */
function requestHide(source: HideSource): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  executeLifecycleActions(win, lifecycle.handle({ type: 'hide-requested', source }))
  scheduleClockCheck() // 单时钟按可见性重排：隐藏 30s（省电）
}

/**
 * 状态机 show 入口：parked/parking → 直接 show+focus（armed 显示后白屏自检）；
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

/** 执行状态机返回的动作列表（show/hide/send(prepare-hide)/reload/destroyAndRebuild） */
function executeLifecycleActions(win: BrowserWindow, actions: ReturnType<WindowLifecycle['handle']>): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'show':
        // 状态机裁决通过（冷启动双闸门齐备 / 直接恢复 / recovering 收口）→ 真正 show+focus；
        // source 区分冷启动（startup，不发 restored）与恢复（restore，发 restored 回首页）
        showWindowNow(win, a.source, a.postShowCheck)
        break
      case 'hide':
        win.hide()
        void log('info', '[window] 已隐藏到托盘（渲染常驻）')
        break
      case 'reload': {
        void log('warn', '[window] L2 reload 渲染进程（blank-confirmed / renderer-unresponsive）')
        reloadRenderer(win)
        // 收口 wiring：加载完成 → 状态机 load-finished 直接 show；加载失败 → 按无响应升级 L4
        // （连续升级由状态机 recoveryStreak 封顶，防 did-fail-load 类无限重建循环）
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed() && !quitting) {
            executeLifecycleActions(win, lifecycle.handle({ type: 'load-finished' }))
          }
        })
        win.webContents.once('did-fail-load', () => {
          void log('error', '[window] L2 reload 加载失败（did-fail-load），按无响应升级')
          if (!win.isDestroyed() && !quitting) {
            executeLifecycleActions(win, lifecycle.handle({ type: 'renderer-unresponsive' }))
          }
        })
        break
      }
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
      case 'send':
        sendPrepareHide(win, a.generation, a.source as WindowHideSource)
        break
    }
  }
}

/** show+focus 并通知渲染层 restored（带 generation）；加载中延迟到 did-finish-load 再发。
 *  source=startup（冷启动首显）不发 restored：冷启动无「恢复业务层」语义，渲染层初始业务层
 *  已挂载，由 v2.3.0 lastRoute 恢复逻辑决定初始路由；发 restored 会触发渲染层 navigate('/')，
 *  造成「冷启动恢复上次页面」失效 + SPA URL 被改写（P0，2026-08-18 验收定案）。
 *  postShowCheck=true（parked 恢复）时武装显示后白屏自检。 */
function showWindowNow(win: BrowserWindow, source: 'startup' | 'restore', postShowCheck: boolean): void {
  if (win.isDestroyed() || quitting) return
  win.show()
  win.focus()
  void pingRenderer(win)
  scheduleClockCheck() // 单时钟按可见性重排：可见 1s（系统睡眠检测即时生效）
  if (postShowCheck) armPostShowCheck(win, lifecycle.generation())
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

// —— v2.5.3 热修：显示后白屏自检实现 ——

/** parked 恢复 show 后武装自检：300ms 后抓帧（一次性 .unref() 定时器，非常驻） */
function armPostShowCheck(win: BrowserWindow, generation: number): void {
  const t = setTimeout(() => {
    void runPostShowCheck(win, generation)
  }, POST_SHOW_CHECK_DELAY_MS)
  t.unref()
}

/** 自检放行条件：窗口未销毁未退出、仍在 visible 且同代、且真实可见
 *  （hide 不递增 generation——300ms 内再隐藏必须丢弃本次自检，绝不对隐藏窗口抓帧） */
function postShowCheckArmed(win: BrowserWindow, generation: number): boolean {
  return (
    !win.isDestroyed() &&
    !quitting &&
    lifecycle.state() === 'visible' &&
    lifecycle.generation() === generation &&
    win.isVisible()
  )
}

/** 有界等待加载完成（100ms 轮询至 isLoading 为 false；窗口销毁或超时 → false）——
 *  自检命中加载中不静默跳过：等加载 settle 后真正跑自检，加载态分支留日志可查（2026-08-25 flake 修复）。 */
async function waitLoadSettled(win: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false
    if (!win.webContents.isLoading()) return true
    await sleep(100)
  }
  return !win.isDestroyed() && !win.webContents.isLoading()
}

/** 显示后白屏自检：抓帧 → blank 则 invalidate 复检 → 仍 blank 喂状态机 blank-confirmed。
 *  抓帧失败/超时（unknown）仅告警不升级（unknown 不升级原则：截图故障 ≠ 画面故障）。 */
async function runPostShowCheck(win: BrowserWindow, generation: number): Promise<void> {
  if (!postShowCheckArmed(win, generation)) return
  if (win.webContents.isLoading()) {
    // 加载中露 backgroundColor 底色必误判 blank——但不静默跳过（高负载下 300ms 自检点常命中加载中，
    // 静默跳过无痕迹 → 2026-08-25 e2e flake）：等加载 settle 后真正跑自检；超时仍加载中按 unknown 不升级
    void log('info', `[window] 显示后自检命中加载中（gen=${generation}），等待加载完成`)
    const settled = await waitLoadSettled(win, POST_SHOW_WAIT_LOAD_MS)
    if (!postShowCheckArmed(win, generation)) return // 等待期间可能已隐藏/销毁
    if (!settled) {
      void log('warn', `[window] 显示后自检等待加载完成超时（gen=${generation}），跳过（unknown 不升级）`)
      return
    }
  }
  const img = await capturePageBounded(win, POST_SHOW_CAPTURE_TIMEOUT_MS)
  if (!postShowCheckArmed(win, generation)) return
  if (!img) {
    void log('warn', `[window] 显示后自检抓帧失败/超时（gen=${generation}），跳过（unknown 不升级）`)
    return
  }
  if (!isBlankFrameLike(img, BLANK_TARGETS_WAKE)) {
    void log('info', `[window] 显示后自检通过（gen=${generation}）`)
    return
  }
  void log('warn', `[window] 显示后自检疑似白屏（gen=${generation}），invalidate 重绘复检`)
  try {
    win.webContents.invalidate()
  } catch {
    return // 渲染层竞态销毁，放弃本次自检
  }
  await sleep(POST_SHOW_RECHECK_DELAY_MS)
  if (!postShowCheckArmed(win, generation)) return
  if (win.webContents.isLoading()) {
    // 复检同款：不静默跳过（2026-08-25 flake 修复），等加载 settle 后复检；超时按 unknown 不升级
    const settled2 = await waitLoadSettled(win, POST_SHOW_WAIT_LOAD_MS)
    if (!postShowCheckArmed(win, generation)) return
    if (!settled2) {
      void log('warn', `[window] 显示后自检复检等待加载完成超时（gen=${generation}），跳过（unknown 不升级）`)
      return
    }
  }
  const img2 = await capturePageBounded(win, POST_SHOW_CAPTURE_TIMEOUT_MS)
  if (!postShowCheckArmed(win, generation)) return
  if (!img2) {
    void log('warn', `[window] 显示后自检复检抓帧失败/超时（gen=${generation}），跳过（unknown 不升级）`)
    return
  }
  if (!isBlankFrameLike(img2, BLANK_TARGETS_WAKE)) {
    void log('info', `[window] 显示后自检复检恢复（gen=${generation}，invalidate 后画面正常）`)
    return
  }
  void log('error', `[window] 显示后白屏确认（gen=${generation}）→ 状态机升级（L2 reload）`)
  executeLifecycleActions(win, lifecycle.handle({ type: 'blank-confirmed' }))
}

/** capturePage 有界等待（可见态正常 <100ms；超时/异常 → null）。
 *  注意：超时后挂起的 capture promise 不取消（Electron 无取消 API），慢合成场景结果自然作废。 */
async function capturePageBounded(win: BrowserWindow, timeoutMs: number): Promise<Electron.NativeImage | null> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      win.webContents.capturePage(),
      new Promise<Electron.NativeImage | null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref()
      }),
    ])
  } catch (err) {
    // 截图 API 故障不升级、走 unknown 语义（仅告警），必须留日志否则无迹可循
    void log('warn', `[window] 显示后自检截屏失败: ${String(err)}`)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
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

/** renderer → main：first-frame-ack（冷启动首帧已提交）——ipc.ts 薄壳透传入口；
 *  仅 starting 态消费（冷启动双闸门）；其余状态（如 L4 重建后新渲染层挂载上报）忽略 */
export function windowLifecycleFirstFrame(sender: Electron.WebContents, msg: unknown): void {
  if (!isMainSender(sender)) return
  const m = msg as Partial<WindowFirstFrameAckMessage>
  const generation = typeof m?.generation === 'number' ? m.generation : -1
  const win = getMainWindow()
  if (win && !win.isDestroyed() && lifecycle.state() === 'starting') {
    executeLifecycleActions(win, lifecycle.handle({ type: 'first-frame-ack', generation }))
  }
}

/** IPC sender 校验：仅接受主窗口渲染进程（防伪造） */
function isMainSender(sender: Electron.WebContents): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) return true
  void log('warn', '[window] 生命周期 ACK 来源校验失败（非主窗口渲染进程）')
  return false
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
