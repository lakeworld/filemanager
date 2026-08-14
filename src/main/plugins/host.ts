/**
 * 插件宿主能力实现（v2.5，P0）：PluginHost 的每插件实例（PLUGIN.md §2.4.1 / PLAN §三.4）。
 * - storage：userData/plugins/<id>/state/ 每 key 一个 JSON 文件；激活时一次性读入内存缓存、写时落盘；
 *   限界：单 key ≤ 1MB、总容量 ≤ 64MB（超限拒绝并报错，可注入缩小便于测试）
 * - events：on 订阅宿主事件白名单（workspaceChanged/importComplete/certExpiring/updateAvailable），
 *   emit 通道强校验以本插件 ipcPrefix 开头（防冒充本体事件，PLUGIN.md §2.6）
 * - workspace/dialog/notify：受限能力（由装配层注入实现，不放开任意路径读写与 shell）
 * - account（v2.5 增量 PLAN §3.2）：装配层注入 AccountService 同步接口；manifest.permissions.account !== true
 *   时注入空实现（恒 null / false）
 * - files（v2.5 增量 PLAN §3.3）：工作区受限读写（readText ≤10MB / readBuffer ≤50MB / writeExport ≤50MB），
 *   全部错误为带 code 的业务错误（loader 熔断不计，PLAN §3.3 r2-性能P1-2）
 * - entitlement（v2.5 增量 PLAN §3.4）：恒 free 占位（红线 4：本体零订阅实现）
 * 纯 TS：不 import electron（dialog/notify/workspace/emitToRenderer 由装配层注入），可在 node 环境直接测试。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { API_VERSION } from '../../plugins/types'
import type { EntitlementStatus, PluginBusinessError, PluginHost } from '../../plugins/types'
import { EXPORTS_DIR, assertSafeFileName, isPathInsideWorkspaceReal, writeJsonAtomic } from '../core/paths'

/** 宿主事件白名单（插件 host.events.on 仅可订阅这些通道；装配层在此发事件） */
export const HOST_EVENT_WHITELIST = ['workspaceChanged', 'importComplete', 'certExpiring', 'updateAvailable'] as const
export type HostEventChannel = (typeof HOST_EVENT_WHITELIST)[number]

/** 存储限界（PLUGIN.md §2.6 规则 2）：单 key ≤ 1MB、总容量 ≤ 64MB；
 *  文件能力域限界（PLAN §3.3）：readText ≤ 10MB、readBuffer ≤ 50MB、writeExport ≤ 50MB（可注入缩小便于测试） */
export interface StorageLimits {
  maxKeyBytes?: number
  maxTotalBytes?: number
  maxReadTextBytes?: number
  maxReadBufferBytes?: number
  maxExportBytes?: number
}
export const DEFAULT_STORAGE_LIMITS: Required<StorageLimits> = {
  maxKeyBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxReadTextBytes: 10 * 1024 * 1024,
  maxReadBufferBytes: 50 * 1024 * 1024,
  maxExportBytes: 50 * 1024 * 1024,
}

/** 宿主事件总线：跨插件共享（装配层单例）。插件经 host.events.on 订阅；装配层经 emitHost 投递 */
export class HostEventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(log?: (level: 'info' | 'warn' | 'error', msg: string) => void) {
    this.log = log ?? (() => {})
  }

  /** 插件侧订阅（返回退订函数；退订幂等） */
  pluginOn(channel: string, cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(cb)
    let unsubbed = false
    return () => {
      if (unsubbed) return
      unsubbed = true
      const s = this.listeners.get(channel)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.listeners.delete(channel)
    }
  }

  /** 装配层投递宿主事件：逐个调用订阅回调，单插件异常不阻断其余订阅 */
  emitHost(channel: string, data: unknown): void {
    const set = this.listeners.get(channel)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch (err) {
        this.log('error', `[plugins] 插件事件回调异常（${channel}）: ${String(err)}`)
      }
    }
  }

  /** 退出清理：全部订阅解除（无泄漏） */
  clear(): void {
    this.listeners.clear()
  }
}

export interface PluginHostDeps {
  /** 插件 id（storage 目录归属与日志前缀） */
  pluginId: string
  /** 插件 ipcPrefix（events.emit 通道前缀强校验基准） */
  ipcPrefix: string
  /** userData/plugins/<id>/state */
  stateDir: string
  bus: HostEventBus
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
  workspace: { currentPath(): string | null; list(): unknown }
  dialog: { openFile(opts: unknown): Promise<string>; openDirectory(opts: unknown): Promise<string> }
  notify(title: string, body: string): boolean
  /** 插件事件 → 渲染层：向所有窗口发 qihebox:event:<channel>（装配层注入，带销毁守卫） */
  emitToRenderer(channel: string, data: unknown): void
  /** 账号服务同步接口（PLAN §3.2 接线层④）：装配层注入 AccountService 的 getToken/isLoggedIn */
  account: { getToken(): string | null; isLoggedIn(): boolean }
  /** manifest.permissions.account === true 时才接通真实账号；否则 host.account 恒 null/false（PLAN §3.2） */
  accountAccess: boolean
}

export interface PluginHostInstance {
  host: PluginHost
  /** 停用清理：解除事件订阅 + 释放状态缓存（loader 停用/退出时调用） */
  dispose(): void
}

/**
 * 构造单插件 PluginHost 实例（激活时读入 state/ 内存缓存）。
 * 激活时序（loader）：createPluginHost → activate(host)；storage 缓存与事件订阅随实例生命周期回收。
 */
export async function createPluginHost(deps: PluginHostDeps, limits?: StorageLimits): Promise<PluginHostInstance> {
  const lim = { ...DEFAULT_STORAGE_LIMITS, ...limits }
  const cache = new Map<string, unknown>()
  const sizes = new Map<string, number>()
  let totalBytes = 0

  /** 激活时一次性读入内存缓存（限界内安全；损坏/超限单文件跳过不阻塞激活） */
  async function warmCache(): Promise<void> {
    let files: string[] = []
    try {
      files = await fsp.readdir(deps.stateDir)
    } catch {
      return // state 目录不存在（首次激活）→ 空缓存
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const key = f.slice(0, -'.json'.length)
      try {
        const raw = await fsp.readFile(path.join(deps.stateDir, f), 'utf-8')
        const bytes = Buffer.byteLength(raw)
        if (bytes > lim.maxKeyBytes) {
          deps.log('warn', `状态文件超单 key 限界已跳过加载：${f}`)
          continue
        }
        if (totalBytes + bytes > lim.maxTotalBytes) {
          deps.log('warn', `状态总容量超限已跳过加载：${f}`)
          continue
        }
        cache.set(key, JSON.parse(raw))
        sizes.set(key, bytes)
        totalBytes += bytes
      } catch {
        // 单文件损坏跳过（不阻塞激活）
      }
    }
  }

  await warmCache()

  /** storage key 安全校验：非空字符串、拒绝路径分隔符与 . / ..（每 key 一个文件，state 目录内） */
  function assertSafeKey(keyRaw: unknown): string {
    if (typeof keyRaw !== 'string' || keyRaw.length === 0) throw new Error('storage key 须为非空字符串')
    if (keyRaw === '.' || keyRaw === '..' || keyRaw.includes('/') || keyRaw.includes('\\')) {
      throw new Error(`storage key 非法（拒绝路径分隔符与 ".." 逃逸）：${JSON.stringify(keyRaw)}`)
    }
    return keyRaw
  }

  const stateFilePath = (key: string): string => path.join(deps.stateDir, `${key}.json`)

  const storage = {
    async get(keyRaw: unknown): Promise<unknown> {
      const key = assertSafeKey(keyRaw)
      if (cache.has(key)) return cache.get(key)
      try {
        const raw = await fsp.readFile(stateFilePath(key), 'utf-8')
        const bytes = Buffer.byteLength(raw)
        if (bytes > lim.maxKeyBytes) {
          deps.log('warn', `状态文件超单 key 限界，读取返回 null：${key}`)
          return null
        }
        const parsed = JSON.parse(raw)
        if (totalBytes + bytes <= lim.maxTotalBytes) {
          cache.set(key, parsed)
          sizes.set(key, bytes)
          totalBytes += bytes
        }
        return parsed
      } catch {
        return null // 不存在/损坏 → null（与 readJsonFile 语义一致）
      }
    },
    async set(keyRaw: unknown, value: unknown): Promise<void> {
      const key = assertSafeKey(keyRaw)
      let json: string
      try {
        json = JSON.stringify(value)
      } catch {
        throw new Error('storage.set 值不可 JSON 序列化')
      }
      if (json === undefined) throw new Error('storage.set 值不可 JSON 序列化')
      const bytes = Buffer.byteLength(json)
      if (bytes > lim.maxKeyBytes) {
        throw new Error(`storage.set 超限：单 key 上限 ${(lim.maxKeyBytes / 1024).toFixed(0)}KB，当前 ${(bytes / 1024).toFixed(1)}KB`)
      }
      const prev = sizes.get(key) ?? 0
      if (totalBytes - prev + bytes > lim.maxTotalBytes) {
        throw new Error(`storage.set 超限：插件状态总容量上限 ${(lim.maxTotalBytes / 1024 / 1024).toFixed(0)}MB`)
      }
      await fsp.mkdir(deps.stateDir, { recursive: true })
      await writeJsonAtomic(stateFilePath(key), value)
      cache.set(key, value)
      totalBytes = totalBytes - prev + bytes
      sizes.set(key, bytes)
    },
  }

  const unsubs = new Set<() => void>()
  const events = {
    on(channel: string, cb: (data: unknown) => void): () => void {
      if (!(HOST_EVENT_WHITELIST as readonly string[]).includes(channel)) {
        throw new Error(
          `插件仅可订阅宿主事件白名单（${HOST_EVENT_WHITELIST.join(' / ')}），当前通道：${JSON.stringify(channel)}`,
        )
      }
      const unsub = deps.bus.pluginOn(channel, cb)
      unsubs.add(unsub)
      return () => {
        unsub()
        unsubs.delete(unsub)
      }
    },
    emit(channel: string, data: unknown): void {
      if (typeof channel !== 'string' || !channel.startsWith(deps.ipcPrefix)) {
        throw new Error(
          `插件事件通道必须以本插件 ipcPrefix "${deps.ipcPrefix}" 开头（防冒充本体事件），当前通道：${JSON.stringify(channel)}`,
        )
      }
      deps.emitToRenderer(channel, data)
    },
  }

  // —— v2.5 增量（PLAN §3.3）：工作区文件能力域（host.files，host.ts 内实现）——

  /** 带 code 的业务错误（loader 熔断对带 code 的错误不计数，PLAN §3.3 r2-性能P1-2） */
  function fileError(code: string, msg: string): PluginBusinessError {
    const e = new Error(msg) as PluginBusinessError
    e.code = code
    return e
  }

  /** relPath → 工作区内绝对路径：无工作区 / 非字符串 / realpath 逃逸分别抛 NO_WORKSPACE / INVALID_NAME / OUT_OF_WORKSPACE */
  async function resolveInWorkspace(relPath: unknown): Promise<string> {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw fileError('INVALID_NAME', '文件路径须为非空字符串')
    }
    if (relPath.includes('\0')) {
      throw fileError('INVALID_NAME', '文件路径不得包含 NUL 字符')
    }
    const ws = deps.workspace.currentPath()
    if (!ws) throw fileError('NO_WORKSPACE', '当前没有打开的工作区')
    const resolved = path.resolve(ws, relPath)
    if (!(await isPathInsideWorkspaceReal(ws, resolved))) {
      throw fileError('OUT_OF_WORKSPACE', `文件超出工作区范围：${relPath}`)
    }
    return resolved
  }

  const files = {
    async readText(relPath: unknown): Promise<string> {
      const resolved = await resolveInWorkspace(relPath)
      const stat = await fsp.stat(resolved).catch(() => null)
      if (!stat || !stat.isFile()) throw fileError('NOT_FOUND', `文件不存在：${String(relPath)}`)
      if (stat.size > lim.maxReadTextBytes) {
        throw fileError('TOO_LARGE', `文件超过文本读取上限（${(lim.maxReadTextBytes / 1024 / 1024).toFixed(0)}MB）：${String(relPath)}`)
      }
      try {
        return await fsp.readFile(resolved, 'utf-8')
      } catch (err) {
        throw fileError('IO_ERROR', `读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async readBuffer(relPath: unknown): Promise<Uint8Array> {
      const resolved = await resolveInWorkspace(relPath)
      const stat = await fsp.stat(resolved).catch(() => null)
      if (!stat || !stat.isFile()) throw fileError('NOT_FOUND', `文件不存在：${String(relPath)}`)
      if (stat.size > lim.maxReadBufferBytes) {
        throw fileError('TOO_LARGE', `文件超过二进制读取上限（${(lim.maxReadBufferBytes / 1024 / 1024).toFixed(0)}MB）：${String(relPath)}`)
      }
      try {
        return await fsp.readFile(resolved)
      } catch (err) {
        throw fileError('IO_ERROR', `读取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async writeExport(fileName: unknown, data: unknown): Promise<void> {
      if (typeof fileName !== 'string' || fileName.length === 0) {
        throw fileError('INVALID_NAME', '导出文件名须为非空字符串')
      }
      let safeName: string
      try {
        safeName = assertSafeFileName(fileName)
      } catch (err) {
        throw fileError('INVALID_NAME', err instanceof Error ? err.message : '导出文件名非法')
      }
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data instanceof Uint8Array ? data.byteLength : -1
      if (bytes < 0) throw fileError('INVALID_NAME', '导出数据须为字符串或 Uint8Array')
      if (bytes > lim.maxExportBytes) {
        throw fileError('TOO_LARGE', `导出数据超过上限（${(lim.maxExportBytes / 1024 / 1024).toFixed(0)}MB）`)
      }
      const ws = deps.workspace.currentPath()
      if (!ws) throw fileError('NO_WORKSPACE', '当前没有打开的工作区')
      // 平铺命名：导出/<pluginId>_<fileName>——listExports 只列导出根层文件、跳过目录（PLAN §3.3），
      // 子目录方案产物不可见；平铺命名零本体改动、exports:list 自动展示
      const target = path.join(ws, EXPORTS_DIR, `${deps.pluginId}_${safeName}`)
      if (!(await isPathInsideWorkspaceReal(ws, target))) {
        throw fileError('OUT_OF_WORKSPACE', '导出目录超出工作区范围')
      }
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, data as string | Uint8Array)
      } catch (err) {
        throw fileError('IO_ERROR', `导出写入失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }

  // —— v2.5 增量（PLAN §3.2）：account 权限门控（permissions.account !== true → 空实现恒 null）——
  const account = deps.accountAccess
    ? deps.account
    : {
        getToken: (): string | null => null,
        isLoggedIn: (): boolean => false,
      }

  // —— v2.5 增量（PLAN §3.4）：entitlement 占位（协议契约，本体零逻辑——红线 4）——
  const entitlement = {
    status: (): EntitlementStatus => ({ tier: 'free', expiresAt: null, quota: null }),
  }

  const host: PluginHost = {
    apiVersion: API_VERSION,
    log: (level, msg) => deps.log(level, msg),
    storage,
    events,
    workspace: deps.workspace,
    dialog: deps.dialog,
    notify: deps.notify,
    account,
    files,
    entitlement,
  }

  return {
    host,
    dispose(): void {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          // 退订兜底
        }
      }
      unsubs.clear()
      cache.clear()
      sizes.clear()
      totalBytes = 0
    },
  }
}
