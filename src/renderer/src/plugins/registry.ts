/**
 * 渲染层插件注册表（v2.5，P0）：插件宿主三段架构之渲染层（PLUGIN.md §3.3）。
 *
 * 职责：`plugins.list()` 拉取已安装清单 → 派生 Sidebar 插件分组 / 动态路由表 / 右键命令集；
 * 订阅 `plugins:changed` 事件即时刷新（启停即时生效，不重启）。
 *
 * 本文件为纯逻辑模块（无 JSX）：派生函数为纯函数（可单测、不触碰 window），
 * 与 preload 桥的接触集中在 getPluginsBridge() 一处。qihebox.d.ts 的 plugins 命名空间
 * 由 preload 子代理补充，此处以本地最小类型 + 断言过渡（preload 落地后可收敛为直接访问）。
 * 模块级信号在未调用 initPluginRegistry() 前为零开销；未安装/禁用插件不派生任何注入点。
 * 所有 IPC 返回均为 ApiResult 包装（主进程统一包裹，此处直读 success/error）。
 */
import { createSignal } from 'solid-js'
import type { ApiResult, PluginInfo } from '../../../shared/types'

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
}

/** preload plugins 命名空间的最小本地类型（纯透传，不 import 任何插件代码） */
interface PluginBridge {
  list(): Promise<ApiResult<PluginInfo[]>>
  call(pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>>
  setEnabled(pluginId: string, enabled: boolean): Promise<ApiResult<boolean>>
  install(opts: { filePath: string }): Promise<ApiResult<PluginInfo>>
  uninstall(pluginId: string): Promise<ApiResult<boolean>>
  on(channel: string, cb: (data: unknown) => void): () => void
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

/** 侧载安装本地 .qbox（主进程做 JSON Schema + SHA-256 校验后解压到 pkg/） */
export function installPlugin(opts: { filePath: string }): Promise<ApiResult<PluginInfo>> {
  return getPluginsBridge().install(opts)
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
