/**
 * 插件加载器（v2.5，P0）：惰性加载 + 握手 + 熔断（PLUGIN.md §2.3 / PLAN §三.3）。
 * 首次触发（IPC 首达 / onView / onCommand / activation 事件）→ 动态 import
 * userData/plugins/<id>/pkg/main/index.js → activate(host) → 校验 PluginRegistration → 运行。
 * 停用：注销能力引用 → registration.dispose() → hostDispose（解订阅/释缓存）→ 释放实例引用
 * （模块代码常驻为已知代价，重启完全释放——PLUGIN.md §4.1 诚实口径）。
 * 熔断：握手/调用连续失败 3 次 → 自动 broken（markBroken）；「重试」= setEnabled(id, true)（registry 清 failCount）。
 * 业务 error（handler 正常返回错误值）不计数熔断；抛错/拒绝才计入。
 * 纯 TS：不 import electron（host 由装配层经 createHost 注入），可在 node 环境直接测试。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginHost, PluginManifest, PluginRegistration } from '../../plugins/types'
import type { PluginHostInstance } from './host'
import { PKG_DIR, MAIN_ENTRY, CIRCUIT_BROKEN_PREFIX, type PluginRegistry } from './registry'

/** 熔断阈值：握手/调用连续失败 3 次 → 自动 broken（PLUGIN.md §2.3.2） */
export const BREAK_THRESHOLD = 3

/** 业务错误码白名单（host.files 六码，PLAN §3.3）：仅这些 code 豁免熔断；
 *  原生 Node 错误（ENOENT/ECONNREFUSED 等）带 code 但非业务码 → 计入熔断（P1-A1）。 */
export const BUSINESS_ERROR_CODES = new Set([
  'NOT_FOUND',
  'OUT_OF_WORKSPACE',
  'NO_WORKSPACE',
  'TOO_LARGE',
  'INVALID_NAME',
  'IO_ERROR',
])

/** 激活期间被停用（setEnabled(false)/uninstall 竞态）的内部信号——不计熔断（非插件失败，P1-A2） */
class ActivationCancelledError extends Error {
  constructor() {
    super('插件已被停用，激活中止')
  }
}

export interface LoaderOptions {
  registry: PluginRegistry
  /** userData/plugins 根（加载 userData/plugins/<id>/pkg/main/index.js） */
  root: string
  /** 每插件宿主工厂（装配层注入；host 激活时读入 state 缓存） */
  createHost: (id: string, manifest: PluginManifest) => Promise<PluginHostInstance>
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** 模块加载器（默认 node 动态 import；测试可注入，如 createRequire） */
  importer?: (url: string) => Promise<unknown>
}

interface Runtime {
  host: PluginHost
  hostDispose: () => void
  registration?: PluginRegistration
  active: boolean
  /** 激活中 Promise（并发触发合并为一次加载） */
  activating: Promise<void> | null
  /** 激活期间被 deactivate 打上的取消标记（doLoad 二次检查据此丢弃刚创建的宿主，P1-A2） */
  cancelled?: boolean
}

export class PluginLoader {
  private registry: PluginRegistry
  private root: string
  private createHost: LoaderOptions['createHost']
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void
  private importer: (url: string) => Promise<unknown>
  private runtimes = new Map<string, Runtime>()
  /** 状态变化（熔断自动 broken 等）→ ipc 层广播 plugins:changed */
  onChanged?: () => void

  constructor(opts: LoaderOptions) {
    this.registry = opts.registry
    this.root = opts.root
    this.createHost = opts.createHost
    this.log = opts.log ?? (() => {})
    this.importer = opts.importer ?? ((url: string) => import(url) as Promise<unknown>)
  }

  // —— 惰性激活入口（IPC 首达 / onView / onCommand 统一经此；activation 事件经 onHostEvent / onStartupFinished）——

  /**
   * 确保插件已激活：首次触发才动态 import + 握手（PLUGIN.md §2.3.1）。
   * 加载/握手失败 → 抛错给调用方，本次不加载；连续失败达阈值 → 熔断 broken（下次触发不再尝试）。
   */
  async ensureActive(id: string): Promise<void> {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`插件未安装：${id}`)
    if (entry.state === 'broken') throw new Error(`插件已断开：${entry.brokenReason ?? '未知原因'}`)
    if (!entry.enabled) throw new Error(`插件未启用：${id}`)
    const existing = this.runtimes.get(id)
    if (existing?.active) return
    if (existing?.activating) {
      await existing.activating
      return
    }
    const rt: Runtime = { host: undefined as unknown as PluginHost, hostDispose: () => {}, active: false, activating: null, cancelled: false }
    this.runtimes.set(id, rt)
    rt.activating = this.doLoad(id, rt)
    try {
      await rt.activating
    } finally {
      rt.activating = null
    }
  }

  private async doLoad(id: string, rt: Runtime): Promise<void> {
    const entry = this.registry.get(id)
    if (!entry?.manifest) throw new Error(`插件登记缺失（${id}）`)
    const t0 = Date.now()
    let created: PluginHostInstance | null = null
    try {
      const url = pathToFileURL(path.join(this.root, id, PKG_DIR, MAIN_ENTRY)).href
      const mod = (await this.importer(url)) as Record<string, unknown> | undefined
      // CJS 包（hello 构建产物）经 import() 的 default 即 module.exports；ESM 为命名导出 activate——两者都取
      const activate = mod?.activate ?? (mod?.default as Record<string, unknown> | undefined)?.activate
      if (typeof activate !== 'function') {
        throw new Error('插件入口缺少 activate 导出（pkg/main/index.js 须 export activate(host)）')
      }
      created = await this.createHost(id, entry.manifest)
      // 激活期间被停用（setEnabled(false) 竞态）→ 丢弃刚创建的宿主并终止
      if (this.runtimes.get(id) !== rt || rt.cancelled) {
        created.dispose()
        created = null
        throw new ActivationCancelledError()
      }
      const registration = await (activate as (host: PluginHost) => Promise<unknown>)(created.host)
      this.assertRegistration(registration)
      // v2.5 修复（P1-A2）：activate 挂起期间被 deactivate → 二次检查取消标记/运行时仍登记，
      // 立即 dispose 刚创建的宿主 + registration.dispose，杜绝孤儿实例（订阅/定时器泄漏）
      if (rt.cancelled || this.runtimes.get(id) !== rt) {
        try {
          registration.dispose?.()
        } catch (err) {
          this.log('error', `插件 dispose 异常（${id}）: ${String(err)}`)
        }
        created.dispose()
        created = null
        throw new ActivationCancelledError()
      }
      rt.host = created.host
      rt.hostDispose = created.dispose
      rt.registration = registration
      rt.active = true
      created = null // 归属已移交 rt
      this.registry.recordActivationMs(id, Date.now() - t0)
      this.registry.resetFailCount(id) // 握手成功清零连续失败
    } catch (err) {
      created?.dispose() // 部分初始化（createHost 成功但 activate 抛错）也要清理订阅/缓存
      if (!(err instanceof ActivationCancelledError)) this.fail(id, err)
      throw err
    }
  }

  /**
   * 熔断计数：连续失败达阈值 → 自动 broken（失败原因保留，管理页可观测 + 手动重置）。返回是否已熔断。
   * v2.5 修复（P1-A1）：仅业务错误码白名单（host.files 六码，BUSINESS_ERROR_CODES）豁免熔断；
   * 原生 Node 错误（ENOENT/ECONNREFUSED 等）带 code 但非业务码 → 计入熔断（此前 `'code' in err` 误豁免）。
   */
  private fail(id: string, err: unknown): boolean {
    const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
    if (typeof code === 'string' && BUSINESS_ERROR_CODES.has(code)) return false
    this.registry.recordFail(id)
    const entry = this.registry.get(id)
    if (entry && entry.failCount >= BREAK_THRESHOLD) {
      this.registry.markBroken(id, `${CIRCUIT_BROKEN_PREFIX}连续失败 ${entry.failCount} 次（${err instanceof Error ? err.message : String(err)}）`)
      this.runtimes.delete(id)
      this.onChanged?.()
      this.log('error', `插件已熔断（连续失败 ${entry.failCount} 次）: ${id}`)
      return true
    }
    return false
  }

  /** PluginRegistration 结构校验（activate 返回须为能力注册表，PLUGIN.md §2.4.2） */
  private assertRegistration(reg: unknown): asserts reg is PluginRegistration {
    if (typeof reg !== 'object' || reg === null) throw new Error('activate 须返回 PluginRegistration 对象')
    const r = reg as Record<string, unknown>
    if (r.ipc !== undefined) {
      if (typeof r.ipc !== 'object' || r.ipc === null) throw new Error('registration.ipc 须为 { action: handler } 映射')
      for (const [k, v] of Object.entries(r.ipc)) {
        if (typeof v !== 'function') throw new Error(`registration.ipc["${k}"] 须为函数`)
      }
    }
    if (r.commands !== undefined) {
      if (typeof r.commands !== 'object' || r.commands === null) throw new Error('registration.commands 须为 { id: handler } 映射')
      for (const [k, v] of Object.entries(r.commands)) {
        if (typeof v !== 'function') throw new Error(`registration.commands["${k}"] 须为函数`)
      }
    }
    if (r.pages !== undefined && !Array.isArray(r.pages)) throw new Error('registration.pages 须为数组')
    if (r.dispose !== undefined && typeof r.dispose !== 'function') throw new Error('registration.dispose 须为函数')
  }

  // —— 插件 IPC 调用（qihebox:plugins:call 路由入口）——

  /**
   * 调用插件 IPC 动作：确保激活 → registration.ipc[action] 执行。
   * handler 抛错/拒绝 → 本次调用报错并计入熔断（业务 error 正常返回不计数）。
   */
  async call(id: string, action: string, payload: unknown): Promise<unknown> {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`插件未安装：${id}`)
    if (entry.state === 'broken') throw new Error(`插件已断开：${entry.brokenReason ?? '未知原因'}`)
    if (!entry.enabled) throw new Error(`插件未启用：${id}`)
    await this.ensureActive(id)
    const rt = this.runtimes.get(id)
    const handler = rt?.registration?.ipc?.[action]
    // v2.5（PLAN §5.3）：commands 与 ipc 共用 call 入口——无 ipc handler 时回退到
    // registration.commands[action]（右键命令触发：payload = { filePaths }，ctx 注入 host）
    if (!handler && rt?.registration?.commands?.[action]) {
      const cmd = rt.registration.commands[action]
      this.registry.recordCall(id)
      try {
        const filePaths = ((payload as { filePaths?: string[] } | null)?.filePaths ?? []).filter(
          (p): p is string => typeof p === 'string',
        )
        const result = await cmd({ filePaths, host: rt.host })
        this.registry.resetFailCount(id) // 调用成功清零连续失败
        return result
      } catch (err) {
        // 插件命令异常仅影响本次调用并计入熔断（PLUGIN.md §2.3.2）
        this.fail(id, err)
        throw err
      }
    }
    if (!handler) throw new Error(`插件未提供 IPC 动作：${action}`)
    this.registry.recordCall(id)
    try {
      const result = await handler(payload)
      this.registry.resetFailCount(id) // 调用成功清零连续失败
      return result
    } catch (err) {
      // 插件 handler 异常仅影响本次调用并计入熔断（PLUGIN.md §2.3.2）；熔断时 fail 已回收实例
      this.fail(id, err)
      throw err
    }
  }

  // —— 停用 / 清理 ——

  /** 停用：registration.dispose() → hostDispose（解订阅/释缓存）→ 释放实例引用（禁用/卸载/熔断时调用） */
  deactivate(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    this.runtimes.delete(id)
    // 已激活 → 正常 dispose（registration.dispose + hostDispose）
    if (rt.active) {
      rt.active = false
      try {
        rt.registration?.dispose?.()
      } catch (err) {
        this.log('error', `插件 dispose 异常（${id}）: ${String(err)}`)
      }
      try {
        rt.hostDispose()
      } catch (err) {
        this.log('error', `插件宿主清理异常（${id}）: ${String(err)}`)
      }
      rt.registration = undefined
      return
    }
    // v2.5 修复（P1-A2）：激活进行中（createHost/activate 尚未完成）→ 打取消标记，
    // 由 doLoad 在 activate 返回后二次检查并清理刚创建的宿主（防孤儿实例）
    if (rt.activating) {
      rt.cancelled = true
    }
  }

  /** 退出清理：全部已激活插件 dispose()（尽力，超时 2s 不强等，PLAN §六.4） */
  async disposeAll(timeoutMs = 2000): Promise<void> {
    const ids = [...this.runtimes.keys()]
    await Promise.all(
      ids.map((id) =>
        Promise.race([
          Promise.resolve().then(() => this.deactivate(id)),
          new Promise<void>((r) => setTimeout(r, timeoutMs)),
        ]),
      ),
    )
  }

  // —— activation 事件触发的惰性激活（PLUGIN.md §2.3.1）——

  /**
   * 宿主事件到达：manifest.activation 声明 onEvent:<ipcPrefix>:<channel> 的启用插件触发激活
   * （声明通道带插件前缀命名空间，规则⑦；宿主事件为裸通道，如 workspaceChanged）。
   * 失败仅记录，不阻断事件投递。
   */
  onHostEvent(channel: string): void {
    for (const entry of this.registry.all()) {
      if (entry.state !== 'enabled' || !entry.manifest) continue
      const activation = entry.manifest.activation as readonly string[] | undefined
      const token = `onEvent:${entry.manifest.ipcPrefix}:${channel}`
      if (activation?.includes(token)) {
        void this.ensureActive(entry.id).catch((err) =>
          this.log('error', `onEvent:${channel} 激活失败（${entry.id}）: ${String(err)}`),
        )
      }
    }
  }

  /** 启动完成后延迟激活（装配层 setTimeout 调用；不进 app ready → 窗口可交互关键路径） */
  onStartupFinished(): void {
    for (const entry of this.registry.all()) {
      if (entry.state !== 'enabled' || !entry.manifest) continue
      if (entry.manifest.activation?.includes('onStartupFinished')) {
        void this.ensureActive(entry.id).catch((err) =>
          this.log('error', `onStartupFinished 激活失败（${entry.id}）: ${String(err)}`),
        )
      }
    }
  }
}
