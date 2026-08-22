/**
 * 主进程入口（对照原 Go main.go / app.go）
 * - 单实例锁（requestSingleInstanceLock 替代 CreateMutex）
 * - 组装业务服务：BoxService + SharpThumbnailService（共享同一 workspace 实例）
 * - 注册 IPC 与 qihebox:// 文件协议
 * - 系统托盘 + 关闭隐藏到托盘 + 崩溃自愈骨架
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, protocol, safeStorage, Notification, ipcMain, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { BoxService } from './core'
import { WorkspaceService } from './core/workspace'
import { globalWorkspaceIndex, WorkspaceIndexCoordinator } from './core/indexCache'
import { SharpThumbnailService } from './thumbnail'
import { registerIpc, handle, sendTo } from './ipc'
import { registerQiheboxProtocol } from './protocol'
import { registerPluginHost, type PluginHostHandle } from './plugins/ipc'
import { createSettings } from './settings'
import { AccountService } from './account'
import { log, initLogger, getLogger } from './log'
import { isAutoLaunchMode } from './core/autoLaunch'
import { isMacAutostartLaunch } from './autoLaunchMain'
import { checkUpdate, setCachedUpdate } from './updater'
import {
  computeNotifiable,
  composeDailyNotification,
  localDateString,
  type NotifyState,
  type InvoiceTodoItem,
} from './notify'
import { readJsonFile, writeJsonAtomic } from './core/paths'
import {
  createMainWindow,
  getMainWindow,
  ensureMainWindow,
  windowShow,
  windowHideToTray,
  windowQuit,
  setWindowCreateHandler,
  setQuitting,
  isQuitting,
  setupWakeRecovery,
  notifyRendererGone,
  l4Rebuilding,
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

// —— e2e 隔离（QIHEBOX_E2E=1）：userData 指向独立临时目录 ——
// 修复：e2e 此前与生产应用共享 userData（~/.config/启禾文件管理）——
// ① 生产应用在跑时，单实例锁把 e2e 实例判为二次启动 → 启动即退（本机 e2e 全灭的根因）；
// ② e2e 会读写真实缩略图/索引/账号文件，污染生产数据。须在单实例锁之前设置。
if (process.env.QIHEBOX_E2E === '1') {
  app.setPath('userData', path.join(os.tmpdir(), 'qihebox-e2e-userdata'))
  // v2.4.9（S6-2）：日志目录一并隔离（logs 默认随 appData，e2e 不写生产日志；
  // e2e 断言按 <tmpdir>/qihebox-e2e-userdata/logs 读取 main-*.log）
  app.setPath('logs', path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'logs'))
}

// —— 单实例锁（替代原 Go CreateMutex）——
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// —— v2.3.0 内存压制：frameless 无原生菜单，禁用默认菜单初始化（官方 Performance 清单）——
Menu.setApplicationMenu(null)

let tray: Tray | null = null
/** v2.5：插件宿主装配句柄（registerPluginHost 返回；宿主事件桥与退出清理用） */
let pluginHost: PluginHostHandle | null = null
/** v2.4.9（S4）：当前实例是否自启态（决定 --autostart 延迟建窗与自启态诊断日志） */
let autostartMode = false
/** v2.4.2（R1）：崩溃计数改为时间窗——10 分钟内 ≥3 次才退出；`clean-exit`（休眠销毁窗口）不计 */
const CRASH_WINDOW_MS = 10 * 60 * 1000
const CRASH_MAX = 3
const crashTimes: number[] = []
/** v2.4.3（F5）：GPU 崩溃恢复的 app 级监听只注册一次（窗口重建不重复挂，避免重复 reload） */
let gpuRecoveryRegistered = false

function setupTray(): void {
  const iconPath = path.join(app.getAppPath(), 'build/trayicon.png')
  const icon = nativeImage.createFromPath(iconPath)
  // v2.4.7（评审 P6）：托盘图标缺失时不再静默——空图标托盘在部分 Linux 桌面不可见，需明确告警便于排查打包路径问题
  if (icon.isEmpty()) void log('warn', `托盘图标加载失败（空图标）: ${iconPath}`)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('启禾文件管理 - 常驻后台运行中')
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => {
        // v2.4.9（S4）：自启态诊断日志——ensureMainWindow 触发点（含来源标识）
        if (autostartMode) void log('info', 'autostart: 托盘菜单触发建窗（ensureMainWindow）')
        windowShow()
      },
    },
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
  tray.on('click', () => {
    // v2.4.9（S4）：自启态诊断日志——ensureMainWindow 触发点（含来源标识）
    if (autostartMode) void log('info', 'autostart: 托盘图标点击触发建窗（ensureMainWindow）')
    windowShow()
  })
}

function setupCrashRecovery(win: BrowserWindow): void {
  // 渲染进程崩溃 → 交生命周期状态机（v2.5.3）：visible 直接 L4 销毁重建，ready-to-show 收口 show
  // （2026-08-19 热修：FrameWitness 隐藏预检废止——长时隐藏抓不到帧反而堵死唤醒，改直接 show
  //  + 显示后白屏自检兜底）；崩溃计数（10 分钟时间窗内 ≥3 次退出）保留防循环（v2.4.2）。
  win.webContents.on('render-process-gone', (_e, details) => {
    // 正常销毁（L4 自愈重建/退出路径）产生的 clean-exit 不是崩溃，不计数
    if (details.reason === 'clean-exit') return
    void log('error', `renderer gone: ${details.reason}`)
    const now = Date.now()
    while (crashTimes.length > 0 && now - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift()
    crashTimes.push(now)
    if (crashTimes.length > CRASH_MAX) {
      void log('error', `渲染进程 ${CRASH_WINDOW_MS / 60000} 分钟内崩溃 ${CRASH_MAX} 次，应用退出`)
      setQuitting(true)
      app.quit()
      return
    }
    notifyRendererGone()
  })
  // v2.4.3（F5）：GPU 进程崩溃 → 交状态机恢复（同渲染崩溃：L4 销毁重建 + ready-to-show 收口，
  // 2026-08-19 热修语义；原「1 秒后直接 reload」会露出崩溃画面），纳入崩溃时间窗计数（10 分钟 ≥3 次退出，防循环）
  // 注意：app 级监听只在首次注册，窗口重建（setupCrashRecovery 再次调用）不重复挂，避免重复 reload
  if (!gpuRecoveryRegistered) {
    gpuRecoveryRegistered = true
    app.on('child-process-gone', (_e, details) => {
      if (details.type !== 'GPU') return
      void log('warn', 'gpu process gone, may fallback to software rendering')
      const win = getMainWindow()
      if (!win || win.isDestroyed() || isQuitting()) return
      const now = Date.now()
      while (crashTimes.length > 0 && now - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift()
      crashTimes.push(now)
      if (crashTimes.length > CRASH_MAX) {
        void log('error', 'GPU 进程反复崩溃，应用退出')
        setQuitting(true)
        app.quit()
        return
      }
      notifyRendererGone()
    })
  }
}

// —— v2.4.9（S6-2）：渲染进程 console 转发 ——
// console error/warn 转发落盘（只转 error/warn，info 防噪音）。Electron 31 事件旧式签名
// (event, level, message, line, sourceId)，level 为数字（0=verbose / 1=info / 2=warning / 3=error，
// 见 node_modules/electron/electron.d.ts WebContents）。
// 挂载点随窗口创建/重建：窗口重建（L4 自愈/自启延迟建窗）时 ensureMainWindow → setWindowCreateHandler 再次挂上，
// 旧窗口销毁时监听随 webContents 一并回收，不会重复挂载。
function setupRendererConsoleForward(win: BrowserWindow): void {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level === 2) void log('warn', `[renderer] ${message}`)
    else if (level === 3) void log('error', `[renderer] ${message}`)
  })
}

// 关闭窗口 → 隐藏到托盘（对照原 Go beforeClose）；v2.5.3 起仅隐藏不销毁（分层休眠移除——
// 「销毁重建 + GPU 表面失效」是历次白屏总根因，渲染进程常驻换可靠性，托盘常驻内存基线相应上调）
// e2e 模式（QIHEBOX_E2E=1，Playwright）：跳过隐藏托盘，让 app.close() 能正常退出（否则 Playwright 等待超时）
function setupCloseToTray(win: BrowserWindow): void {
  if (process.env.QIHEBOX_E2E === '1') return
  win.on('close', (e) => {
    if (isQuitting()) return
    e.preventDefault()
    void log('info', '[window] close 事件触发 → 隐藏到托盘（渲染进程常驻）')
    win.hide()
  })
}

// 系统级退出（托盘退出菜单 / 应用退出）→ 置 quitting 放行窗口关闭
app.on('before-quit', () => {
  setQuitting(true)
})

// v2.5：退出清理——全部已激活插件 dispose()（尽力，超时 2s 不强等，PLAN §六.4）+ 宿主事件总线清理
app.on('will-quit', () => {
  void pluginHost?.dispose()
})


// v2.3.0 起为分层休眠注册的 window-all-closed 空监听：阻止 Electron 默认退出（Windows/Linux
// 无监听时全窗口关闭即退出）。v2.5.3 移除休眠后窗口不再被销毁，此事件正常仅在退出路径触发；
// 保留空监听作兜底（非常规全关场景下仍保持主进程+托盘常驻语义，不悄悄退出）。
// v2.5.3 L4 修复（2026-08-18 定案）：destroyAndRebuild 销毁窗口后 ensureMainWindow 同步创建新窗口，
// 但 Electron 可能在 destroy 派发 window-all-closed（新窗口构造完成前 getAllWindows 为空）——
// **e2e 下也必须注册此监听**（否则 L4 重建触发默认退出 → Playwright 报 browser closed，崩溃/故障
// 恢复链全灭）。注册后：已有现存窗口或 L4 重建中 → 阻止退出；e2e 真正全关（Playwright app.close）
// → 放行默认退出，语义不变。
app.on('window-all-closed', () => {
  const win = getMainWindow()
  if ((win && !win.isDestroyed()) || l4Rebuilding) {
    void log('info', '[window] L4 重建/新窗口存在，阻止退出（ensureMainWindow 立即重建）')
    return
  }
  if (process.env.QIHEBOX_E2E !== '1') {
    void log('info', '[window] 所有窗口已关闭，主进程+托盘保持常驻')
  }
  // e2e 且非 L4 重建：不拦截 → Electron 默认退出（Playwright app.close 语义保持）
})

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

/**
 * 解析登录/心跳服务地址（v2.5.2 三级回退）。
 * 优先环境变量 QIHE_API_BASE，其次 userData/server.json（用户/发布者覆盖），
 * 再次安装包内置 resources/server.json（随包发布）。公开仓库不写死任何服务器地址：
 * 真实地址由发布者维护在 gitignore 的 build/server.json，打包时经 extraResources 注入。
 */
function resolveApiBase(): string {
  const env = process.env.QIHE_API_BASE
  if (env) return env.replace(/\/+$/, '')
  for (const p of [
    path.join(app.getPath('userData'), 'server.json'),
    path.join(process.resourcesPath, 'server.json'),
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as { apiBase?: unknown }
      if (typeof cfg.apiBase === 'string' && cfg.apiBase) return cfg.apiBase.replace(/\/+$/, '')
    } catch {
      // 配置文件不存在或损坏 → 尝试下一级；全缺 → 登录不可用，不阻断启动
    }
  }
  return ''
}

const account = new AccountService({
  accountFile: path.join(app.getPath('userData'), 'account.json'),
  baseUrl: resolveApiBase(),
  encrypt: encryptToken,
  decrypt: decryptToken,
  version: () => app.getVersion(),
  log: (level, msg) => void log(level, msg),
  // v2.5.3（P1-6）：心跳 401 会话过期 → 全窗口广播（beat 可能无窗口：遍历全部窗口 + sendTo 销毁守卫，
  // 照 plugins/ipc.ts 插件事件桥先例）；渲染层 stores/account 订阅刷新过期态
  onSessionExpired: (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      sendTo(win, 'qihebox:event:account:session-expired', status)
    }
  },
})

// —— v2.4.0 后台任务：更新检查 / 证书到期通知 / 回收站过期清理 ——
// v2.5.3（P2-17）：更新通知去重由「模块级变量」改为持久化同日去重（并入 notified.json 每日通道）——
// 冷启动重复提醒根因：模块级变量随进程退出丢失，重启即重新提醒；改为同日同版本不再重复（跨重启持久）

/** 更新提醒在 notified.json 中的去重 key 前缀（与证书/发票待办 key 并存互不冲突） */
const UPDATE_NOTIFY_KEY_PREFIX = '更新提醒/'

function updateNotifyKey(version: string): string {
  return `${UPDATE_NOTIFY_KEY_PREFIX}${version}`
}

/** 同日同版本是否已提醒过（notified.json 每日去重；文件缺失/跨天 → 未提醒） */
async function isUpdateNotifiedToday(version: string): Promise<boolean> {
  const state = await readJsonFile<NotifyState>(path.join(app.getPath('userData'), 'notified.json'))
  if (!state || state.date !== localDateString()) return false
  return state.keys.includes(updateNotifyKey(version))
}

/** 记录「今日已提醒该版本」（并入当日 keys；写失败仅告警，同日重复提醒是可接受的降级） */
async function markUpdateNotified(version: string): Promise<void> {
  const file = path.join(app.getPath('userData'), 'notified.json')
  const state = await readJsonFile<NotifyState>(file)
  const keys = state && state.date === localDateString() ? [...state.keys] : []
  if (!keys.includes(updateNotifyKey(version))) keys.push(updateNotifyKey(version))
  await writeJsonAtomic(file, { date: localDateString(), keys }).catch((err) =>
    void log('warn', `更新提醒去重记录写入失败: ${String(err)}`),
  )
}

/** 静默更新检查：发现新版推送给所有窗口（无窗口则忽略，下次启动/次日再查）；失败仅 log */
async function runUpdateCheck(): Promise<void> {
  try {
    const info = await checkUpdate(app.getVersion())
    if (!info) return
    void log('info', `发现新版本 v${info.version}（当前 v${app.getVersion()}）`)
    // v2.4.7（评审 P1）：写入缓存——Profile 懒加载错过事件时通过 updater:state 查询兜底
    setCachedUpdate(info)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('qihebox:event:update:available', info)
    }
    // v2.5：插件宿主事件桥——发现新版（host.events.on('updateAvailable') 白名单通道，PLAN §1.1 步骤 7）
    pluginHost?.emitHostEvent('updateAvailable', info)
    // 收尾轮：发现新版补一条系统通知兜底（用户不在 Profile 页也能感知）；按版本同日去重（P2-17 持久化）
    if (!(await isUpdateNotifiedToday(info.version))) {
      await markUpdateNotified(info.version)
      sendSystemNotification(
        `发现新版本 v${info.version}`,
        '点击查看更新说明并前往官网下载',
        // v2.5.2（打磨）：通知点击死路径修复——此前只唤起主窗口，文案承诺的「前往官网下载」未兑现；
        // 应用内下载通道未就绪（Profile 注释），点击直接打开官网下载页（唤起窗口 + openExternal）
        () => {
          windowShow()
          void shell.openExternal(info.download_url)
        },
      )
    }
  } catch (err) {
    void log('warn', `更新检查失败: ${String(err)}`)
  }
}

/**
 * v2.4.2（C3）：系统通知——返回是否真实发出；点击通知唤起主窗口；不可用时降级给应用内事件，不假成功。
 * v2.5.2（打磨）：onClick 可选——更新通知传打开官网下载页的点击处理（兑现文案），其余通知保持唤起窗口。
 */
function sendSystemNotification(title: string, body: string, onClick?: () => void): boolean {
  if (!Notification.isSupported()) {
    void log('warn', `系统通知不受支持，已降级为应用内提醒: ${title}`)
    return false
  }
  try {
    const n = new Notification({ title, body })
    // v2.4.2（批次二）：点击通知 → 唤起主窗口（未建窗时自动创建）
    n.on('click', onClick ?? (() => windowShow()))
    n.show()
    return true
  } catch (err) {
    void log('warn', `系统通知不可用，已降级为应用内提醒: ${title}（${String(err)}）`)
    return false
  }
}

/** 证书到期 + 发票待办通知：合并为一条系统通知，每日去重（userData/notified.json）；失败仅 log */
async function runCertNotify(box: BoxService): Promise<void> {
  let expiring: [string, string, string][]
  try {
    expiring = await box.dashboard.checkExpiringCerts()
  } catch (err) {
    void log('warn', `证书到期检查失败: ${String(err)}`)
    return
  }
  // v2.4.7（§6.4）：发票待办并入同一每日去重通道（computeNotifiable 内 key 前缀 发票待办/ 防与证书 key 冲突）
  let invoiceTodos: InvoiceTodoItem[] = []
  try {
    const todos = await box.dashboard.invoiceTodos()
    invoiceTodos = todos.map((r) => ({ number: r.number, due_date: r.due_date ?? '', customer: r.customer }))
  } catch (err) {
    void log('warn', `发票待办检查失败: ${String(err)}`)
  }
  if (expiring.length === 0 && invoiceTodos.length === 0) return
  const notifiedFile = path.join(app.getPath('userData'), 'notified.json')
  const state = await readJsonFile<NotifyState>(notifiedFile)
  const { toNotify, invoiceToNotify, nextState } = computeNotifiable(expiring, state, new Date(), invoiceTodos)
  const msg = composeDailyNotification(toNotify, invoiceToNotify)
  if (!msg) return
  // v2.4.2（批次二）：聚合为一条摘要通知（证书部分取最早到期一条），发票部分「N 张发票待办，最近 <日期>」
  const sent = sendSystemNotification(msg.title, msg.body)
  // v2.4.2（C3）：只有系统通知真实发出才落盘去重——通知不可用（无守护进程/权限被拒）时
  // 不误记「已提醒」，改为应用内事件兜底（下次启动/次日仍会再提醒）
  if (sent) {
    await writeJsonAtomic(notifiedFile, nextState).catch((err) =>
      void log('warn', `通知去重记录写入失败: ${String(err)}`),
    )
  } else {
    // v2.4.7（§6.4）：应用内横幅不扩——发票待办不进横幅（仪表盘 + 系统通知足够），兜底事件仅证书
    if (toNotify.length > 0) {
      void log('warn', `有 ${toNotify.length} 张证书待提醒，但系统通知不可用，已转应用内提醒`)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('qihebox:event:cert:expiring', toNotify)
          } catch {
            // 窗口销毁竞态兜底
          }
        }
      }
      // v2.5：插件宿主事件桥——证书到期（host.events.on('certExpiring') 白名单通道，PLAN §1.1 步骤 7）
      pluginHost?.emitHostEvent('certExpiring', toNotify)
    }
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
/**
 * v2.5.3（T5）：索引候选/代数协调器——所有 build/load 走 candidate 会话，
 * 提交时整体替换全局索引；旧代数 session 绝不触碰 globalWorkspaceIndex。
 */
const indexCoordinator = new WorkspaceIndexCoordinator(globalWorkspaceIndex)

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
 * fs.watch(ws, { recursive: true }) → 文件/目录变化时 onEvent(受影响目录)，查询时重建快照，
 * 覆盖签名粒度盲区（同目录 mtime 下的文件内容覆盖等）。
 * v2.5.3（T5）：失效目标由调用方注入 onEvent(dir) 回调——重建期间指向候选
 * session.invalidate(dir)，提交后在同一同步片段改传 globalWorkspaceIndex.invalidate(dir)，
 * 事件处理无空窗；不再依赖模块级可变 sink。
 * recursive 创建即抛（Linux 不支持 / inotify 超限）或运行期报错（ENOSPC 等）→
 * 关闭监听降级为仅签名模式（每次查询 stat 比对签名兜底，功能正确性不受影响）。
 */
function startWorkspaceWatcher(box: BoxService, ws: string, onEvent: (dir: string) => void): void {
  closeWorkspaceWatcher()
  try {
    const watcher = fs.watch(ws, { recursive: true }, (_evt, filename) => {
      try {
        if (!filename) return
        // 工作区切换后旧监听仍可能触发事件 → 只处理当前工作区路径
        const cur = box.workspace.currentWorkspacePath()
        if (!cur || path.resolve(cur) !== path.resolve(ws)) return
        onEvent(path.dirname(path.join(ws, filename)))
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
 * 初始化/重建工作区索引（启动恢复后与工作区切换时调用，异步不阻塞启动与 UI）。
 * v2.5.3（T5）竞态治理：所有 load/validate/build 在候选会话（candidate）上执行，
 * 全程使用捕获的 ws（listRawForWorkspace），会话过期（工作区已切换）则丢弃结果；
 * 仅当前会话 commit 才整体替换全局索引，并把 watch 事件目标指回全局索引。
 */
async function setupWorkspaceIndex(box: BoxService): Promise<void> {
  const ws = box.workspace.currentWorkspacePath()
  if (!ws) return
  const session = indexCoordinator.beginRebuild()
  // 重建期间：watch 事件进候选（session.invalidate）；commit 成功后同一同步片段
  // 改传全局索引（startWorkspaceWatcher 重建监听），事件处理全程无空窗
  startWorkspaceWatcher(box, ws, (dir) => session.invalidate(dir))
  const idxRoot = indexRootFor(ws)
  let shouldSave = false
  try {
    const loaded = await session.candidate.load(idxRoot)
    if (!session.isCurrent()) return
    if (loaded) {
      const changed = await session.candidate.validate((d) => box.files.listRawForWorkspace(ws, d))
      if (!session.isCurrent()) return
      void log('info', `文件索引已加载（${changed} 个目录已重建）`)
    } else {
      const built = await session.candidate.build(ws, (d) => box.files.listRawForWorkspace(ws, d))
      if (!session.isCurrent()) return
      shouldSave = true
      void log('info', `文件索引已构建：${built} 个目录`)
    }
  } catch (err) {
    // build/load 失败仅告警（签名校验兜底），不阻断索引事件链路
    void log('warn', `文件索引构建失败: ${String(err)}`)
  } finally {
    // 提交与事件重指在同一同步片段：只有仍为当前代的 session 才可提交并接管 watch 事件；
    // 过期 session 不触碰事件目标（更新的 session 已完成接管）。
    const committed = session.isCurrent() && session.commit()
    if (committed) {
      startWorkspaceWatcher(box, ws, (dir) => globalWorkspaceIndex.invalidate(dir))
      if (shouldSave) {
        // 提交后落盘：save 失败仅告警，不回滚已生效的内存索引（不 await，避免阻塞切换）
        void session.candidate.save(idxRoot).catch((err) => void log('warn', `索引落盘失败（仅告警，内存索引已生效）: ${String(err)}`))
      }
      void log('info', '文件索引已就绪（候选提交）')
    }
  }
}

app.whenReady().then(() => {
  initLogger()
  // —— v2.5（P1-D1）：启动装配兜底——主装配体整体 try/catch，任一失败仅 log 降级；
  // 窗口/托盘/唤醒自愈独立在兜底分支执行，保证装配失败也至少创建窗口、托盘常驻。 ——
  let box: BoxService | null = null
  try {
    // 单一 workspace 实例贯穿全部服务
    const workspace = new WorkspaceService()
    // v2.1.0：缩略图缓存根迁移到 userData（工作区不再被 .thumbnails 污染，坚果云不同步缓存）
    const thumbs = new SharpThumbnailService(workspace, {
      userDataThumbsDir: path.join(app.getPath('userData'), 'thumbs'),
    })
    box = new BoxService(thumbs, workspace, getLogger() ?? undefined)
    const svc = box // 非空常量：闭包内直接使用，避免 null 收窄丢失

    // v2.4.7：交换区投递服务（PLAN §8）——ledger sink 已在 BoxService 构造器内接入发票/入库台账
    // （查重等账务规则单点落在台账服务，§6.2「三入口同函数」）；此处只做生命周期装配：
    // 工作区打开/切换时 stop + start（watch 句柄与防抖定时器成对释放重建）+ 启动补扫
    const exchange = svc.exchange
    // v2.5.3（T5）：工作区切换处理注册（幂等，含恢复失败路径兜底）——
    // 在初始索引构建前启用，确保「切换 → 候选重建 → 提交」链路自始无失联窗口
    let wsChangeHandlerRegistered = false
    const registerWorkspaceChangeHandler = () => {
      if (wsChangeHandlerRegistered) return
      wsChangeHandlerRegistered = true
      workspace.onWorkspaceChanged(() => {
        // v2.5：插件宿主事件桥——工作区切换（host.events.on('workspaceChanged') 白名单通道，PLAN §1.1 步骤 7）
        pluginHost?.emitHostEvent('workspaceChanged', svc.workspace.currentWorkspacePath())
        // v2.5.3（T5）：索引走候选会话重建（旧 build 不得污染全局索引）
        void setupWorkspaceIndex(svc).catch((err) => void log('warn', `文件索引重建失败: ${String(err)}`))
        // v2.4.7：交换区监听随工作区切换关闭重建（watch 句柄与防抖定时器成对释放）+ 立即补扫
        exchange.stop()
        void exchange.start().catch((err) => void log('warn', `交换区补扫失败: ${String(err)}`))
      })
    }
    // v2.5.1（D20）：交换区归集成功 → 插件宿主 fileArchived 桥（region=exchange，逐条投递）
    svc.onExchangeArchived = (archived) => {
      for (const p of archived) {
        pluginHost?.emitHostEvent('fileArchived', { region: 'exchange', path: p, name: path.basename(p) })
      }
    }

    // —— IPC / 协议 / 插件宿主 / 设置注册：各自失败仅 log 降级，不阻断装配（P1-D1）——
    try {
      registerIpc(svc, account, {
        isTrayReady: () => tray !== null,
        // v2.5（P1-A4）：files 导入完成 → 宿主事件 importComplete 投递桥
        onImportComplete: (payload) => pluginHost?.emitHostEvent('importComplete', payload),
        // v2.5.1（A1，D9）：客户变更 → 宿主事件投递桥（成功路径）
        onCustomerEvent: (event, payload) => pluginHost?.emitHostEvent(event, payload),
        // v2.5.4（弹一 C-3，云桥 M3）：供应商变更 → 宿主事件投递桥（成功路径）
        onSupplierEvent: (event, payload) => pluginHost?.emitHostEvent(event, payload),
        // v2.5.1（A1，D20）：文件归档 → 宿主事件 fileArchived 投递桥（成功路径）
        onFileArchived: (payload) => pluginHost?.emitHostEvent('fileArchived', payload),
        // v2.5.1（登录增强 D24 落地）：登录/登出成功 → accountChanged 广播（闭源插件使用锁即时响应）
        onAccountChanged: (loggedIn) => pluginHost?.emitHostEvent('accountChanged', { loggedIn }),
      })
    } catch (err) {
      void log('error', `IPC 注册失败（降级继续，窗口仍创建）: ${String(err)}`)
    }
    try {
      registerQiheboxProtocol(svc, () => thumbs.currentThumbsRoot(), () => path.join(app.getPath('userData'), 'plugins'))
    } catch (err) {
      void log('error', `协议注册失败（降级继续）: ${String(err)}`)
    }

    // —— v2.5：插件宿主装配（PLAN §六）——装配期只做已安装包清单登记（同步微秒级），
    // 不加载任何插件代码（惰性加载归 src/main/plugins/loader.ts）；默认未安装任何插件时零开销
    const settings = createSettings(app.getPath('userData'))
    try {
      pluginHost = registerPluginHost(svc, account, settings)
    } catch (err) {
      void log('error', `插件宿主装配失败（降级继续，插件功能不可用）: ${String(err)}`)
    }

    // —— v2.5：开发者模式设置 IPC（侧载收紧，PLAN §3.5；ApiResult 包装对齐 handle() 纪律，P1-E2）——
    try {
      ipcMain.handle('qihebox:settings:getDevMode', () => handle(() => settings.getDevMode()))
      ipcMain.handle('qihebox:settings:setDevMode', (_e, enabled: boolean) =>
        handle(async () => {
          // 必须先 await 落盘再返回——否则调用方读到旧值（渲染层开关弹回）
          await settings.setDevMode(!!enabled)
          return settings.getDevMode()
        }),
      )
    } catch (err) {
      void log('error', `设置 IPC 注册失败（降级继续）: ${String(err)}`)
    }

    // v2.4.7（评审 P5）：重启后恢复已登录账号的心跳——登录态由 account.json 持久化，
    // 此前只有 login() 内启动心跳，重启后心跳静默丢失（startHeartbeat 幂等，登录路径仍会重复调用无害）
    if (account.status().loggedIn) account.startHeartbeat()


    // 启动恢复/创建默认工作区（有最近工作区则恢复，无则自动创建）；
    // 恢复成功后初始化工作区索引（load/build + 文件监听，异步不阻塞）；随后跑后台任务（均静默）
    workspace
      .restoreOrCreateDefault()
      .then(() => {
        // v2.5.3（T5）：初始索引构建前就注册工作区变更处理——切换事件自始无失联窗口
        registerWorkspaceChangeHandler()
        // v2.4.x：初始化工作区索引——加载/校验或全量构建（候选会话 + 提交）+ 文件监听（失败仅 log，签名校验兜底）
        return setupWorkspaceIndex(svc).catch((err) => void log('warn', `文件索引初始化失败: ${String(err)}`))
      })
      .catch((err) => {
        void log('warn', `默认工作区恢复失败: ${String(err)}`)
      })
      .then(() => {
        // 恢复失败路径兜底：用户随后打开工作区时仍能重建索引与交换区
        registerWorkspaceChangeHandler()
        // v2.4.7：交换区启动补扫推迟到后台任务阶段异步执行（不进 app ready → 窗口可交互关键路径，PLAN §一.3）
        void exchange.start().catch((err) => void log('warn', `交换区启动补扫失败: ${String(err)}`))
        // 收尾轮（候选 3）：缩略图磁盘缓存惰性 GC——再延迟 30s 避开启动高峰，后台低优先执行
        setTimeout(() => {
          void thumbs
            .collectGarbage()
            .then((r) => {
              if (r.removed > 0) {
                void log('info', `缩略图缓存 GC：清理 ${r.removed} 个文件，释放 ${(r.freedBytes / 1024 / 1024).toFixed(1)}MB`)
              }
            })
            .catch((err) => void log('warn', `缩略图缓存 GC 失败: ${String(err)}`))
        }, 30_000).unref?.()
        return runStartupTasks(svc)
      })

    // v2.3.0：统一窗口初始化钩子——窗口重建（ensureMainWindow；L4 自愈/自启延迟建窗）自动带上崩溃自愈与托盘行为
    setWindowCreateHandler((win) => {
      setupCrashRecovery(win)
      setupRendererConsoleForward(win)
      setupCloseToTray(win)
      win.on('closed', () => {
        void log('info', '[window] 主窗口已销毁（L4 自愈重建或退出）')
      })
    })
  } catch (err) {
    void log('error', `启动装配失败（进入窗口兜底分支）: ${String(err)}`)
  }

  // —— 兜底分支（P1-D1）：窗口 + 托盘 + 唤醒自愈独立于主装配，失败也至少创建窗口 ——
  try {
    // v2.4.9（S4）：开机自启分支（决策 5/11/15）——自启态不建窗：托盘常驻 + 后台任务照常
    // （索引构建 + fs.watch 监听 / 交换区补扫 / 30s 缩略图 GC / runStartupTasks 均在下方链上
    // 无条件执行，与托盘态同口径，不跳过）；等待托盘点击 / second-instance / activate 经
    // ensureMainWindow() 兜底建窗（决策 15）。
    autostartMode = isAutoLaunchMode(process.argv, process.env) || isMacAutostartLaunch()
    if (autostartMode) {
      // 自启态诊断日志（§3.6.2）：命中来源 / 托盘初始化 / 延迟建窗
      const src = process.argv.includes('--autostart')
        ? 'argv'
        : process.env.QIHEBOX_AUTOSTART === '1'
          ? 'env'
          : 'mac wasOpenedAtLogin'
      void log('info', `autostart 模式命中（来源: ${src}）`)
      setupTray()
      void log('info', 'autostart: 托盘初始化完成')
      void log('info', 'autostart: 延迟建窗，等待托盘/激活触发')
    } else {
      const win = createMainWindow()
      setupTray()
      setupCrashRecovery(win)
      setupRendererConsoleForward(win)
      setupCloseToTray(win)
    }
    // v2.4.7（F10）：系统休眠唤醒自愈——resume 后分层检查，白屏自动 reload（含画面像素检测）
    setupWakeRecovery()
  } catch (err) {
    void log('error', `窗口/托盘/唤醒自愈初始化失败，尝试兜底建窗: ${String(err)}`)
    try {
      if (!autostartMode && BrowserWindow.getAllWindows().length === 0) createMainWindow()
    } catch (err2) {
      void log('error', `兜底建窗失败: ${String(err2)}`)
    }
  }

  // v2.4.0：每日定时任务（24h）——更新检查 + 证书到期通知；应用常驻托盘期间持续生效
  setInterval(() => {
    void runUpdateCheck()
    if (box) void runCertNotify(box)
  }, 24 * 3600 * 1000).unref()
})

app.on('activate', () => {
  // 窗口不存在（自启延迟建窗/L4 重建间隙）时激活（macOS dock / Linux）即建窗
  if (BrowserWindow.getAllWindows().length === 0) {
    // v2.4.9（S4）：自启态诊断日志——ensureMainWindow 触发点（含来源标识）
    if (autostartMode) void log('info', 'autostart: activate 触发建窗（ensureMainWindow）')
    ensureMainWindow()
  } else {
    windowShow()
  }
})

// 二次启动：聚焦已有窗口（替代原 FindWindow/SetForegroundWindow）；窗口不存在（自启未建窗/L4 重建间隙）则创建
// v2.4.7（评审 P3）：统一复用 windowShow()——不再直接 show/focus 绕过 ready-to-show 守卫
// （v2.4.3 F2 黑屏修复：加载中的窗口提前 show 会露出深色空窗，二次启动同样适用）
app.on('second-instance', () => {
  // v2.4.9（S4）：自启态诊断日志——ensureMainWindow 触发点（含来源标识）
  if (autostartMode) void log('info', 'autostart: second-instance 触发建窗（ensureMainWindow）')
  windowShow()
})

// 主进程未捕获异常 → 日志落盘
process.on('uncaughtException', (err) => {
  void log('error', `uncaughtException: ${err?.stack ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  void log('error', `unhandledRejection: ${String(reason)}`)
})
