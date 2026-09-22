/**
 * 渲染层插件注册表（v2.5，P0）：插件宿主三段架构之渲染层（PLUGIN.md §3.3）。
 *
 * 职责：`plugins.list()` 拉取已安装清单 → 派生 Sidebar 插件分组 / 动态路由表 / 右键命令集；
 * 订阅 `plugins:changed` 事件即时刷新（启停即时生效，不重启）。
 * v2.6 批 2 增量：`plugins.catalog()` 官方索引目录 + `install()` 双形态 + **纯派生**三件
 * （目录行「可更新」标记 `deriveCatalogRows` / 重启提示 `buildRestartNotice` / 错误码引导 `catalogErrorGuidance`）
 * + `app.relaunch()` 应用内重启——判定全部落在纯函数里，管理页只负责画（PLUGIN.md §5.3）。
 *
 * 本文件为纯逻辑模块（无 JSX）：派生函数为纯函数（可单测、不触碰 window），
 * 与 preload 桥的接触集中在 getPluginsBridge() 一处。qihebox.d.ts 的 plugins 命名空间
 * 由 preload 子代理补充，此处以本地最小类型 + 断言过渡（preload 落地后可收敛为直接访问）。
 * 模块级信号在未调用 initPluginRegistry() 前为零开销；未安装/禁用插件不派生任何注入点。
 * 所有 IPC 返回均为 ApiResult 包装（主进程统一包裹，此处直读 success/error）。
 */
import { createSignal } from 'solid-js'
import type { ApiResult, PluginCatalogEntry, PluginInfo, PluginInstallSource } from '../../../shared/types'

/** 插件管理页路由（Sidebar 系统组可引用；路由注册在 routes.tsx） */
export const PLUGIN_MANAGER_PATH = '/settings/plugins'

/** Sidebar 插件分组（仅启用插件且声明 pages 的页面；固定组名「插件」，PLAN §5.5） */
export interface PluginSidebarGroup {
  title: string
  items: { icon: string; label: string; path: string }[]
}

/** 动态路由表条目（启用插件 pages 的 path → 协议 URL 动态 import 元信息） */
export interface PluginRouteDef {
  path: string
  pluginId: string
  component: string
  label: string
}

/** 右键命令注入条目（scope='file'；触发 = callPlugin(pluginId, commandId, { filePaths })） */
export interface PluginFileCommand {
  pluginId: string
  commandId: string
  label: string
  /** 可见性过滤：仅匹配的文件扩展名出现该命令（when.exts，防右键菜单污染） */
  exts?: string[]
  /** 「打开本插件页面」命令（manifest commands[].openPage；宿主改走交接+导航，不执行回调） */
  openPage?: string
}

/** 右键 openPage 命令的文件交接键（sessionStorage；插件页 take-and-clear 语义，PLUGIN.md §commands） */
export const PLUGIN_HANDOFF_KEY = 'qihebox:plugin-handoff'

/** 交接载荷形状（写入方=宿主注入槽，读取方=插件页面；pluginId 不符 → 忽略） */
export interface PluginHandoff {
  pluginId: string
  paths: string[]
  at: number
}

/**
 * 注入槽单项构造（纯函数，v2.5.9）：openPage 命令 → deps.open（写交接 + 导航）；
 * 否则 → deps.call（callPlugin 执行回调，原行为）。抽成纯函数以便单测分流本身。
 */
export function buildPluginCommandItem(
  cmd: PluginFileCommand,
  paths: string[],
  deps: {
    call: (pluginId: string, commandId: string, filePaths: string[]) => void
    open: (openPage: string, filePaths: string[]) => void
  },
): { label: string; icon: string; action: () => void } {
  return {
    label: cmd.label,
    icon: '🧩',
    action: () => {
      if (cmd.openPage) deps.open(cmd.openPage, paths)
      else deps.call(cmd.pluginId, cmd.commandId, paths)
    },
  }
}

/** preload plugins 命名空间的最小本地类型（纯透传，不 import 任何插件代码） */
interface PluginBridge {
  list(): Promise<ApiResult<PluginInfo[]>>
  call(pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>>
  setEnabled(pluginId: string, enabled: boolean): Promise<ApiResult<boolean>>
  install(source: PluginInstallSource): Promise<ApiResult<PluginInfo>>
  /** v2.6 批 2：官方索引目录（进入管理页时拉取一次） */
  catalog(): Promise<ApiResult<PluginCatalogEntry[]>>
  uninstall(pluginId: string): Promise<ApiResult<boolean>>
  on(channel: string, cb: (data: unknown) => void): () => void
}

/** preload app 命名空间的最小本地类型（v2.6 批 2：应用内重启） */
interface AppBridge {
  relaunch(): Promise<unknown>
}

/** preload settings 命名空间的最小本地类型（v2.5 增量，PLAN §3.5：开发者模式；返回 ApiResult 包装） */
interface SettingsBridge {
  getDevMode(): Promise<ApiResult<boolean>>
  setDevMode(enabled: boolean): Promise<ApiResult<boolean>>
}

/** 取 preload 桥（qihebox.d.ts 补全 plugins 命名空间后，此处断言可替换为直接访问） */
function getPluginsBridge(): PluginBridge {
  // 先整体断言 window 再取属性：qihebox.d.ts 仅 renderer tsconfig 可见，node tsconfig 下
  // tests 导入本文件时 Window 无 qihebox 声明，直接属性访问会报 TS2339 —— 双配置均须编译通过
  return (window as unknown as { qihebox: { plugins: PluginBridge } }).qihebox.plugins
}

/** 取 preload settings 桥（同上双配置说明；v2.5 增量） */
function getSettingsBridge(): SettingsBridge {
  return (window as unknown as { qihebox: { settings: SettingsBridge } }).qihebox.settings
}

/** 取 preload app 桥（v2.6 批 2：应用内重启；同上双配置说明） */
function getAppBridge(): AppBridge {
  return (window as unknown as { qihebox: { app: AppBridge } }).qihebox.app
}

// —— 模块级信号（未初始化前为空清单，派生函数返回空注入点）——

const [pluginList, setPluginList] = createSignal<PluginInfo[]>([])

/** plugins:changed 事件退订函数（与 init 配对，防泄漏） */
let unsubChanged: (() => void) | null = null
let initPromise: Promise<void> | null = null

/** 当前已安装插件清单（含禁用/broken；管理页与 Sidebar/路由/菜单注入的数据源） */
export function plugins(): PluginInfo[] {
  return pluginList()
}

/** 拉取最新清单（list() IPC；操作完成后由管理页显式调用，事件路径亦会触发） */
export async function refreshPluginRegistry(): Promise<void> {
  const r = await getPluginsBridge().list()
  if (r.success && r.data) setPluginList(r.data)
}

/**
 * 初始化渲染层插件注册表（幂等）：首次拉取清单 + 订阅 plugins:changed 事件。
 * 事件 payload = PluginInfo[]（主进程在安装/卸载/启停变化时广播），直接采纳；
 * 非数组载荷（异常兜底）时回退一次 list() 刷新。
 */
export function initPluginRegistry(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    await refreshPluginRegistry()
    unsubChanged = getPluginsBridge().on('plugins:changed', (data) => {
      if (Array.isArray(data)) {
        setPluginList(data as PluginInfo[])
      } else {
        void refreshPluginRegistry()
      }
    })
  })()
  return initPromise
}

/** 释放注册表订阅并清空清单（与 initPluginRegistry 配对；测试与页面销毁时调用） */
export function disposePluginRegistry(): void {
  unsubChanged?.()
  unsubChanged = null
  initPromise = null
  setPluginList([])
}

// —— 纯派生函数（可单测；输入 = list() 输出的 PluginInfo[]）——

/** 纯派生：启用插件 pages → Sidebar 插件分组（单组「插件」；无启用页面返回空数组） */
export function deriveSidebarGroups(list: PluginInfo[]): PluginSidebarGroup[] {
  const items: PluginSidebarGroup['items'] = []
  for (const p of list) {
    if (p.state !== 'enabled' || !Array.isArray(p.pages)) continue
    for (const page of p.pages) {
      items.push({ icon: page.icon, label: page.label, path: page.path })
    }
  }
  return items.length > 0 ? [{ title: '插件', items }] : []
}

/** 纯派生：启用插件 pages → 动态路由表（path 冲突已在登记期拦截，PLAN §3.2） */
export function deriveRoutes(list: PluginInfo[]): PluginRouteDef[] {
  const out: PluginRouteDef[] = []
  for (const p of list) {
    if (p.state !== 'enabled' || !Array.isArray(p.pages)) continue
    for (const page of p.pages) {
      out.push({ path: page.path, pluginId: p.id, component: page.component, label: page.label })
    }
  }
  return out
}

/** 纯派生：启用插件 scope='file' 命令 → 右键菜单注入槽（PLAN §5.3；global 由其他槽位消费） */
export function deriveFileCommands(list: PluginInfo[]): PluginFileCommand[] {
  const out: PluginFileCommand[] = []
  for (const p of list) {
    if (p.state !== 'enabled' || !Array.isArray(p.commands)) continue
    for (const c of p.commands) {
      if (c.scope !== 'file') continue
      out.push({
        pluginId: p.id,
        commandId: c.id,
        label: c.label,
        ...(Array.isArray(c.when?.exts) ? { exts: c.when.exts } : {}),
        ...(typeof c.openPage === 'string' && c.openPage.length > 0 ? { openPage: c.openPage } : {}),
      })
    }
  }
  return out
}

/**
 * 纯派生：启用插件 scope='global' 命令 → 表单上下文命令槽（v2.5.4 Task 4，发票识别。
 * 当前唯一消费者：新建发票弹窗 create 模式；触发 = callPlugin(pluginId, commandId, {})，
 * 走插件既有 IPC action（ApiResult 信封），manifest.commands 仅作按钮槽可见性/标签声明）。
 * 与 deriveFileCommands 同构；global 无 when.exts 过滤（表单上下文全域可见）。
 */
export function deriveGlobalCommands(list: PluginInfo[]): PluginFileCommand[] {
  const out: PluginFileCommand[] = []
  for (const p of list) {
    if (p.state !== 'enabled' || !Array.isArray(p.commands)) continue
    for (const c of p.commands) {
      if (c.scope !== 'global') continue
      out.push({ pluginId: p.id, commandId: c.id, label: c.label })
    }
  }
  return out
}

/** 响应式派生（Sidebar / routes.tsx / fileContextMenu 注入槽消费） */
export function pluginSidebarGroups(): PluginSidebarGroup[] {
  return deriveSidebarGroups(pluginList())
}
export function pluginRoutes(): PluginRouteDef[] {
  return deriveRoutes(pluginList())
}
export function pluginFileCommands(): PluginFileCommand[] {
  return deriveFileCommands(pluginList())
}
export function pluginGlobalCommands(): PluginFileCommand[] {
  return deriveGlobalCommands(pluginList())
}

/**
 * 渲染层插件协议 URL：`qihebox://plugin/<id>/<relpath>`（PLUGIN.md §2.1 / PLAN §4.3）。
 * 与主进程同规则做路径包含校验：拒绝绝对路径与 '..' 逃逸（返回 null，调用方按加载失败处理）；
 * 段级 encodeURIComponent 保证 URL 合法。页面模块动态 import 与插件资源（图标等）共用。
 */
export function pluginModuleUrl(id: string, relPath: string): string | null {
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof relPath !== 'string' || relPath.length === 0) return null
  const norm = relPath.replace(/\\/g, '/')
  if (norm.startsWith('/')) return null
  if (norm.split('/').some((s) => s === '..' || s.length === 0)) return null
  const segments = norm.split('/').map((s) => encodeURIComponent(s))
  return `qihebox://plugin/${encodeURIComponent(id)}/${segments.join('/')}`
}

// —— preload 桥薄封装（管理页 / 右键命令注入槽共用，纯透传）——

/** 调用插件 IPC：callPlugin('com.qihe.hello', 'ping', payload) → qihebox:plugin:hello:ping */
export function callPlugin(pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>> {
  return getPluginsBridge().call(pluginId, action, payload)
}

/** 启停（即时生效 + 持久化到 userData/plugins/config.json）；broken 插件「重试」亦走此入口 */
export function setPluginEnabled(pluginId: string, enabled: boolean): Promise<ApiResult<boolean>> {
  return getPluginsBridge().setEnabled(pluginId, enabled)
}

/** 侧载安装本地 .qbox（主进程做 JSON Schema + SHA-256 校验后解压到 pkg/）；
 *  v2.6 批 2 起同一入口兼官方索引形态 `{ downloadUrl, sha256 }`（登录态下载 + SHA-256 逐字节校验，不需 devMode） */
export function installPlugin(source: PluginInstallSource): Promise<ApiResult<PluginInfo>> {
  return getPluginsBridge().install(source)
}

// —— v2.6 批 2：官方索引目录（catalog）/ 更新判定 / 应用内重启 ——

/** 拉取官方索引目录（进入管理页时调用一次；**不后台轮询**）。失败原因见 `catalogErrorGuidance` */
export function fetchPluginCatalog(): Promise<ApiResult<PluginCatalogEntry[]>> {
  return getPluginsBridge().catalog()
}

/** 应用内重启（插件更新后「立即重启」）——main 侧 app.relaunch() + app.quit() */
export function relaunchApp(): Promise<unknown> {
  return getAppBridge().relaunch()
}

/** 目录行（目录条目 + 已装状态派生；管理页直接渲染） */
export interface PluginCatalogRow {
  entry: PluginCatalogEntry
  /** 已装版本（未安装 = 缺省） */
  installedVersion?: string
  /** 可更新：已安装、且可选版本与已装版本不同（不兼容条目恒 false——没有可下载版本） */
  updateAvailable: boolean
}

/**
 * 纯派生：目录条目 × 已装清单 → 管理页行。
 * 「已装」判据 = 清单里同 id 存在（禁用/broken 也算已装——更新检查不看启停态）。
 */
export function deriveCatalogRows(
  entries: PluginCatalogEntry[],
  installed: PluginInfo[],
): PluginCatalogRow[] {
  return entries.map((entry) => {
    const hit = installed.find((p) => p.id === entry.id)
    const selected = entry.selected?.version
    return {
      entry,
      ...(hit ? { installedVersion: hit.version } : {}),
      updateAvailable: !!(hit && selected && hit.version !== selected),
    }
  })
}

/** 更新重启提示（判定 = 安装前清单快照里同 id 已存在；同版本重装亦命中，措辞「已重新安装」） */
export interface PluginRestartNotice {
  id: string
  name: string
  fromVersion: string
  toVersion: string
  /** true = 同版本重装（措辞「已重新安装」）；false = 版本变化（措辞「已更新」） */
  reinstalled: boolean
  title: string
  message: string
}

/**
 * 纯派生：安装前快照 × 安装结果 → 重启提示；**新装返回 null（不提）**。
 * 措辞口径 = `内部版插件契约（不进公开仓）` §七（2026-09-22 用户拍板）：插件是热侧载非热刷新，
 * 覆盖安装的新版本要重启应用才完全生效。
 */
export function buildRestartNotice(before: PluginInfo[], after: PluginInfo): PluginRestartNotice | null {
  const prev = before.find((p) => p.id === after.id)
  if (!prev) return null
  const reinstalled = prev.version === after.version
  return {
    id: after.id,
    name: after.name,
    fromVersion: prev.version,
    toVersion: after.version,
    reinstalled,
    title: reinstalled ? '插件已重新安装' : '插件已更新',
    message: reinstalled
      ? `插件已重新安装：v${after.version}，重启应用后新版本完全生效（${after.name}）`
      : `插件已更新：v${prev.version} → v${after.version}，重启应用后新版本完全生效（${after.name}）`,
  }
}

/** 目录拉取失败的展示引导（把主进程的中文错误码翻成 UI 该给什么路） */
export interface CatalogErrorGuidance {
  /** 错误码（`CODE：人话` 的 CODE 部分；无前缀 = 空串） */
  code: string
  /** 展示文本（已剥掉 CODE 前缀） */
  text: string
  /** 需要登录 → UI 给「去登录」入口 */
  loginRequired: boolean
  /** 服务端未就绪（端点未部署）→ 措辞「稍后再来」，不引导用户折腾网络 */
  notDeployed: boolean
  /** 可重试（除「需登录」外一律给「重试」按钮） */
  retryable: boolean
}

/**
 * 纯派生：主进程错误串 → 引导。判据按**错误码**（`NO_SERVER：…` 形态），不猜文案——
 * 措辞改字不该让引导走偏（反例：靠 `includes('登录')` 会在「登录态已失效」与
 * 「目录为空」之间误判）。
 */
export function catalogErrorGuidance(error: string): CatalogErrorGuidance {
  const raw = String(error ?? '')
  const m = /^([A-Z_]+)：/.exec(raw)
  const code = m ? m[1] : ''
  return {
    code,
    text: m ? raw.slice(m[0].length) : raw,
    loginRequired: code === 'NOT_LOGGED_IN',
    notDeployed: code === 'NOT_DEPLOYED',
    retryable: code !== 'NOT_LOGGED_IN',
  }
}

/** 体积展示（目录项的 `size` 字节数 → 人话；服务端没给 → '—'） */
export function formatPluginSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * permissions 摘要（目录行的「权限」一栏；`'*'` 醒目——装在本地跑的是同等系统权限，
 * 目录页必须在下单前就把这条亮出来）。无声明 → 「未声明」。
 */
export function summarizeCatalogPermissions(perms?: PluginInfo['permissions']): string {
  const parts: string[] = []
  for (const d of perms?.network ?? []) parts.push(d === '*' ? '任意网络域名（⚠ 需说明理由）' : `网络 ${d}`)
  if (perms?.clipboard) parts.push('剪贴板')
  if (perms?.notification) parts.push('系统通知')
  if (perms?.account) parts.push('账号登录态')
  if (perms?.customers) parts.push('客户档案')
  if (perms?.share) parts.push('局域网共享')
  return parts.length > 0 ? parts.join('、') : '未声明'
}

/** 卸载（删除 pkg/ 与 state/；UI 明示确认后调用） */
export function uninstallPlugin(pluginId: string): Promise<ApiResult<boolean>> {
  return getPluginsBridge().uninstall(pluginId)
}

// —— v2.5 增量（PLAN §3.5）：开发者模式（侧载收紧）——

/** 开发者模式是否开启（默认 false；管理页据此显示侧载导入入口）；返回 ApiResult<boolean> 包装 */
export function getDevMode(): Promise<ApiResult<boolean>> {
  return getSettingsBridge().getDevMode()
}

/** 设置开发者模式（userData/settings.json 持久化，重启保持）；返回 ApiResult<boolean> 包装 */
export function setDevMode(enabled: boolean): Promise<ApiResult<boolean>> {
  return getSettingsBridge().setDevMode(enabled)
}
