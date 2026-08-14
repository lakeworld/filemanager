/**
 * 插件宿主 IPC 层（v2.5，P0）：qihebox:plugins:{list,setEnabled,call,install,uninstall} + 事件广播。
 * 装配入口：registerPluginHost(box, account, settings)（PLAN §六——registerIpc 之后追加）——
 * 装配期只做已安装包清单登记（同步微秒级，不加载任何插件代码；惰性加载归 loader.ts），
 * 随后注册 IPC 通道、plugins:changed 广播（payload=PluginInfo[]）、插件事件桥（qihebox:event:<channel>）。
 * 宿主事件入口：emitHostEvent(channel, data)（装配层在 workspaceChanged / certExpiring / updateAvailable /
 * importComplete 发生时调用，channel 白名单强校验）。
 * v2.5 增量：不移植 qihebox:ai:call / aiCall（v2.4.7 时代残留）；install 的 devMode 校验在本层 handler。
 * 退出清理：dispose() → 全部已激活插件 dispose()（尽力，超时 2s 不强等，PLAN §六.4）。
 */
import { app, ipcMain, dialog, BrowserWindow, Notification } from 'electron'
import path from 'node:path'
import type { BoxService } from '../core'
import type { AccountService } from '../account'
import type { SettingsService } from '../settings'
import { log } from '../log'
import { getMainWindow, windowShow } from '../window'
import type { ApiResult } from '../../shared/types'
import { PluginRegistry, PLUGINS_DIR, STATE_DIR } from './registry'
import { PluginLoader } from './loader'
import { PluginInstaller } from './installer'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST } from './host'

// —— ApiResult 包装（与 src/main/ipc.ts 同构：薄壳只做透传，业务在插件宿主层）——

function ok<T>(data: T): ApiResult<T> {
  return { success: true, data, error: null }
}

function fail<T>(err: unknown): ApiResult<T> {
  return { success: false, data: null, error: err instanceof Error ? err.message : String(err) }
}

async function handle<T>(fn: () => Promise<T> | T): Promise<ApiResult<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    return fail<T>(err)
  }
}

/** 向窗口发送事件的安全通道（窗口被休眠销毁后 webContents.send 抛错 → 守卫 + try/catch，同 src/main/ipc.ts） */
function sendTo(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    // 发送瞬间被销毁的竞态兜底
  }
}

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
  /** 退出清理：全部已激活插件 dispose()（尽力，超时 2s 不强等）+ 事件总线清理（无泄漏） */
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
  const registry = new PluginRegistry({ root, hostVersion: app.getVersion() })
  registry.scan() // 装配期同步登记（微秒级：仅读 manifest 清单），不加载任何插件代码

  const bus = new HostEventBus((level, msg) => void log(level, msg))
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
      registry.setEnabled(id, !!enabled)
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
  ipcMain.handle('qihebox:plugins:call', (_e, pluginId: string, action: string, payload: unknown) =>
    handle(() => loader.call(pluginId, action, payload)),
  )
  ipcMain.handle('qihebox:plugins:install', (_e, source: { filePath: string }) =>
    handle(async () => {
      // v2.5 增量（PLAN §3.5，r2-执行P1-4 落点定死）：侧载收紧——devMode 校验放 handler 层，
      // 关闭时拒绝（默认关）；installer.ts 保持纯 TS 不感知 devMode
      if (!settings.getDevMode()) {
        throw new Error('DEV_MODE_REQUIRED：侧载安装需先在「设置 → 开发者模式」中开启开发者模式')
      }
      const r = await installer.install(source?.filePath)
      broadcastPluginsChanged()
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
      await loader.disposeAll(2000)
      bus.clear()
    },
  }
}
