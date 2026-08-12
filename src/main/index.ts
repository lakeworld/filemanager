/**
 * 主进程入口（对照原 Go main.go / app.go）
 * - 单实例锁（requestSingleInstanceLock 替代 CreateMutex）
 * - 组装业务服务：BoxService + SharpThumbnailService（共享同一 workspace 实例）
 * - 注册 IPC 与 qihebox:// 文件协议
 * - 系统托盘 + 关闭隐藏到托盘 + 崩溃自愈骨架
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, protocol, safeStorage, Notification } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { BoxService } from './core'
import { WorkspaceService } from './core/workspace'
import { globalWorkspaceIndex } from './core/indexCache'
import { SharpThumbnailService } from './thumbnail'
import { registerIpc } from './ipc'
import { registerQiheboxProtocol } from './protocol'
import { AccountService } from './account'
import { log, initLogger } from './log'
import { checkUpdate, setCachedUpdate } from './updater'
import {
  computeNotifiable,
  composeDailyNotification,
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
  scheduleDestroy,
  setQuitting,
  isQuitting,
  setupWakeRecovery,
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
/** v2.4.2（R1）：崩溃计数改为时间窗——10 分钟内 ≥3 次才退出；`clean-exit`（休眠销毁窗口）不计 */
const CRASH_WINDOW_MS = 10 * 60 * 1000
const CRASH_MAX = 3
const crashTimes: number[] = []
/** v2.4.7（评审 P1）：渲染崩溃自动 reload 延迟（默认 500ms）；e2e 用大值使 F10 resume 自愈成为唯一恢复源 */
const CRASH_RECOVER_MS = Number(process.env.QIHEBOX_CRASH_RECOVER_MS) || 500
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
  // 渲染进程崩溃 → 自动 reload（v2.4.2：10 分钟时间窗内 >3 次才退出，杜绝「崩溃→加载成功清零→再崩溃」无限循环）
  win.webContents.on('render-process-gone', (_e, details) => {
    // 休眠销毁窗口产生的 clean-exit 不是崩溃，不计数
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
    setTimeout(() => {
      if (!win.isDestroyed()) win.reload()
      // v2.4.7（评审 P1）：reload 延迟可被 env 覆盖——e2e 用大值（如 10000ms）让
      // wake-recovery 测试的「resume 自愈」成为唯一恢复源，真正判别 F10 而非本路径兜底
    }, CRASH_RECOVER_MS)
  })
  // v2.4.3（F5）：GPU 进程崩溃 → 1 秒后 reload 主窗口一次，纳入崩溃时间窗计数（10 分钟 ≥3 次退出，防循环）
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
      setTimeout(() => {
        const w = getMainWindow()
        if (w && !w.isDestroyed()) w.reload()
      }, 1000)
    })
  }
}

// —— v2.4.9（S6-2）：渲染进程 console 转发 ——
// console error/warn 转发落盘（只转 error/warn，info 防噪音）。Electron 31 事件旧式签名
// (event, level, message, line, sourceId)，level 为数字（0=verbose / 1=info / 2=warning / 3=error，
// 见 node_modules/electron/electron.d.ts WebContents）。
// 挂载点随窗口创建/重建：休眠销毁后 ensureMainWindow → setWindowCreateHandler 再次挂上，
// 旧窗口销毁时监听随 webContents 一并回收，不会重复挂载。
function setupRendererConsoleForward(win: BrowserWindow): void {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level === 2) void log('warn', `[renderer] ${message}`)
    else if (level === 3) void log('error', `[renderer] ${message}`)
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


// v2.3.0 分层休眠：窗口被休眠销毁（close → 托盘 → 30 秒无活跃 → destroy，v2.4.5 T3 提速）时，
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

/** 已通知过的新版号（收尾轮：更新通知按版本去重，避免每日检查重复打扰） */
let notifiedUpdateVersion = ''

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
    // 收尾轮：发现新版补一条系统通知兜底（用户不在 Profile 页也能感知）；按版本去重
    if (notifiedUpdateVersion !== info.version) {
      notifiedUpdateVersion = info.version
      sendSystemNotification(
        `发现新版本 v${info.version}`,
        '点击查看更新说明并前往官网下载',
      )
    }
  } catch (err) {
    void log('warn', `更新检查失败: ${String(err)}`)
  }
}

/** v2.4.2（C3）：系统通知——返回是否真实发出；点击通知唤起主窗口；不可用时降级给应用内事件，不假成功 */
function sendSystemNotification(title: string, body: string): boolean {
  if (!Notification.isSupported()) {
    void log('warn', `系统通知不受支持，已降级为应用内提醒: ${title}`)
    return false
  }
  try {
    const n = new Notification({ title, body })
    // v2.4.2（批次二）：点击通知 → 唤起主窗口（休眠销毁后自动重建）
    n.on('click', () => windowShow())
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

  // v2.4.7：交换区投递服务（PLAN §8）——ledger sink 已在 BoxService 构造器内接入发票/入库台账
  // （查重等账务规则单点落在台账服务，§6.2「三入口同函数」）；此处只做生命周期装配：
  // 工作区打开/切换时 stop + start（watch 句柄与防抖定时器成对释放重建）+ 启动补扫
  const exchange = box.exchange

  registerIpc(box, account)
  registerQiheboxProtocol(box, () => thumbs.currentThumbsRoot())

  // v2.4.7（评审 P5）：重启后恢复已登录账号的心跳——登录态由 account.json 持久化，
  // 此前只有 login() 内启动心跳，重启后心跳静默丢失（startHeartbeat 幂等，登录路径仍会重复调用无害）
  if (account.status().loggedIn) account.startHeartbeat()


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
        // v2.4.7：交换区监听随工作区切换关闭重建（watch 句柄与防抖定时器成对释放）+ 立即补扫
        exchange.stop()
        void exchange.start().catch((err) => void log('warn', `交换区补扫失败: ${String(err)}`))
      })
      // v2.4.7：启动补扫推迟到后台任务阶段异步执行（不进 app ready → 窗口可交互关键路径，PLAN §一.3）
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
      return runStartupTasks(box)
    })

  // v2.3.0：统一窗口初始化钩子——休眠销毁后的重建（ensureMainWindow）自动带上崩溃自愈与托盘行为
  setWindowCreateHandler((win) => {
    setupCrashRecovery(win)
    setupRendererConsoleForward(win)
    setupCloseToTray(win)
    win.on('closed', () => {
      void log('info', '[window] 主窗口已销毁（休眠回收或退出）')
    })
  })

  const win = createMainWindow()
  setupTray()
  setupCrashRecovery(win)
  setupRendererConsoleForward(win)
  setupCloseToTray(win)
  // v2.4.7（F10）：系统休眠唤醒自愈——resume 后分层检查，白屏自动 reload（含画面像素检测）
  setupWakeRecovery()

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
// v2.4.7（评审 P3）：统一复用 windowShow()——不再直接 show/focus 绕过 ready-to-show 守卫
// （v2.4.3 F2 黑屏修复：加载中的窗口提前 show 会露出深色空窗，二次启动同样适用）
app.on('second-instance', () => {
  windowShow()
})

// 主进程未捕获异常 → 日志落盘
process.on('uncaughtException', (err) => {
  void log('error', `uncaughtException: ${err?.stack ?? err}`)
})
process.on('unhandledRejection', (reason) => {
  void log('error', `unhandledRejection: ${String(reason)}`)
})
