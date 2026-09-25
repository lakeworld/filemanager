/**
 * 插件宿主 IPC 层（v2.5，P0）：qihebox:plugins:{list,setEnabled,call,install,uninstall} + 事件广播。
 * 装配入口：registerPluginHost(box, account, settings)（PLAN §六——registerIpc 之后追加）——
 * 装配期只做已安装包清单登记（同步微秒级，不加载任何插件代码；惰性加载归 loader.ts），
 * 随后注册 IPC 通道、plugins:changed 广播（payload=PluginInfo[]）、插件事件桥（qihebox:event:<channel>）。
 * 宿主事件入口：emitHostEvent(channel, data)（装配层在 workspaceChanged / certExpiring / updateAvailable /
 * importComplete 发生时调用，channel 白名单强校验）。
 * v2.5 增量：不移植 qihebox:ai:call / aiCall（v2.4.7 时代残留）；install 的 devMode 校验在本层 handler。
 * 退出清理：dispose() → 同步触发全部已激活插件 dispose（v2.5.3 T3：disposeAll 同步完成，第一拍不延后）。
 */
import { app, ipcMain, dialog, BrowserWindow, Notification } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import type { BoxService } from '../core'
import type { AccountService } from '../account'
import type { SettingsService } from '../settings'
import { log } from '../log'
import { getMainWindow, windowShow } from '../window'
import type { ApiResult, PluginInstallSource } from '../../shared/types'
import { ok, fail, handle, sendTo } from '../ipc'
import { thumbnailFileUrl } from '../protocol'
import { PluginRegistry, PLUGINS_DIR, STATE_DIR } from './registry'
import { PluginLoader } from './loader'
import { PluginInstaller } from './installer'
import type { InstallResult } from './installer'
import { resolveOfficialPluginsDir, runOfficialPreinstall } from './preinstall'
import { fetchCatalog } from './catalog'
import { downloadPluginPackage } from './download'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST, fileError, mapCoreError } from './host'
import { makePluginSecretStore } from './secretStore'

import { API_VERSION } from '../../plugins/types'
import type { InboundProfile, InvoiceProfile } from '../../plugins/types'
import { ShareViewService } from '../core/shareView'

// ApiResult 包装（ok/fail/handle/sendTo）自 src/main/ipc.ts 复用（薄壳纪律单点）

/** 受限对话框能力（host.dialog）：仅选择，不放开任意路径（PLUGIN.md §2.4.1） */
async function openDialog(kind: 'file' | 'directory', opts: unknown): Promise<string> {
  const win = getMainWindow()
  const o = (opts ?? {}) as { title?: string; filters?: unknown }
  const base: Electron.OpenDialogOptions = {
    title: o.title || (kind === 'directory' ? '选择文件夹' : '选择文件'),
    properties: kind === 'directory' ? ['openDirectory', 'createDirectory'] : ['openFile'],
  }
  if (kind === 'file' && Array.isArray(o.filters)) base.filters = o.filters as Electron.FileFilter[]
  const r = win ? await dialog.showOpenDialog(win, base) : await dialog.showOpenDialog(base)
  return r.canceled || r.filePaths.length === 0 ? '' : r.filePaths[0]
}

/**
 * v2.5.1（A1/A2）：core 调用错误码映射包装——catch 回调返回 PluginBusinessError
 * 会让 TS 把错误并入成功分支类型，故用显式包装：捕获后重抛映射错误（不返回值）。
 */
async function mapReject<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (err) {
    throw mapCoreError(err)
  }
}

/** 系统通知（与 src/main/index.ts sendSystemNotification 同语义）：返回是否真实发出；点击唤起主窗口 */
function sendSystemNotification(title: string, body: string): boolean {
  if (!Notification.isSupported()) return false
  try {
    const n = new Notification({ title, body })
    n.on('click', () => windowShow())
    n.show()
    return true
  } catch {
    return false
  }
}

/** v2.5.7（协议增量 E1）：InvoiceRecord → InvoiceProfile 投影（剥离 ocr_ext 命名空间——本体只读，插件不可见） */
function toInvoiceProfile(r: {
  number: string
  code?: string
  date: string
  amount: number
  seller: string
  buyer: string
  status: '待报销' | '已报销' | '已入账'
  customer?: string
  due_date?: string
  file_path: string
  tags?: string[]
  notes?: string
  created_at: string
  updated_at: string
}): InvoiceProfile {
  return {
    number: r.number,
    code: r.code,
    date: r.date,
    amount: r.amount,
    seller: r.seller,
    buyer: r.buyer,
    status: r.status,
    customer: r.customer,
    due_date: r.due_date,
    file_path: r.file_path,
    tags: r.tags,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/** v2.5.7（协议增量 E2）：InboundRecord → InboundProfile 投影（直投，无命名空间可剥离） */
function toInboundProfile(r: {
  id: string
  date: string
  supplier: string
  supplier_id?: string
  product_set?: string
  file_path: string
  amount?: number
  notes?: string
  created_at: string
  updated_at: string
}): InboundProfile {
  return {
    id: r.id,
    date: r.date,
    supplier: r.supplier,
    supplier_id: r.supplier_id,
    product_set: r.product_set,
    file_path: r.file_path,
    amount: r.amount,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export interface PluginHostHandle {
  /** 宿主事件入口（装配层桥接 workspaceChanged 等；channel 白名单强校验，白名单外忽略） */
  emitHostEvent(channel: string, data: unknown): void
  /** 退出清理：同步触发全部已激活插件 dispose + 事件总线清理（无泄漏） */
  dispose(): Promise<void>
}

/**
 * v2.6（批 3）：官方插件预装源目录解析——打包态 = 安装包内 `resources/official-plugins/`
 * （electron-builder `extraResources` 由发布侧注入，内容不进公开仓）；开发/未打包态回退仓库内
 * `build/official-plugins/`。开源构建两处皆空 ⇒ 预装零条目（宿主侧目录缺失优雅跳过）。
 */
function officialPluginsDir(): string {
  return resolveOfficialPluginsDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devFallbackDir: path.join(app.getAppPath(), 'build', 'official-plugins'),
  })
}

/**
 * 插件宿主装配（PLAN §六）：registerIpc 之后调用一次。
 * v2.5 增量（PLAN §3.2）：以参数接收 AccountService，闭包注入 PluginHostDeps（不改 BoxService/core 装配面）；
 * （PLAN §3.5）：以参数接收 settings（devMode 校验在 install handler 层，installer.ts 保持纯 TS 不感知 devMode）。
 * 默认状态（未安装任何插件）下只多一个空 registry 与若干 IPC 通道——主进程无插件相关对象（PLAN §九）。
 */
export function registerPluginHost(
  box: BoxService,
  account: Pick<AccountService, 'getToken' | 'isLoggedIn' | 'getDeviceId'>,
  settings: Pick<SettingsService, 'getDevMode' | 'getAll'>,
  /** v2.5.7（F4a）：云 API 服务地址（resolveApiBase()，公开仓不写死地址）；空 = 云能力不可用 */
  cloudBaseUrl = '',
): PluginHostHandle {
  const root = path.join(app.getPath('userData'), PLUGINS_DIR)
  const registry = new PluginRegistry({ root, hostVersion: app.getVersion(), log })
  registry.scan() // 装配期同步登记（微秒级：仅读 manifest 清单），不加载任何插件代码

  const bus = new HostEventBus((level, msg) => void log(level, msg))
  // v2.5.1（A2）：share 能力域 core 实例（装配层单例，host.share 适配器注入）
  // v2.5.5：子文件夹自动注册 → 广播渲染侧面板即时刷新（参照 accountChanged 等既有 events.on 通道）
  const shareView = new ShareViewService(box, {
    onSubfolderRegistered: (info) => {
      for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'qihebox:event:share:subfolder-registered', info)
    },
  })
  const loader = new PluginLoader({
    registry,
    root,
    // v2.5.7（F5b）：官方加密插件取钥依赖（baseUrl + 登录 token + 密钥缓存目录 + safeStorage 落盘加密）
    keyDeps: {
      baseUrl: cloudBaseUrl,
      getToken: () => account.getToken(),
      cacheDir: path.join(app.getPath('userData'), PLUGINS_DIR, 'keys'),
      secretStore: makePluginSecretStore(),
    },
    createHost: (id, manifest) =>
      createPluginHost({
        pluginId: id,
        ipcPrefix: manifest.ipcPrefix,
        stateDir: path.join(root, id, STATE_DIR),
        bus,
        log: (level, msg) => void log(level, `[plugin:${id}] ${msg}`),
        workspace: {
          // v2.6.1：core 在「没开工作区」时返回空串，而契约承诺 `string | null` ⇒ 装配层归一为 null
          // （不留空串这条二义：插件按 `!== null` 判「有没有工作区」正是文档教的写法）。
          currentPath: () => box.workspace.currentWorkspacePath() || null,
          list: () => box.workspace.list(),
          // v2.6.1：默认工作区 = userData/settings.json 的持久指针（不是 currentWS）⇒ 插件在 activate 期
          // 就能知道「本次启动将要打开哪个盘」，不受 registerPluginHost 早于工作区恢复的时序影响。只读。
          defaultPath: () => settings.getAll().defaultWorkspace || null,
        },
        dialog: {
          openFile: (opts) => openDialog('file', opts),
          openDirectory: (opts) => openDialog('directory', opts),
        },
        notify: (title, body) => sendSystemNotification(title, body),
        // 插件事件 → 渲染层：主进程发 qihebox:event:<channel>（channel 已由 host.events.emit 前缀强校验）
        emitToRenderer: (channel, data) => {
          for (const win of BrowserWindow.getAllWindows()) sendTo(win, `qihebox:event:${channel}`, data)
        },
        // v2.5 增量（PLAN §3.2 接线层③/④）：AccountService 同步接口注入；permissions.account 门控
        account: {
          getToken: () => account.getToken(),
          isLoggedIn: () => account.isLoggedIn(),
          // v2.6（批 1）：本机设备标识（与心跳同源）——插件用它向 /api/box/me 传 current_device_id，
          // 服务端据此在设备清单标「本机」（is_current）；旧插件不调用即无影响（只增不删）
          getDeviceId: () => account.getDeviceId(),
        },
        // v2.5.7（F4a）：cloudFetch 宿主代签——baseUrl 由装配层注入（公开仓不写死服务器地址）
        cloudFetchImpl: { baseUrl: cloudBaseUrl },
        accountAccess: manifest.permissions?.account === true,
        // v2.5.1（A1/A2，内部设计文档 §3.1/§3.2）：customers/share 能力域适配器 + 门控
        // core 裸错误经 mapCoreError 映射为契约错误码（不计熔断）
        customers: {
          list: (since) => mapReject(box.clients.listSince(since)),
          get: async (name) => mapReject(box.clients.get(name)),
          writeErpExt: (name, ext) => mapReject(box.clients.writeErpExt(name, ext)),
          syncProfile: async (req) => {
            const r = await mapReject(box.clients.syncProfile(req))
            // D6：applied:false = STALE（回显式乐观锁：req.updated_at ≤ 档案 updated_at）
            if (!r.applied) throw fileError('STALE', '档案 updated_at 不早于请求，拒绝写入（STALE）')
            return r
          },
          relation: {
            link: (c, p) => mapReject(box.clients.linkRelation(c, p)).then(() => undefined),
            unlink: (c, p) => mapReject(box.clients.unlinkRelation(c, p)).then(() => undefined),
          },
        },
        customersAccess: manifest.permissions?.customers === true,
        // v2.5.4（弹一 C-1，云桥 M3）：suppliers 能力域适配器 + 门控（照 customers；core 错误经 mapCoreError）。
        // list/get 投影规范化：SupplierProfile 承诺 notes/tags 恒存（core buildInfo 已填默认值，此处仅收窄类型）
        suppliers: {
          list: (since) =>
            mapReject(box.suppliers.listSince(since)).then((l) =>
              l.map((s) => ({ ...s, notes: s.notes ?? '', tags: s.tags ?? [] })),
            ),
          get: async (name) =>
            mapReject(box.suppliers.get(name)).then((s) =>
              s ? { ...s, notes: s.notes ?? '', tags: s.tags ?? [] } : null,
            ),
          writeErpExt: (name, ext) => mapReject(box.suppliers.writeErpExt(name, ext)),
          syncProfile: async (req) => {
            const r = await mapReject(box.suppliers.syncProfile(req))
            // D6：applied:false = STALE（回显式乐观锁：req.updated_at ≤ 档案 updated_at）
            if (!r.applied) throw fileError('STALE', '档案 updated_at 不早于请求，拒绝写入（STALE）')
            return r
          },
        },
        suppliersAccess: manifest.permissions?.suppliers === true,
        // v2.5.4（弹一 C-4，云桥 M3）：quote 只读域适配器（只读投影 + 增量；门控并入 customers 同一位）
        quotes: {
          list: (since) => mapReject(box.quotes.listSince(since)),
          get: async (quotationNo) => mapReject(box.quotes.get(quotationNo)).then((q) => q ?? null),
        },
        // v2.5.7（协议增量 E1/E2）：invoice / inbound 只读域适配器（只读投影 + 增量；门控并入 customers 同一位
        // ——与 quote 同：同一客户关系数据面权限位不碎片化）。投影版（去 ocr_ext）在 core 层已剥离命名空间由
        // 装配层做字段收窄（对齐 QuoteProfile 逐字段拷贝——见 host 的 InvoiceProfile/InboundProfile 形状）
        invoices: {
          list: (since) =>
            mapReject(box.invoices.listSince(since)).then((l) => l.map(toInvoiceProfile)),
          get: async (number) =>
            mapReject(box.invoices.get(number)).then((r) => (r ? toInvoiceProfile(r) : null)),
        },
        inbounds: {
          list: (since) =>
            mapReject(box.inbound.listSince(since)).then((l) => l.map(toInboundProfile)),
          get: async (id) =>
            mapReject(box.inbound.get(id)).then((r) => (r ? toInboundProfile(r) : null)),
        },
        share: {
          listProductSets: () => mapReject(shareView.listProductSets()),
          listCustomers: () => mapReject(shareView.listCustomers()),
          listTree: (p) => mapReject(shareView.listTree(p)),
          getMetadata: (p) => mapReject(shareView.getMetadata(p)),
          statFile: (p) => mapReject(shareView.statFile(p)),
          readFileChunk: (p, o, l) => mapReject(shareView.readFileChunk(p, o, l)),
          writePulledFile: (p, c, o) => mapReject(shareView.writePulledFile(p, c, o)),
          ensureProductSet: (n) => mapReject(shareView.ensureProductSet(n)),
          ensureCustomer: (n) => mapReject(shareView.ensureCustomer(n)),
          ensureSubfolder: (k, h, n) => mapReject(shareView.ensureSubfolder(k, h, n)),
          mergePulledMetadata: (e) => mapReject(shareView.mergePulledMetadata(e)),
          // v2.5.7（协议增量 E4）：缩略图路径 → 协议 URL（thumbnailFileUrl 装配层包装，core 无协议概念）
          getThumb: (p, s) =>
            mapReject(shareView.getThumb(p, s)).then((path) => (path ? thumbnailFileUrl(path) : '')),
        },
        shareAccess: manifest.permissions?.share === true,
      }),
    log: (level, msg) => void log(level, msg),
  })
  // 熔断自动 broken → 广播（管理页即时展示）
  loader.onChanged = broadcastPluginsChanged

  const installer = new PluginInstaller({ root, registry, log: (level, msg) => void log(level, msg) })

  /** 安装/卸载/启停变化 → qihebox:event:plugins:changed（payload=PluginInfo[]） */
  function broadcastPluginsChanged(): void {
    const payload = registry.list()
    for (const win of BrowserWindow.getAllWindows()) sendTo(win, 'qihebox:event:plugins:changed', payload)
  }

  // —— v2.6（批 3）：官方插件预装（内部设计文档 §四）——装配期**一次**、启动早期、异步 fire-and-forget。
  // 整函数吞异常（单包失败只 warn + 进报告）⇒ 不进「app ready → 窗口可交互」关键路径，失败不阻断启动；
  // 开源自建构建不带预装目录 ⇒ 目录缺失优雅跳过、零预装条目（runOfficialPreinstall 内部判定）。
  void runOfficialPreinstall({
    dir: officialPluginsDir(),
    root,
    registry,
    installer,
    log: (level, msg) => void log(level, msg),
  })
    .then((report) => {
      if (report.installed + report.updated === 0) return
      // 首启零操作即可见：管理页/侧栏派生自 plugins:changed 广播（渲染层首拉清单 + 本广播双保险）
      broadcastPluginsChanged()
      // 与 install handler 同口径「装完即用」：预装且启用 → 立即激活（不等下一次触发）
      for (const e of report.entries) {
        if ((e.action === 'installed' || e.action === 'updated') && e.id && registry.get(e.id)?.enabled) {
          void loader.ensureActive(e.id).catch((err) => void log('warn', `预装插件激活失败（${e.id}）: ${String(err)}`))
        }
      }
    })
    .catch((err) => void log('warn', `[plugins] 官方插件预装编排异常（已忽略）: ${String(err)}`))

  // —— IPC（全部 ApiResult 包装，交叉契约 §三）——
  ipcMain.handle('qihebox:plugins:list', () => handle(() => registry.list()))
  ipcMain.handle('qihebox:plugins:setEnabled', (_e, id: string, enabled: boolean) =>
    handle(async () => {
      const wasBroken = registry.get(id)?.state === 'broken'
      await registry.setEnabled(id, !!enabled)
      if (!enabled) {
        loader.deactivate(id)
      } else if (wasBroken) {
        // 熔断重试（PLAN §3.3）：setEnabled(id, true) 已清 failCount，立即重新激活
        void loader.ensureActive(id).catch((err) => void log('warn', `插件重新激活失败（${id}）: ${String(err)}`))
      }
      broadcastPluginsChanged()
      return true
    }),
  )
  ipcMain.handle('qihebox:plugins:call', async (_e, pluginId: string, action: string, payload: unknown) => {
    // v2.5.4（发票识别）：插件 IPC 返回值已是 ApiResult 形状 → 透传不重复包装（防双层信封）；
    // 异常仍装 fail 信封（熔断由 loader 负责，此处只管通信形状）。
    let r: unknown
    try {
      r = await loader.call(pluginId, action, payload)
    } catch (err) {
      return fail<unknown>(err)
    }
    if (r && typeof r === 'object' && 'success' in r && typeof (r as { success: unknown }).success === 'boolean') {
      return r
    }
    return ok(r)
  })
  // v2.6 批 2：官方索引目录（进入管理页时拉取一次，**不后台轮询**——网络常驻红线）。
  // 数据源 = 启禾云账号 API（与账号/云通道同基址，走登录态 JWT）；端点契约见 main/plugins/catalog.ts 头注释。
  // 未登录 / 未配置服务器 / 端点未部署 → 中文错误如实上报（不谎报空目录）。
  ipcMain.handle('qihebox:plugins:catalog', () =>
    handle(() =>
      fetchCatalog(
        {
          baseUrl: cloudBaseUrl,
          getToken: () => account.getToken(),
          log: (level, msg) => void log(level, `[plugins] ${msg}`),
        },
        { apiVersion: API_VERSION, productVersion: app.getVersion() },
      ),
    ),
  )
  ipcMain.handle('qihebox:plugins:install', (_e, source: PluginInstallSource) =>
    handle(async () => {
      // v2.6 批 2：install 双形态（docs/PLUGIN.md §5.3）——
      // ① { downloadUrl, sha256 } 官方索引形态：需登录态 + SHA-256 逐字节校验，**不要求 devMode**
      //    （官方索引发的是审核过的包；devMode 是侧载那道门）；临时包体在 finally 里删除（不落盘半包）。
      // ② { filePath } 侧载形态：devMode 校验放 handler 层，关闭时拒绝（默认关）；
      //    installer.ts 保持纯 TS 不感知 devMode。**侧载语义零变更**。
      const downloadSrc = source as { downloadUrl?: unknown; sha256?: unknown } | undefined
      let r: InstallResult
      if (downloadSrc && typeof downloadSrc.downloadUrl === 'string') {
        const dl = await downloadPluginPackage(
          {
            baseUrl: cloudBaseUrl,
            getToken: () => account.getToken(),
            log: (level, msg) => void log(level, `[plugins] ${msg}`),
          },
          {
            downloadUrl: downloadSrc.downloadUrl,
            sha256: typeof downloadSrc.sha256 === 'string' ? downloadSrc.sha256 : '',
            destDir: root,
          },
        )
        try {
          r = await installer.install(dl.filePath)
        } finally {
          await fsp.rm(dl.filePath, { force: true }).catch(() => {})
        }
      } else {
        if (!settings.getDevMode()) {
          throw new Error('DEV_MODE_REQUIRED：侧载安装需先在「设置 → 开发者模式」中开启开发者模式')
        }
        r = await installer.install((source as { filePath?: string } | undefined)?.filePath ?? '')
      }
      broadcastPluginsChanged()
      // 覆盖安装（2026-08-16 方案 A）：旧实例的模块已被替换（pkg/ 换新），
      // 先 dispose 旧实例（停用回收订阅/端口），再重新激活新实例（state/ 保留，数据不丢）
      if (r.replaced) {
        loader.deactivate(r.id)
        broadcastPluginsChanged()
      }
      // v2.5.1（再定位方案 A，内部动作记录）：安装成功且启用 → 立即激活（装完即用）。
      // 此前新装插件在用户登录时收不到 accountChanged（事件只达已激活订阅者，安装不激活、
      // onStartupFinished 已过）→「装插件后登录没反映」；activate 自检登录态可兜底起服务。
      if (registry.get(r.id)?.enabled) {
        void loader.ensureActive(r.id).catch((err) => {
          void log('error', `插件安装后激活失败（${r.id}）: ${String(err)}`)
        })
      }
      return registry.info(r.id) ?? null
    }),
  )
  ipcMain.handle('qihebox:plugins:uninstall', (_e, id: string) =>
    handle(async () => {
      loader.deactivate(id)
      await installer.uninstall(id)
      broadcastPluginsChanged()
      return true
    }),
  )

  /** 宿主事件 → 插件（白名单强校验；触发 onEvent 惰性激活 + 投递已激活插件订阅） */
  function emitHostEvent(channel: string, data: unknown): void {
    if (!(HOST_EVENT_WHITELIST as readonly string[]).includes(channel)) {
      void log('warn', `[plugins] 宿主事件通道不在白名单，忽略：${channel}`)
      return
    }
    loader.onHostEvent(channel)
    bus.emitHost(channel, data)
  }

  // onStartupFinished：启动完成后延迟激活（setTimeout 推迟到窗口创建之后，不进 app ready → 可交互关键路径）
  setTimeout(() => loader.onStartupFinished(), 0)

  return {
    emitHostEvent,
    async dispose(): Promise<void> {
      // disposeAll 同步完成全部同步 dispose（第一拍不延后到微任务，退出窗口内已执行）
      loader.disposeAll()
      bus.clear()
    },
  }
}
