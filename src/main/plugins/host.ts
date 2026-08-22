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
import type {
  CustomerProfile,
  EntitlementStatus,
  PluginBusinessError,
  PluginHost,
  QuoteProfile,
  SupplierProfile,
} from '../../plugins/types'
import { EXPORTS_DIR, assertSafeFileName, isPathInsideWorkspaceReal, writeJsonAtomic } from '../core/paths'

/** 宿主事件白名单（插件 host.events.on 仅可订阅这些通道；装配层在此发事件）。
 *  v2.5.1 A1（PLAN-v2.6-v2.7 §3.1）：+ customerCreated / customerUpdated / fileArchived */
export const HOST_EVENT_WHITELIST = [
  'workspaceChanged',
  'importComplete',
  'certExpiring',
  'updateAvailable',
  'customerCreated',
  'customerUpdated',
  'fileArchived',
  // v2.5.4（弹一 C-3，云桥 M3）：供应商创建/更新/重命名事件（payload：{ name, oldName? }，照客户域）
  'supplierCreated',
  'supplierUpdated',
  // v2.5.1（登录增强 D24 落地）：登录/登出即时广播——闭源插件使用锁（未登录零装配）据此
  // 即时恢复/停止服务，不必等 5min 探针（探针保留为兜底）
  'accountChanged',
] as const
export type HostEventChannel = (typeof HOST_EVENT_WHITELIST)[number]

/** 带 code 的业务错误构造（loader 熔断对带 code 的错误不计数，PLAN §3.3 r2-性能P1-2） */
export function fileError(code: string, msg: string): PluginBusinessError {
  const e = new Error(msg) as PluginBusinessError
  e.code = code
  return e
}

/**
 * core 裸错误 → 契约错误码（v2.5.1 A1/A2，装配层适配器包装用）。
 * core 层（clients/shareView）抛中文裸错误，插件契约要求错误带 code（不计熔断）——
 * 按消息模式映射；已带 code 的错误原样保留；无法识别 → IO_ERROR。
 */
export function mapCoreError(err: unknown): PluginBusinessError {
  if (err instanceof Error) {
    const withCode = err as Error & { code?: string }
    if (typeof withCode.code === 'string' && withCode.code.length > 0) return withCode as PluginBusinessError
    const msg = err.message
    if (msg.includes('客户不存在') || msg.includes('供应商不存在') || msg.includes('文件不存在') || (msg.includes('产品集「') && msg.includes('不存在'))) {
      return fileError('NOT_FOUND', msg)
    }
    if (msg.includes('未打开工作区')) return fileError('NO_WORKSPACE', msg)
    if (msg.includes('白名单')) return fileError('FIELD_DENIED', msg)
    if (msg.includes('隐藏目录')) return fileError('HIDDEN', msg)
    if (msg.includes('超出工作区') || msg.includes('路径超出')) return fileError('OUT_OF_WORKSPACE', msg)
    if (msg.includes('不能为空') || msg.includes('非法') || msg.includes('超限')) return fileError('INVALID_NAME', msg)
    return fileError('IO_ERROR', msg)
  }
  return fileError('IO_ERROR', String(err))
}

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
  /** customers 能力域适配器（v2.5.1 A1，PLAN-v2.6-v2.7 §3.1）：装配层注入 ClientsService 委托。
   *  业务错误抛带 code 的 Error（NOT_FOUND/STALE/FIELD_DENIED 等），薄壳原样透传 */
  customers: {
    list(since?: string): Promise<CustomerProfile[]>
    get(name: string): Promise<CustomerProfile | null>
    writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
    syncProfile(req: {
      name: string
      fields?: Record<string, unknown>
      erp_ext?: Record<string, unknown>
      updated_at: string
    }): Promise<{ applied: boolean }>
    relation: {
      link(customerName: string, productSetName: string): Promise<void>
      unlink(customerName: string, productSetName: string): Promise<void>
    }
  }
  /** manifest.permissions.customers === true 时才接通；否则 host.customer.* 全部抛 PERMISSION_DENIED（读方法亦抛） */
  customersAccess: boolean
  /** suppliers 能力域适配器（v2.5.4 弹一 C-1，云桥 M3）：装配层注入 SuppliersService 委托（照 customers）。 */
  suppliers: {
    list(since?: string): Promise<SupplierProfile[]>
    get(name: string): Promise<SupplierProfile | null>
    writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
    syncProfile(req: {
      name: string
      fields?: Record<string, unknown>
      erp_ext?: Record<string, unknown>
      updated_at: string
    }): Promise<{ applied: boolean }>
  }
  /** manifest.permissions.suppliers === true 时才接通；否则 host.supplier.* 全部抛 PERMISSION_DENIED（读方法亦抛） */
  suppliersAccess: boolean
  /** quote 只读域适配器（v2.5.4 弹一 C-4，云桥 M3）：装配层注入 QuotesService 委托（只读投影）。
   *  门控并入 customersAccess（C-2 拍板：报价读与客户同一位，不碎片化权限位） */
  quotes: {
    list(since?: string): Promise<QuoteProfile[]>
    get(quotationNo: string): Promise<QuoteProfile | null>
  }
  /** share 能力域适配器（v2.5.1 A2，PLAN-v2.6-v2.7 §3.2）：装配层注入 ShareViewService 委托 */
  share: {
    listProductSets(): Promise<unknown[]>
    listCustomers(): Promise<unknown[]>
    listTree(relPath?: string): Promise<unknown[]>
    getMetadata(relPath: string): Promise<{ tags: string[]; notes: string }>
    statFile(relPath: string): Promise<{ size: number; mtime: string }>
    readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array>
    writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void>
    ensureProductSet(name: string): Promise<'created' | 'exists'>
    ensureCustomer(name: string): Promise<'created' | 'exists'>
    mergePulledMetadata(entries: { path: string; tags: string[]; notes: string }[]): Promise<{ conflicts: string[] }>
  }
  /** manifest.permissions.share === true 时才接通；否则 host.share.* 全部抛 PERMISSION_DENIED */
  shareAccess: boolean
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
  // fileError 为模块级导出（带 code 业务错误，不计熔断计数）

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

  // —— v2.5.1（A1/A2，PLAN-v2.6-v2.7 §3.1/§3.2）：customers / share 能力域薄壳 ——
  // 门控：manifest.permissions.customers/share !== true → 全部方法抛 PERMISSION_DENIED（读方法亦抛，
  // 与 account 恒 null 静默不同——customers 含写，显式拒绝更诚实，PLAN §3.1 附录明示差异）

  /** 门控拒绝错误（带 code → 不计熔断） */
  function permissionDenied(domain: string): PluginBusinessError {
    return fileError('PERMISSION_DENIED', `插件未声明 permissions.${domain} 权限`)
  }

  /** 实体域共享形状（customer/supplier 共用的四个方法；relation 由 customer 单独接线） */
  interface EntityDomainShape<P> {
    list(since?: string): Promise<P[]>
    get(name: string): Promise<P | null>
    writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
    syncProfile(req: {
      name: string
      fields?: Record<string, unknown>
      erp_ext?: Record<string, unknown>
      updated_at: string
    }): Promise<{ applied: boolean }>
  }

  /**
   * v2.5.4（弹一 C-5a，协议真合并）：实体域工厂——门控开启 → 透传装配层适配器；
   * 未声明权限 → 四个方法全部抛 PERMISSION_DENIED（含读方法，显式拒绝更诚实）。
   * 单一实现同时服务 customer/supplier，消除两份逐字段兜底（customer 域对外行为不变）。
   */
  function makeEntityDomain<P>(cfg: {
    enabled: boolean
    permission: string
    adapter: EntityDomainShape<P>
  }): EntityDomainShape<P> {
    if (cfg.enabled) return cfg.adapter
    return {
      list: async () => {
        throw permissionDenied(cfg.permission)
      },
      get: async () => {
        throw permissionDenied(cfg.permission)
      },
      writeErpExt: async () => {
        throw permissionDenied(cfg.permission)
      },
      syncProfile: async () => {
        throw permissionDenied(cfg.permission)
      },
    }
  }

  // —— v2.5.4（弹一 C-5a，协议真合并）：customer/supplier 共享的实体域工厂 ——
  // list/get/writeErpExt/syncProfile + 权限门控拒绝共用一份实现；customer 域对外行为不变
  // （relation 由 customer 域单独接线）；各实体域在装配层（ipc.ts）注入各自的 core 适配器，
  // 本处只做「门控 + 透传」合一——消除 customer/supplier 两份逐字段重复的兜底。
  const customer = {
    ...makeEntityDomain({
      enabled: deps.customersAccess,
      permission: 'customers',
      adapter: deps.customers,
    }),
    relation: deps.customersAccess
      ? deps.customers.relation
      : {
          link: async (): Promise<void> => {
            throw permissionDenied('customers')
          },
          unlink: async (): Promise<void> => {
            throw permissionDenied('customers')
          },
        },
  }

  const supplier = makeEntityDomain({
    enabled: deps.suppliersAccess,
    permission: 'suppliers',
    adapter: deps.suppliers,
  })

  // —— v2.5.4（弹一 C-4，云桥 M3）：quote 只读域（门控并入 customersAccess——C-2 拍板同一位）——
  const quote = deps.customersAccess
    ? deps.quotes
    : {
        list: async (): Promise<QuoteProfile[]> => {
          throw permissionDenied('customers')
        },
        get: async (): Promise<QuoteProfile | null> => {
          throw permissionDenied('customers')
        },
      }

  const share = deps.shareAccess
    ? deps.share
    : {
        listProductSets: async (): Promise<unknown[]> => {
          throw permissionDenied('share')
        },
        listCustomers: async (): Promise<unknown[]> => {
          throw permissionDenied('share')
        },
        listTree: async (): Promise<unknown[]> => {
          throw permissionDenied('share')
        },
        getMetadata: async (): Promise<{ tags: string[]; notes: string }> => {
          throw permissionDenied('share')
        },
        statFile: async (): Promise<{ size: number; mtime: string }> => {
          throw permissionDenied('share')
        },
        readFileChunk: async (): Promise<Uint8Array> => {
          throw permissionDenied('share')
        },
        writePulledFile: async (): Promise<void> => {
          throw permissionDenied('share')
        },
        ensureProductSet: async (): Promise<'created' | 'exists'> => {
          throw permissionDenied('share')
        },
        ensureCustomer: async (): Promise<'created' | 'exists'> => {
          throw permissionDenied('share')
        },
        mergePulledMetadata: async (): Promise<{ conflicts: string[] }> => {
          throw permissionDenied('share')
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
    customer,
    supplier,
    quote,
    share,
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
