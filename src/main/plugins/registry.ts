/**
 * 插件注册表（v2.5，P0）：发现 + 校验 + broken 标记（PLUGIN.md §2.2 / PLAN §三.1 / §六）。
 * 装配期同步扫描 userData/plugins 各已装包目录下的 pkg/manifest.json + userData/plugins/config.json 启停覆盖 →
 * 登记（同步微秒级，不加载任何插件代码；惰性加载归 loader.ts）。
 * 全局唯一性（id / ipcPrefix / pages[].path）在此登记期校验（validateManifest 无宿主上下文，见 types.ts 注释）。
 *
 * 纯 TS：不 import electron，可在 node 环境直接测试（root 注入）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { validateManifest } from '../../plugins/types'
import type { PluginManifest, PluginText } from '../../plugins/types'
import type { PluginInfo, PluginLoadErrorCode } from '../../shared/types'
import { writeJsonAtomic } from '../core/paths'

// —— 宿主存储布局（userData/plugins，PLUGIN.md §3.4）——
export const PLUGINS_DIR = 'plugins'
export const PKG_DIR = 'pkg'
export const STATE_DIR = 'state'
/** 安装时写下的整包校验记录（installer 落 `<id>/.qbox.sha256`）；也是「覆盖安装残骸」的三条判据之一（见 scan） */
export const SHA256_FILE = '.qbox.sha256'
export const CONFIG_FILE = 'config.json'
export const MANIFEST_FILE = 'manifest.json'
/** 主进程入口（相对 pkg/）；登记期校验存在性（缺入口 → broken，PLAN §1.4） */
export const MAIN_ENTRY = 'main/index.js'

/** 本体路由（渲染层 src/renderer/src/index.tsx 现有 Route 的静态段/前缀；登记期防插件页面路径冲突）。
 *  v2.5 移植对齐 master 现状（r2-测试P1-1）：补 /exports、/suppliers、/quotes 等 master 新增路由；
 *  规则④ `/plugin/` 前缀兜底不变（插件页面统一经 /plugin/* 通配分发） */
const BODY_ROUTES = [
  '/',
  '/product-sets',
  '/images',
  '/certs',
  '/search',
  '/settings',
  // v2.5：插件管理页本体路由（/settings/plugins，Sidebar 系统组入口）
  '/settings/plugins',
  '/profile',
  '/help',
  '/trash',
  '/exports',
  '/clients',
  '/invoices',
  '/suppliers',
  '/quotes',
  // 动态路由子树：/files/<type>/<productSet>/<subFolder> 与 /files/customer/<name>/<subFolder>、
  // /files/supplier/<name>/<subFolder>——以 /files/ 前缀整体归属本体（/files 本身也拒绝）
  '/files',
  '/files/customer',
  '/files/customer/:name',
  '/files/customer/:name/:subFolder',
  '/files/supplier',
  '/files/supplier/:name',
  '/files/supplier/:name/:subFolder',
  '/files/:type',
  '/files/:type/:productSet',
  '/files/:type/:productSet/:subFolder',
  // /product-sets/:name 动态路由子树（静态段 product-sets 之外的同名参数页）
  '/product-sets/:name',
  // /clients/:name
  '/clients/:name',
  // /suppliers/:name（供应商详情页）
  '/suppliers/:name',
  // /quotes/:no（报价单详情·编辑页）
  '/quotes/:no',
]

export type PluginState = PluginInfo['state']

/** 登记条目（registry 持有；loader 负责运行时统计与生命周期） */
export interface PluginEntry {
  id: string
  /** 校验通过的清单；broken（清单缺失/解析失败/校验失败等）为 null */
  manifest: PluginManifest | null
  /** 生效启停（config.json 覆盖 manifest.enabled 之后） */
  enabled: boolean
  state: PluginState
  /** broken 原因（管理页展示；熔断原因以「熔断：」开头，setEnabled(true) 可重置） */
  brokenReason?: string
  /** 最近一次激活/加载失败原因（管理页展示；激活成功清零）。
   *  v2.6 批 7（审查轮 2 缺口①）：取钥失败这类「装上但用不了」的原因当场落到这里，
   *  不再只有「连续失败 3 次熔断后」才可见——用户能立刻看到原因与出路。 */
  lastError?: string
  /** 最近一次加载失败的**结构化分类码**（v2.6 缺陷修复）：`lastError` 的机器可读那一半。
   *  只有加密插件取钥/解密失败才会带码（分类在主进程算，那里同时握着 code 与 HTTP 状态）；
   *  渲染层的插件页闸门据此画「原因 + 能点的出路按钮」，禁止靠 `lastError` 的中文文案猜。
   *  清零时机与 `lastError` 严格同步（成功激活 / 「重试」/ 重新启用三处一起清）。 */
  lastErrorCode?: PluginLoadErrorCode
  /** 安装时间（ISO 字符串） */
  installedAt: string
  /** 最近一次激活耗时（毫秒，管理页可观测，loader 写入） */
  activationMs?: number
  /** IPC 调用累计次数（loader 写入） */
  callCount: number
  /** 连续失败次数（熔断计数依据，loader 写入；成功或手动重置清零） */
  failCount: number
}

export interface RegistryOptions {
  /** userData/plugins 根 */
  root: string
  /** 宿主产品版本（minHostVersion 比对，装配时传 app.getVersion()） */
  hostVersion: string
  /** 本体路由（默认内置 BODY_ROUTES；测试可注入） */
  bodyRoutes?: string[]
  /** 日志回调（与 loader/host/installer 同风格；缺省静默） */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/** 熔断 broken 原因前缀（setEnabled(id, true) 视为「重试」：清 failCount 重新启用，PLAN §3.3） */
export const CIRCUIT_BROKEN_PREFIX = '熔断：'

/** PluginText 解析为展示字符串（v1 仅中文，map 形态取 default） */
export function resolvePluginText(t: PluginText): string {
  return typeof t === 'string' ? t : t.default
}

/** 语义化版本比对（数字段逐段比较，宿主版本是否 ≥ min） */
export function versionAtLeast(host: string, min: string): boolean {
  const parse = (s: string): number[] => String(s).split('.').map((x) => parseInt(x, 10) || 0)
  const h = parse(host)
  const m = parse(min)
  for (let i = 0; i < Math.max(h.length, m.length); i++) {
    const hv = h[i] ?? 0
    const mv = m[i] ?? 0
    if (hv > mv) return true
    if (hv < mv) return false
  }
  return true
}

/** 页面路径冲突判定：与本体路由或已登记插件路由的精确/子树重叠（含动态参数路由子树） */
function pathConflicts(p: string, routes: string[]): boolean {
  for (const r of routes) {
    if (p === r) return true
    if (r !== '/' && (p.startsWith(r + '/') || r.startsWith(p + '/'))) return true
  }
  return false
}

export class PluginRegistry {
  private entries = new Map<string, PluginEntry>()
  private root: string
  private hostVersion: string
  private bodyRoutes: string[]
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** config.json 启停覆盖（{ [id]: boolean }；setEnabled 写入，uninstall 清除） */
  private configOverrides: Record<string, boolean> = {}

  constructor(opts: RegistryOptions) {
    this.root = opts.root
    this.hostVersion = opts.hostVersion
    this.bodyRoutes = opts.bodyRoutes ?? BODY_ROUTES
    this.log = opts.log ?? (() => {})
  }

  // —— 装配期同步扫描（微秒级：仅读 manifest 清单 JSON，不加载插件代码）——

  /**
   * 全量扫描登记：userData/plugins 各已装包目录下的 pkg/manifest.json + config.json 启停覆盖。
   * 任一失败（清单缺失/解析失败/校验失败/全局冲突/缺入口）→ broken 标记，不阻塞启动。
   */
  scan(): void {
    this.entries.clear()
    this.configOverrides = this.readConfigSync()
    let dirs: string[] = []
    try {
      dirs = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((d) => !d.startsWith('.')) // 隐藏/临时目录（.tmp-install-*、.pkg-old-* 覆盖备份等）不是插件目录
        // 批 2.5 P1-3：白名单化——宿主自建 userData/plugins/keys/（encryption 密钥缓存）与非插件残留
        // 此前一律进 addBroken → 幽灵条目，且对它「卸载」= rm -rf 掉全部密钥缓存。
        // 判据（v2.6 审查轮 1 修）：含 `pkg/`、`state/`、`.qbox.sha256` **任一**才算插件候选——
        // 只认 pkg/ 会把「覆盖安装中途被打断/被安全软件隔离」的残骸（installer：先 rename 走 pkg、
        // 再 rename 回来，两步之间中断 ⇒ 只剩 state/ 与 .qbox.sha256）静默吞掉：该插件从管理页**彻底
        // 消失**，Uninstall 入口没了（installer.uninstall 要求 registry.get(id)），state/ 与启停覆盖
        // 永久残留，用户只看到"插件没了"。pkg 在而 manifest 缺/坏的真损坏安装照旧登记 broken。
        // keys/ 三者皆无 ⇒ 仍被挡（回归用例：plugins-host.test.ts「无 pkg 的非插件目录不进清单」）。
        .filter((d) => {
          const dirPath = path.join(this.root, d)
          const has = (rel: string, kind: 'dir' | 'file'): boolean => {
            try {
              const st = fs.statSync(path.join(dirPath, rel))
              return kind === 'dir' ? st.isDirectory() : st.isFile()
            } catch {
              return false
            }
          }
          return has(PKG_DIR, 'dir') || has(STATE_DIR, 'dir') || has(SHA256_FILE, 'file')
        })
    } catch {
      return // plugins 目录不存在（默认未安装任何插件）→ 空清单
    }
    dirs.sort()
    const usedPrefixes = new Set<string>()
    const usedPagePaths = new Set<string>()
    for (const dir of dirs) this.scanDir(dir, usedPrefixes, usedPagePaths)
  }

  private scanDir(dir: string, usedPrefixes: Set<string>, usedPagePaths: Set<string>): void {
    const manifestPath = path.join(this.root, dir, PKG_DIR, MANIFEST_FILE)
    let raw: string
    try {
      raw = fs.readFileSync(manifestPath, 'utf-8')
    } catch {
      this.addBroken(dir, false, `清单缺失：${dir}/pkg/manifest.json 不存在（安装包可能损坏，可卸载后重装）`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.addBroken(dir, false, `清单解析失败：manifest.json 非合法 JSON（${err instanceof Error ? err.message : String(err)}）`)
      return
    }
    const v = validateManifest(parsed)
    if (!v.ok) {
      this.addBroken(dir, false, `清单校验失败：${v.errors.join('；')}`)
      return
    }
    const manifest = parsed as PluginManifest
    if (manifest.id !== dir) {
      this.addBroken(dir, false, `id 与安装目录不一致：manifest.id=${manifest.id} ≠ 目录名 ${dir}`)
      return
    }
    // 缺主进程入口（PLAN §1.4 broken 三要素之一；激活必然经 main/index.js）
    // v2.5.7（F5b）：加密官方插件（manifest.encryption）允许 main/index.js.enc（loader 内存解密加载）
    const mainFile = path.join(this.root, dir, PKG_DIR, MAIN_ENTRY)
    if (!fs.existsSync(mainFile)) {
      const encAllowed = !!manifest.encryption && fs.existsSync(mainFile + '.enc')
      if (!encAllowed) {
        this.addBroken(dir, false, `缺主进程入口：pkg/main/index.js 不存在`)
        return
      }
    }
    // minHostVersion：宿主产品版本须 ≥ 声明值（validateManifest 只校验格式，比对在登记期）
    if (manifest.minHostVersion && !versionAtLeast(this.hostVersion, manifest.minHostVersion)) {
      this.addBroken(dir, false, `minHostVersion 不满足：需要 ≥${manifest.minHostVersion}，宿主为 ${this.hostVersion}`)
      return
    }
    // —— 全局唯一性（validateManifest 无宿主上下文，登记期校验）——
    if (this.entries.has(manifest.id)) {
      this.addBroken(dir, false, `id 冲突：${manifest.id} 已被占用`)
      return
    }
    if (usedPrefixes.has(manifest.ipcPrefix)) {
      this.addBroken(dir, false, `ipcPrefix 冲突：${manifest.ipcPrefix} 已被其他插件占用`)
      return
    }
    const pagePaths = (manifest.pages ?? []).map((p) => p.path)
    for (const p of pagePaths) {
      if (pathConflicts(p, this.bodyRoutes) || pathConflicts(p, [...usedPagePaths])) {
        this.addBroken(dir, false, `页面路径冲突：${p} 与本体路由或已注册插件路由冲突`)
        return
      }
    }
    usedPrefixes.add(manifest.ipcPrefix)
    for (const p of pagePaths) usedPagePaths.add(p)

    const enabled = this.hasConfigOverride(manifest.id) ? this.configOverrides[manifest.id] : manifest.enabled
    let installedAt = new Date().toISOString()
    try {
      installedAt = fs.statSync(manifestPath).mtime.toISOString()
    } catch {
      // mtime 不可得（极端）→ 用当前时间兜底
    }
    this.entries.set(manifest.id, {
      id: manifest.id,
      manifest,
      enabled,
      state: enabled ? 'enabled' : 'disabled',
      installedAt,
      callCount: 0,
      failCount: 0,
    })
  }

  private addBroken(id: string, enabled: boolean, reason: string): void {
    this.entries.set(id, {
      id,
      manifest: null,
      enabled,
      state: 'broken',
      brokenReason: reason,
      installedAt: new Date().toISOString(),
      callCount: 0,
      failCount: 0,
    })
  }

  // —— 查询 ——

  list(): PluginInfo[] {
    return [...this.entries.values()].map(toInfo)
  }

  /** 单插件 PluginInfo（install 后取返回值的入口） */
  info(id: string): PluginInfo | undefined {
    const e = this.entries.get(id)
    return e ? toInfo(e) : undefined
  }

  get(id: string): PluginEntry | undefined {
    return this.entries.get(id)
  }

  /** 全部登记条目（loader 遍历 activation 声明用） */
  all(): PluginEntry[] {
    return [...this.entries.values()]
  }

  /**
   * 是否存在**显式启停覆盖**（config.json 里为该 id 写过条目）。
   * 「无配置」（回退 manifest.enabled）与「显式 false」（用户关过）是两个态——官方预装
   * （v2.6 批 3，preinstall.ts）据此决定「新装条目置 enabled」还是「既有配置一律不动」。
   */
  hasConfigOverride(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.configOverrides, id)
  }

  // —— 启停（管理页操作；config.json 持久化）——

  /**
   * 设置启停：写 config.json 覆盖 + 更新登记状态。
   * 非法转移抛错：broken 插件不可操作（熔断原因除外——「重试」= setEnabled(id, true) 清 failCount 重新启用，PLAN §3.3）。
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`插件未安装：${id}`)
    if (entry.state === 'broken') {
      const circuit = entry.brokenReason?.startsWith(CIRCUIT_BROKEN_PREFIX)
      if (!enabled) throw new Error(`插件处于 broken 状态，无法禁用（原因：${entry.brokenReason ?? '未知'}）`)
      if (!circuit) throw new Error(`插件校验失败无法启用（原因：${entry.brokenReason ?? '未知'}；apiCompat 不兼容时需升级宿主或插件）`)
      // 熔断重置：清 failCount 重新启用（「重试」语义：上一次失败原因同点清掉，防管理页展示陈旧原因）
      entry.brokenReason = undefined
      entry.failCount = 0
      entry.lastError = undefined
      entry.lastErrorCode = undefined // 原因码与文案同点清（否则插件页会继续按陈旧分类码画闸门）
      entry.state = 'enabled'
      entry.enabled = true
      this.configOverrides[id] = true
      await this.persistConfig()
      return
    }
    if (entry.enabled === enabled) return // 幂等
    entry.enabled = enabled
    entry.state = enabled ? 'enabled' : 'disabled'
    if (enabled) {
      entry.failCount = 0 // 重新启用清零连续失败（重试语义）
      entry.lastError = undefined // 同上：上一次失败原因不当陈旧展示
      entry.lastErrorCode = undefined // 原因码与原因同生同灭（闸门不留陈旧态）
    }
    this.configOverrides[id] = enabled
    await this.persistConfig()
  }

  /** loader 熔断入口：握手/调用连续失败 → 自动 broken（state 变化广播由 ipc 层 onChanged 处理） */
  markBroken(id: string, reason: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.state = 'broken'
    entry.brokenReason = reason
  }

  /** 卸载时清除启停覆盖并落盘 */
  async forgetConfig(id: string): Promise<void> {
    if (this.hasConfigOverride(id)) {
      delete this.configOverrides[id]
      await this.persistConfig()
    }
  }

  // —— 运行时统计（loader 写入，管理页可观测）——

  recordCall(id: string): void {
    const e = this.entries.get(id)
    if (e) e.callCount++
  }

  recordFail(id: string): void {
    const e = this.entries.get(id)
    if (e) e.failCount++
  }

  recordActivationMs(id: string, ms: number): void {
    const e = this.entries.get(id)
    if (e) e.activationMs = ms
  }

  resetFailCount(id: string): void {
    const e = this.entries.get(id)
    if (e) e.failCount = 0
  }

  /** 记录最近一次激活/加载失败原因（loader 在激活失败时写入；管理页展示 + 由 loader 触发广播）。
   *  `code` = 结构化分类码，**只有取钥/解密失败这一类才传**（其余加载失败给不出「出路」，不该带码）；
   *  不传即显式清空上一次的码——三态字段必须与 `lastError` 同步，否则会出现「旧码 + 新文案」的错配引导。 */
  recordLoadError(id: string, message: string, code?: PluginLoadErrorCode): void {
    const e = this.entries.get(id)
    if (!e) return
    e.lastError = message
    e.lastErrorCode = code
  }

  /** 清空最近一次激活失败原因（激活成功时与 failCount 同点清零；原因码同点清） */
  clearLoadError(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.lastError = undefined
    e.lastErrorCode = undefined
  }

  // —— config.json 读写（启停覆盖，插件代码/状态/启停三处分离，PLUGIN.md §3.4）——

  private configPath(): string {
    return path.join(this.root, CONFIG_FILE)
  }

  private readConfigSync(): Record<string, boolean> {
    try {
      const raw = fs.readFileSync(this.configPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v
        return out
      }
    } catch {
      // 缺失/损坏 → 空覆盖（不阻塞启动）
    }
    return {}
  }

  private async persistConfig(): Promise<void> {
    try {
      await writeJsonAtomic(this.configPath(), this.configOverrides)
    } catch (err) {
      // 配置落盘失败仅记录（不抛——启停覆盖丢失可接受，下次重启回退 manifest.enabled）
      this.log('warn', `[plugins] config.json 写入失败: ${String(err)}`)
    }
  }
}

/** 登记条目 → 渲染层可序列化 PluginInfo（name/description 按 PluginText 解析；broken 用目录名兜底展示） */
function toInfo(e: PluginEntry): PluginInfo {
  const m = e.manifest
  return {
    id: e.id,
    name: m ? resolvePluginText(m.name) : e.id,
    version: m?.version ?? '',
    apiVersion: m?.apiVersion ?? 0,
    kind: m ? [...m.kind] : [],
    enabled: e.enabled,
    state: e.state,
    ...(e.brokenReason !== undefined ? { brokenReason: e.brokenReason } : {}),
    // v2.6 批 7：最近一次激活失败原因（取钥失败等「装上但用不了」的原因当场可见）
    ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
    // v2.6 缺陷修复：同一失败的结构化分类码（渲染层插件页闸门用它分流，不猜上面那句文案）
    ...(e.lastErrorCode !== undefined ? { lastErrorCode: e.lastErrorCode } : {}),
    ...(m?.description !== undefined ? { description: resolvePluginText(m.description) } : {}),
    ...(m?.author !== undefined ? { author: m.author } : {}),
    ...(m?.icon !== undefined ? { icon: m.icon } : {}),
    ...(m?.permissions !== undefined ? { permissions: m.permissions } : {}),
    // v2.5 增量（PLAN §3.1）：syncScope 透传（缺省不输出，渲染层按 'local' 处理）
    ...(m?.syncScope !== undefined ? { syncScope: m.syncScope } : {}),
    // v2.5：pages / commands 必须随清单下发——渲染层 Sidebar 插件分组与动态路由/右键命令注入
    // 都派生自这两组字段（deriveSidebarGroups / deriveRoutes / deriveFileCommands），缺失则注入点全部失效
    ...(m?.pages !== undefined
      ? {
          pages: m.pages.map((p) => ({
            path: p.path,
            label: resolvePluginText(p.label),
            icon: p.icon,
            group: p.group,
            component: p.component,
          })),
        }
      : {}),
    ...(m?.commands !== undefined
      ? {
          commands: m.commands.map((c) => ({
            id: c.id,
            label: resolvePluginText(c.label),
            scope: c.scope,
            ...(c.when !== undefined ? { when: c.when } : {}),
            ...(c.openPage !== undefined ? { openPage: c.openPage } : {}),
          })),
        }
      : {}),
    ...(e.activationMs !== undefined ? { activationMs: e.activationMs } : {}),
    callCount: e.callCount,
    failCount: e.failCount,
    installedAt: e.installedAt,
  }
}
