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
import type { BoxService } from '../core'
import type { AccountService } from '../account'
import type { SettingsService } from '../settings'
import { log } from '../log'
import { getMainWindow, windowShow } from '../window'
import type { ApiResult } from '../../shared/types'
import { ok, fail, handle, sendTo } from '../ipc'
import { PluginRegistry, PLUGINS_DIR, STATE_DIR } from './registry'
import { PluginLoader } from './loader'
import { PluginInstaller } from './installer'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST, fileError, mapCoreError } from './host'
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

export interface PluginHostHandle {
  /** 宿主事件入口（装配层桥接 workspaceChanged 等；channel 白名单强校验，白名单外忽略） */
  emitHostEvent(channel: string, data: unknown): void
  /** 退出清理：同步触发全部已激活插件 dispose + 事件总线清理（无泄漏） */
  dispose(): Promise<void>
}

/**
 * 插件宿主装配（PLAN §六）：registerIpc 之后调用一次。
 * v2.5 增量（PLAN §3.2）：以参数接收 AccountService，闭包注入 PluginHostDeps（不改 BoxService/core 装配面）；
 * （PLAN §3.5）：以参数接收 settings（devMode 校验在 install handler 层，installer.ts 保持纯 TS 不感知 devMode）。
 * 默认状态（未安装任何插件）下只多一个空 registry 与若干 IPC 通道——主进程无插件相关对象（PLAN §九）。
 */
export function registerPluginHost(
  box: BoxService,
  account: Pick<AccountService, 'getToken' | 'isLoggedIn'>,
  settings: Pick<SettingsService, 'getDevMode'>,
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
    createHost: (id, manifest) =>
      createPluginHost({
        pluginId: id,
        ipcPrefix: manifest.ipcPrefix,
        stateDir: path.join(root, id, STATE_DIR),
        bus,
        log: (level, msg) => void log(level, `[plugin:${id}] ${msg}`),
        workspace: {
          currentPath: () => box.workspace.currentWorkspacePath(),
          list: () => box.workspace.list(),
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
        },
        accountAccess: manifest.permissions?.account === true,
        // v2.5.1（A1/A2，PLAN-v2.6-v2.7 §3.1/§3.2）：customers/share 能力域适配器 + 门控
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
  ipcMain.handle('qihebox:plugins:install', (_e, source: { filePath: string }) =>
    handle(async () => {
      // v2.5 增量（PLAN §3.5，r2-执行P1-4 落点定死）：侧载收紧——devMode 校验放 handler 层，
      // 关闭时拒绝（默认关）；installer.ts 保持纯 TS 不感知 devMode
      if (!settings.getDevMode()) {
        throw new Error('DEV_MODE_REQUIRED：侧载安装需先在「设置 → 开发者模式」中开启开发者模式')
      }
      const r = await installer.install(source?.filePath)
      broadcastPluginsChanged()
      // 覆盖安装（2026-08-16 方案 A）：旧实例的模块已被替换（pkg/ 换新），
      // 先 dispose 旧实例（停用回收订阅/端口），再重新激活新实例（state/ 保留，数据不丢）
      if (r.replaced) {
        loader.deactivate(r.id)
        broadcastPluginsChanged()
      }
      // v2.5.1（再定位方案 A，动作-2026-08-15）：安装成功且启用 → 立即激活（装完即用）。
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
