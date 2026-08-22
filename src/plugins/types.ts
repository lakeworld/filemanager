/**
 * 插件协议同源定义（v2.5，P0）：
 * 权威来源 = docs/PLUGIN.md（公开契约：§三 PluginManifest / §五 双向 API PluginHost·PluginRegistration）；
 * 内部版 docs/INTERNAL/PLUGIN.md 与之双处同步，冲突时以公开版 + 实现为准。
 * 本文件为纯类型模块 + 清单校验函数：不 import electron / node / 任何模块，
 * 编译后不产生运行时依赖（src/plugins/** 仅入 tsconfig.node.json，供主进程侧复用）。
 * 渲染层可见的运行时类型（PluginInfo 等）收敛于 src/shared/types.ts。
 * 全局唯一性（id / ipcPrefix / pages[].path）属 registry 登记期校验，不在此函数内（本函数无宿主上下文）。
 */

/** 展示文本：v1 直接用裸字符串（仅中文）；为未来 i18n 预留 map 形态，
 *  解析器接受 string | map，裸字符串等价于 { default: string }（非 breaking 扩展） */
export type PluginText = string | { default: string; [locale: string]: string }

export interface PluginManifest {
  /** 全局唯一 id，域名倒序，如 'com.qihe.ai'。冲突 → 宿主标记 broken */
  id: string
  /** 展示名（管理页/侧边栏） */
  name: PluginText
  /** 插件版本（语义化版本） */
  version: string
  /** 插件所针对的宿主 API 版本（当前宿主 API_VERSION = 1） */
  apiVersion: number
  /** 兼容的宿主 API 版本范围 [min, max]，默认 [apiVersion, apiVersion] */
  apiCompat?: [number, number]
  /** 宿主产品版本下限（如 '2.5.0'），排查用；与 apiCompat 并存（API 版本解耦、产品版本可读） */
  minHostVersion?: string
  /** 传输层：v1 唯一合法值 'inproc'（进程内握手）；其余值 → broken。
   *  'process' / 'http' 为未来跨进程隔离与 loopback 桥接预留（见 PLUGIN.md 第十章），协议语义不变 */
  transport?: 'inproc'
  /** 默认启停；可被 userData/plugins/config.json 覆盖（管理页操作） */
  enabled: boolean
  /** 状态同步范围（v2.5 增量，PLAN §3.1）：'global' = state/ 期望跨设备可用；'local' = 仅本机。
   *  缺省 'local'；消费方待定（2026-08-14：状态云同步降级，候选 = 插件状态进工作区，实施 LAN 插件前定稿）。
   *  与 commands[].scope（'file'|'global'）及渲染层 FileListRequest.scope 完全无关（双重避让，命名不可用 scope） */
  syncScope?: 'global' | 'local'
  /** 能力类型：至少声明其一 */
  kind: Array<'ipc' | 'pages' | 'commands'>
  /** 插件 IPC 通道前缀 → 宿主注册 `qihebox:plugin:<prefix>:<action>`。全局唯一，冲突 → broken */
  ipcPrefix: string
  /** 声明式权限：v1 进程内无法技术强制（见 PLUGIN.md §2.6），仅用于管理页向用户展示
   *  （"此插件将访问 api.qihe.com"）；未来 transport='process' 时升级为宿主强制拦截 */
  permissions?: {
    /** 网络访问域名白名单，如 ['api.qihe.com']；'*' 必须附 reasoning */
    network?: string[]
    clipboard?: boolean
    notification?: boolean
    /** 账号能力（v2.5 增量，PLAN §3.2）：声明后 host.account 返回真实登录态；未声明恒 null */
    account?: boolean
    /** customers 能力域（v2.5.1 A1，PLAN-v2.6-v2.7 §3.1）：声明后 host.customer.* 可用；
     *  未声明 → 全部方法抛 PERMISSION_DENIED（含读方法，与 account 恒 null 静默不同） */
    customers?: boolean
    /** suppliers 能力域（v2.5.4 弹一 C-2，云桥 M3）：声明后 host.supplier.* 可用；
     *  独立位（不复用 customers——不同数据域显式声明更诚实）；未声明 → PERMISSION_DENIED */
    suppliers?: boolean
    /** share 能力域（v2.5.1 A2，PLAN-v2.6-v2.7 §3.2）：声明后 host.share.* 可用；未声明 → PERMISSION_DENIED */
    share?: boolean
  }
  /** 激活事件（惰性加载的触发点补充）：onView/onCommand 由 pages/commands 声明自动推断，无需手写；
   *  仅事件订阅类/后台类插件必须显式声明，否则永远不激活（见 PLUGIN.md §2.3） */
  activation?: Array<'onStartupFinished' | `onEvent:${string}`>
  /** pages 能力：注册到渲染层路由与 Sidebar 的页面入口 */
  pages?: Array<{
    /** 路由路径，必须带插件前缀，如 '/plugin/ai'，避免与本体路由冲突 */
    path: string
    label: PluginText
    icon: string
    group: string
    /** 页面模块入口：包内相对路径（如 'renderer/pages/Main.js'）。
     *  宿主经 qihebox://plugin/<id>/ 协议 URL 动态 import（访问才加载），组件 = 模块默认导出 */
    component: string
  }>
  /** commands 能力：右键菜单扩展点 */
  commands?: Array<{
    id: string          // 插件内唯一
    label: PluginText
    scope: 'file' | 'global'
    /** 可见性过滤：仅匹配的文件类型出现该命令（防右键菜单污染），如 { exts: ['.png', '.jpg'] } */
    when?: { exts?: string[] }
  }>
  description?: PluginText
  author?: string
  license?: string
  keywords?: string[]
  /** 插件自身图标（管理页展示；pages[].icon 是菜单图标，两者不同） */
  icon?: string
  homepage?: string
}

/**
 * 实体档案基型（v2.5.4 弹一 C-5c，协议真合并）：customer/supplier 共享的公共字段——
 * 宿主协议以「实体域」为核心组织，EntityProfile 保证各实体档案形状同源（name/erp_ext/updated_at 单点定义）。
 */
export interface EntityProfile {
  name: string
  /** erp-bridge 写回命名空间（本体只读不校验，插件经 writeErpExt 写） */
  erp_ext?: Record<string, unknown>
  updated_at: string
}

/**
 * 客户档案（customer.list/get 返回形状，v2.5.4 类型收口 P1-7：对齐 shared/types.ts CustomerInfo，
 * 运行时不变——此处仅把 unknown 收窄为协议承诺的字段集；file_count 恒存在（目录递归计数））
 */
export interface CustomerProfile extends EntityProfile {
  /** 文件数统计（客户目录递归计数） */
  file_count: number
  alias?: string
  country?: string
  contact?: string
  source?: string
  /** 客户类型（启禾 OS company/individual 中文枚举；缺省=未分类） */
  type?: '企业' | '个人'
  phone?: string
  email?: string
  address?: string
  tags: string[]
  notes: string
  /** 关联产品集名数组（唯一写点在客户侧） */
  related_product_sets?: string[]
  created_at: string
}

/**
 * 供应商档案（supplier.list/get 返回形状，v2.5.4 弹一 C-1：对齐 shared/types.ts SupplierInfo，
 * 运行时不变——此处仅把 unknown 收窄为协议承诺的字段集；file_count 恒存在（目录递归计数））
 */
export interface SupplierProfile extends EntityProfile {
  /** 文件数统计（供应商目录递归计数） */
  file_count: number
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes: string
  tags: string[]
  /** 关联产品集名数组（唯一写点在供应商侧） */
  related_product_sets?: string[]
  created_at: string
}

/**
 * 报价单档案（quote.list/get 返回形状，v2.5.4 弹一 C-4：对齐 shared/types.ts QuoteRecord，
 * 运行时不变；**只读投影**——host 不提供任何报价写方法，报价建档永远走预填桥手动确认）
 */
export interface QuoteProfile {
  quotation_no: string
  /** 报价日期 YYYY-MM-DD */
  date: string
  /** 关联客户名（存在性不校验） */
  customer?: string
  lines: { product: string; sku?: string; qty: number; unit_price: number; amount: number }[]
  total_amount: number
  status: '草稿' | '已确认' | '修订中'
  confirmed_at?: string
  notes?: string
  file_path: string
  /** keji 同步写回预留命名空间（本体只读不校验） */
  quote_ext?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 宿主 → 插件：activate(host) 注入的能力（PLUGIN.md §2.4.1）。v1 为进程内握手 */
export interface PluginHost {
  /** 宿主 API 版本（当前恒为 1） */
  apiVersion: number

  log(level: 'info' | 'warn' | 'error', msg: string): void

  /** 状态隔离存储：userData/plugins/<id>/state/，与本体 config/metadata 完全隔离。
   *  全异步接口（避免同步磁盘 I/O 阻塞主进程）；宿主在激活时一次性读入内存缓存，写时落盘 */
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }

  /** 事件总线：订阅宿主事件（workspaceChanged / importComplete / certExpiring / updateAvailable...），
   *  或向渲染层广播事件（渲染层经 window.qihebox.plugins.on 订阅）。
   *  通道前缀约束（与 §2.5 IPC 前缀规则对齐）：插件 emit 的 channel 必须以本插件 ipcPrefix 开头；
   *  宿主保留事件（无插件前缀）只能 on 不能 emit，防止插件冒充本体事件 */
  events: {
    on(channel: string, cb: (data: unknown) => void): () => void
    emit(channel: string, data: unknown): void
  }

  /** 受限的核心能力（白名单，不放开任意文件操作） */
  workspace: {
    currentPath(): string | null
    list(): unknown
  }
  dialog: {
    openFile(opts: unknown): Promise<string>
    openDirectory(opts: unknown): Promise<string>
  }
  notify(title: string, body: string): boolean

  /** 账号登录态（本体能力，v2.5 增量接通 PLAN §3.2）：同步签名，token 来自 AccountService 内存缓存。
   *  未登录 → null（非空串）；manifest.permissions.account !== true 时恒 null（装配层注入空实现）。
   *  safeStorage 异常 → null + 日志警告，不抛 */
  account: {
    getToken(): string | null
    isLoggedIn(): boolean
  }

  /** 工作区文件能力域（v2.5 增量，PLAN §3.3）：受限读写，错误为带 code 的业务错误（不触发熔断计数）。
   *  错误码：NOT_FOUND / OUT_OF_WORKSPACE / NO_WORKSPACE / TOO_LARGE / INVALID_NAME / IO_ERROR */
  files: {
    /** 读文本文件（UTF-8）：relPath 相对工作区，realpath 防 symlink 逃逸，大小 ≤ 10MB */
    readText(relPath: string): Promise<string>
    /** 读二进制文件：同上，大小 ≤ 50MB */
    readBuffer(relPath: string): Promise<Uint8Array>
    /** 写导出物：平铺写入 工作区/导出/<pluginId>_<fileName>（exports:list 自动展示），大小 ≤ 50MB */
    writeExport(fileName: string, data: string | Uint8Array): Promise<void>
  }

  /** customers 能力域（v2.5.1 A1，PLAN-v2.6-v2.7 §3.1）：客户档案读 + erp 写 + 关联。
   *  权限门控：manifest.permissions.customers !== true → 全部方法（含读）抛 PERMISSION_DENIED。
   *  错误码：PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / INVALID_NAME / FIELD_DENIED / STALE / IO_ERROR */
  customer: {
    /** 客户档案全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
    list(since?: string): Promise<CustomerProfile[]>
    /** 单客户档案；不存在（以目录为准）→ null */
    get(name: string): Promise<CustomerProfile | null>
    /** 仅写 erp_ext 命名空间（整体替换）；目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → NOT_FOUND */
    writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
    /** 双向同步：写本体对齐字段（type/contact/phone/email/address/notes）+ erp_ext；
     *  回显式乐观锁：req.updated_at ≤ 档案 updated_at → STALE；较新 → 仅写白名单差异字段；
     *  box 权威字段（alias/country/source/related_product_sets/tags）入参 → FIELD_DENIED */
    syncProfile(req: {
      name: string
      fields?: { type?: '企业' | '个人'; contact?: string; phone?: string; email?: string; address?: string; notes?: string }
      erp_ext?: Record<string, unknown>
      updated_at: string
    }): Promise<{ applied: boolean }>
    relation: {
      /** 客户↔产品集关联（related_product_sets 增删）；幂等；产品集不存在 → NOT_FOUND */
      link(customerName: string, productSetName: string): Promise<void>
      unlink(customerName: string, productSetName: string): Promise<void>
    }
  }

  /** suppliers 能力域（v2.5.4 弹一 C-1，云桥 M3，照 customer 域薄壳模式）。
   *  权限门控：manifest.permissions.suppliers !== true → 全部方法（含读）抛 PERMISSION_DENIED。
   *  错误码：PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / INVALID_NAME / FIELD_DENIED / STALE / IO_ERROR */
  supplier: {
    /** 供应商档案全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
    list(since?: string): Promise<SupplierProfile[]>
    /** 单供应商档案；不存在（以目录为准）→ null */
    get(name: string): Promise<SupplierProfile | null>
    /** 仅写 erp_ext 命名空间（整体替换）；目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → NOT_FOUND */
    writeErpExt(name: string, ext: Record<string, unknown>): Promise<void>
    /** 双向同步：写本体对齐字段（contact/phone/email/address/notes）+ erp_ext；
     *  回显式乐观锁：req.updated_at ≤ 档案 updated_at → STALE；较新 → 仅写白名单差异字段；
     *  box 权威字段（tags/related_product_sets）入参 → FIELD_DENIED */
    syncProfile(req: {
      name: string
      fields?: { contact?: string; phone?: string; email?: string; address?: string; notes?: string }
      erp_ext?: Record<string, unknown>
      updated_at: string
    }): Promise<{ applied: boolean }>
  }

  /** quote 只读域（v2.5.4 弹一 C-4，云桥 M3）：报价台账只读投影（增量读）。
   *  权限门控：**并入 `permissions.customers` 同一位**（C-2 拍板——客户/供应商/报价是同一桥插件的
   *  客户关系数据面，权限位不碎片化）；未声明 → 全部方法抛 PERMISSION_DENIED。
   *  **无任何写方法**——报价在 box 侧的建档永远走预填桥手动确认；上行推送后 erp 回执存插件 storage。
   *  错误码：PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / IO_ERROR */
  quote: {
    /** 报价台账全量/增量列表；since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
    list(since?: string): Promise<QuoteProfile[]>
    /** 单条报价；不存在（无此单号）→ null */
    get(quotationNo: string): Promise<QuoteProfile | null>
  }

  /** share 能力域（v2.5.1 A2，PLAN-v2.6-v2.7 §3.2）：工作区只读实体视图 + 拉取写（局域网共享契约通道）。
   *  权限门控：manifest.permissions.share !== true → 全部方法抛 PERMISSION_DENIED。
   *  错误码：PERMISSION_DENIED / NO_WORKSPACE / NOT_FOUND / INVALID_NAME / HIDDEN / OUT_OF_WORKSPACE / IO_ERROR */
  share: {
    /** 只读实体视图（字段白名单，不含 erp_ext/ocr_ext 命名空间） */
    listProductSets(): Promise<unknown[]>
    listCustomers(): Promise<unknown[]>
    /** 目录树一层（名称/类型/大小/mtime）；relPath 缺省 = 工作区根；隐藏目录拒绝（HIDDEN） */
    listTree(relPath?: string): Promise<unknown[]>
    /** tags/notes 元数据（无记录 → 空 tags + 空 notes）；文件路径 → metadata store；产品集根 → product_sets.json */
    getMetadata(relPath: string): Promise<{ tags: string[]; notes: string }>
    statFile(relPath: string): Promise<{ size: number; mtime: string }>
    /** Range 读：≤4MB/次；host 侧定位读（fs.read position，禁止全量载入）；越界截断到 EOF（短读） */
    readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array>
    /** 拉取写：offset=0 新建截断、>0 定位写；单 chunk ≤4MB；拒绝清单（.qihefilemanager/、导出/、交换区/）→ HIDDEN；
     *  realpath 逃逸 → OUT_OF_WORKSPACE；写入后失效目标目录索引快照 */
    writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void>
    /** 同名合并：存在 → 'exists'（零覆盖）；不存在 → 复用产品集/客户创建 → 'created' */
    ensureProductSet(name: string): Promise<'created' | 'exists'>
    ensureCustomer(name: string): Promise<'created' | 'exists'>
    /** 元数据合并导入：两级粒度；tags 并集；notes 本地为空采纳远端、本地非空且不同 → 保留本地（计入冲突清单）；
     *  单批 ≤ 500 条；返回冲突清单供插件提示 */
    mergePulledMetadata(entries: { path: string; tags: string[]; notes: string }[]): Promise<{ conflicts: string[] }>
  }

  /** 权益占位（v2.5 增量，PLAN §3.4）：恒 free、零逻辑（红线 4：本体不做任何订阅实现），
   *  真实权益由官方订阅插件提供（v2.7 接通），插件须判空按 free 处理 */
  entitlement: {
    status(): EntitlementStatus
  }
}

/** 权益状态（协议契约，v2.7 前恒 free；quota 为通用配额映射，不绑死具体配额名） */
export interface EntitlementStatus {
  tier: 'free' | 'subscribed'
  expiresAt: string | null
  quota: { [key: string]: { used: number; limit: number } } | null
}

/** 业务错误（host.files 等）：带 code 属性的错误不被加载器计入熔断（PLAN §3.3 r2-性能P1-2） */
export interface PluginBusinessError extends Error {
  code: string
}

/** 插件 → 宿主：activate(host) 返回的能力注册表（PLUGIN.md §2.4.2） */
export interface PluginRegistration {
  /** 插件 IPC 通道：key = action，完整通道 = `qihebox:plugin:<ipcPrefix>:<action>` */
  ipc?: Record<string, (args: unknown) => Promise<unknown>>
  /** 页面注册（与 manifest.pages 的 component 模块路径对应） */
  pages?: PluginManifest['pages']
  /** 命令回调：key = manifest.commands[].id */
  commands?: Record<string, (ctx: { filePaths: string[]; host: PluginHost }) => Promise<void> | void>
  /** 停用清理：定时器、事件订阅、长连接 */
  dispose?: () => void
}

/** 宿主 API 版本（当前恒为 1，apiCompat 相交校验的基准） */
export const API_VERSION = 1

// —— manifest 校验（validateManifest）：逐条落地 PLUGIN.md §2.2 的 7 条规则 + v2.5 增量规则⑧⑨ + 结构校验 ——
// 规则 1（id / ipcPrefix 全局唯一、pages[].path 不冲突）中「全局唯一」部分无宿主上下文，由 registry 登记期校验；
// 此处校验本函数的可判定部分：id 须为域名倒序、ipcPrefix 非空且不得以保留前缀 qihebox: 开头、pages[].path 格式。

/** id 格式：域名倒序（如 com.qihe.hello），小写字母/数字标签、至少两段、无空段 */
const ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/

/** 主机名格式：标签可含连字符（不以 - 开头/结尾），可无 TLD（如 localhost）；拒绝端口、路径、通配前缀（仅 '*' 整体通配） */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPluginText(v: unknown): v is PluginText {
  if (typeof v === 'string') return true
  if (!isRecord(v)) return false
  if (typeof v.default !== 'string') return false
  return Object.values(v).every((x) => typeof x === 'string')
}

/** PluginText 是否为空（去空白）：用于 network:'*' 的 description 非空判定 */
function isPluginTextBlank(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length === 0
  if (isRecord(v) && typeof v.default === 'string') return v.default.trim().length === 0
  return true
}

/** 包内相对路径安全判定：拒绝绝对路径（/ 或 \ 开头）与 '..' 逃逸（PLUGIN.md §2.2 规则 4） */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0) return false
  const norm = p.replace(/\\/g, '/')
  if (norm.startsWith('/')) return false
  return !norm.split('/').some((s) => s === '..')
}

/**
 * 校验插件清单（manifest.json 的 JSON 结构）。
 * 逐条落地 PLUGIN.md §2.2 的 7 条规则（全局唯一性除外，见上注释）+ v2.5 增量规则⑧（syncScope）⑨（permissions.account）
 * + 必需字段/类型错误结构校验；
 * 每条错误均为中文描述、一次性汇总返回（不提前终止），ok = errors 为空。
 * 特别口径：规则 6「network '*' 必须附 reasoning」——协议未定义 reasoning 字段，
 * 落地为 network 含 '*' 时要求 manifest.description 非空（管理页醒目展示的依据，见 PLAN §5.4）。
 */
export function validateManifest(input: unknown): { ok: boolean; errors: string[] } {
  if (!isRecord(input)) {
    return { ok: false, errors: ['manifest 必须为 JSON 对象'] }
  }
  const errors: string[] = []

  // —— 结构校验：必需字段（缺失 / 类型错误逐条报）——

  if (typeof input.id !== 'string' || input.id.length === 0) {
    errors.push('id 缺失或非字符串')
  } else if (!ID_RE.test(input.id)) {
    errors.push(`id 须为域名倒序（如 com.qihe.hello），当前值非法：${JSON.stringify(input.id)}`)
  }

  if (typeof input.ipcPrefix !== 'string' || input.ipcPrefix.length === 0) {
    errors.push('ipcPrefix 缺失或非字符串')
  } else if (input.ipcPrefix.startsWith('qihebox:')) {
    errors.push(`ipcPrefix 不得以保留前缀 "qihebox:" 开头（宿主前缀强校验，PLUGIN.md §2.6），当前值：${JSON.stringify(input.ipcPrefix)}`)
  }

  if (!isPluginText(input.name)) {
    errors.push('name 缺失或非 PluginText（须为字符串或 { default: string } 映射）')
  }

  if (typeof input.version !== 'string' || input.version.length === 0) {
    errors.push('version 缺失或非字符串')
  }

  if (typeof input.apiVersion !== 'number') {
    errors.push('apiVersion 缺失或非数字')
  }

  if (typeof input.enabled !== 'boolean') {
    errors.push('enabled 缺失或非布尔值')
  }

  const kind = input.kind
  if (!Array.isArray(kind) || kind.length === 0) {
    errors.push('kind 缺失或为空数组（须声明至少一项能力：ipc / pages / commands）')
  } else {
    for (const k of kind) {
      if (typeof k !== 'string' || (k !== 'ipc' && k !== 'pages' && k !== 'commands')) {
        errors.push(`kind 含非法值：${JSON.stringify(k)}（合法值：ipc / pages / commands）`)
      }
    }
  }

  // —— 规则 ②：kind 声明与 pages/commands 字段存在性一致（双向）——
  if (Array.isArray(kind)) {
    const kinds = kind.filter((k): k is string => typeof k === 'string')
    const hasPages = Array.isArray(input.pages)
    const hasCommands = Array.isArray(input.commands)
    if (kinds.includes('pages') && !hasPages) errors.push('kind 声明了 "pages" 但 manifest 缺少 pages 数组')
    if (hasPages && !kinds.includes('pages')) errors.push('manifest 声明了 pages 数组但 kind 未声明 "pages"')
    if (kinds.includes('commands') && !hasCommands) errors.push('kind 声明了 "commands" 但 manifest 缺少 commands 数组')
    if (hasCommands && !kinds.includes('commands')) errors.push('manifest 声明了 commands 数组但 kind 未声明 "commands"')
  }

  // —— 规则 ③：apiCompat 与宿主 API_VERSION=1 相交（缺省即 [1,1]）——
  const apiCompat = input.apiCompat
  if (apiCompat !== undefined) {
    const isTuple =
      Array.isArray(apiCompat) &&
      apiCompat.length === 2 &&
      typeof apiCompat[0] === 'number' &&
      typeof apiCompat[1] === 'number' &&
      apiCompat[0] <= apiCompat[1]
    if (!isTuple) {
      errors.push('apiCompat 须为 [min, max] 数值元组（min ≤ max）')
    } else if (apiCompat[0] > API_VERSION || apiCompat[1] < API_VERSION) {
      errors.push(`apiCompat [${apiCompat[0]}, ${apiCompat[1]}] 与宿主 API_VERSION=${API_VERSION} 不相交（须满足 min ≤ ${API_VERSION} ≤ max）`)
    }
  }
  // minHostVersion：仅记录不校验（宿主产品版本为运行时上下文，registry 消费时比对；非字符串仍属类型错误）
  if (input.minHostVersion !== undefined && typeof input.minHostVersion !== 'string') {
    errors.push('minHostVersion 须为字符串')
  }

  // —— 规则 ⑤：transport 缺省或 'inproc'——
  if (input.transport !== undefined && input.transport !== 'inproc') {
    errors.push(`transport 仅支持缺省或 "inproc"（进程内握手），当前值：${JSON.stringify(input.transport)}`)
  }

  // —— 规则 ⑧（v2.5 增量，PLAN §3.1）：syncScope 合法枚举或缺失（缺省 'local'）——
  if (input.syncScope !== undefined && input.syncScope !== 'global' && input.syncScope !== 'local') {
    errors.push(`syncScope 仅支持缺省（默认 "local"）、"global" 或 "local"，当前值：${JSON.stringify(input.syncScope)}`)
  }

  // —— 规则 ⑥：permissions.network 域名合法；'*' 须附 reasoning（落地为 description 非空）——
  const permissions = input.permissions
  if (permissions !== undefined) {
    if (!isRecord(permissions)) {
      errors.push('permissions 须为对象')
    } else {
      const network = permissions.network
      if (network !== undefined) {
        if (!Array.isArray(network) || !network.every((d) => typeof d === 'string')) {
          errors.push('permissions.network 须为字符串数组（域名白名单或 "*"）')
        } else {
          let hasWildcard = false
          for (const d of network) {
            if (d === '*') {
              hasWildcard = true
            } else if (!HOSTNAME_RE.test(d)) {
              errors.push(`permissions.network 含非法域名：${JSON.stringify(d)}（须为合法主机名或 "*"）`)
            }
          }
          if (hasWildcard && !isPluginText(input.description)) {
            errors.push('permissions.network 含 "*" 时须提供 description（管理页展示依据，对应 PLUGIN.md「"*" 必须附 reasoning」）')
          } else if (hasWildcard && isPluginTextBlank(input.description)) {
            errors.push('permissions.network 含 "*" 时 description 不可为空（管理页展示依据，对应 PLUGIN.md「"*" 必须附 reasoning」）')
          }
        }
      }
      if (permissions.clipboard !== undefined && typeof permissions.clipboard !== 'boolean') {
        errors.push('permissions.clipboard 须为布尔值')
      }
      if (permissions.notification !== undefined && typeof permissions.notification !== 'boolean') {
        errors.push('permissions.notification 须为布尔值')
      }
      // —— 规则 ⑨（v2.5 增量，PLAN §3.2）：permissions.account 布尔校验 ——
      if (permissions.account !== undefined && typeof permissions.account !== 'boolean') {
        errors.push('permissions.account 须为布尔值')
      }
      // —— 规则 ⑩（v2.5.1 A1/A2 + v2.5.4 弹一 C-2，PLAN-v2.6-v2.7 §3.1/§3.2）：customers / suppliers / share 布尔校验 ——
      if (permissions.customers !== undefined && typeof permissions.customers !== 'boolean') {
        errors.push('permissions.customers 须为布尔值')
      }
      // v2.5.4（弹一 C-2，云桥 M3）：permissions.suppliers 独立位（不复用 customers——不同数据域显式声明更诚实）
      if (permissions.suppliers !== undefined && typeof permissions.suppliers !== 'boolean') {
        errors.push('permissions.suppliers 须为布尔值')
      }
      if (permissions.share !== undefined && typeof permissions.share !== 'boolean') {
        errors.push('permissions.share 须为布尔值')
      }
    }
  }

  // —— 规则 ④：pages[].component 包内相对路径（拒绝绝对路径与 '..' 逃逸）+ pages[].path 必须带 '/plugin/' 前缀——
  // v2.5 实施收紧（2026-08-11）：插件页面路由统一经宿主「/plugin/*rest 通配 + 运行时查表」分发
  // （@solidjs/router 对 mount 后新增 Route 的响应式重注册不可靠），故 path 前缀收窄为 '/plugin/'，
  // 与本体路由（/product-sets、/settings 等）无冲突可能；PLAN-v2.5 已注明此协议决策。
  if (Array.isArray(input.pages)) {
    input.pages.forEach((p, i) => {
      const where = `pages[${i}]`
      if (!isRecord(p)) {
        errors.push(`${where} 须为对象`)
        return
      }
      if (typeof p.path !== 'string' || p.path.length === 0) {
        errors.push(`${where}.path 缺失或非字符串`)
      } else if (!p.path.startsWith('/plugin/')) {
        errors.push(`${where}.path 须以 "/plugin/" 开头（宿主统一通配分发，如 /plugin/ai），当前值：${JSON.stringify(p.path)}`)
      }
      if (!isPluginText(p.label)) errors.push(`${where}.label 缺失或非 PluginText（字符串或 { default: string } 映射）`)
      if (typeof p.icon !== 'string') errors.push(`${where}.icon 缺失或非字符串`)
      if (typeof p.group !== 'string') errors.push(`${where}.group 缺失或非字符串`)
      if (typeof p.component !== 'string') {
        errors.push(`${where}.component 缺失或非字符串`)
      } else if (!isSafeRelativePath(p.component)) {
        errors.push(`${where}.component 须为包内相对路径（拒绝绝对路径与 ".." 逃逸），当前值：${JSON.stringify(p.component)}`)
      }
    })
  }

  // —— commands 结构校验 ——
  if (Array.isArray(input.commands)) {
    input.commands.forEach((c, i) => {
      const where = `commands[${i}]`
      if (!isRecord(c)) {
        errors.push(`${where} 须为对象`)
        return
      }
      if (typeof c.id !== 'string' || c.id.length === 0) errors.push(`${where}.id 缺失或非字符串`)
      if (!isPluginText(c.label)) errors.push(`${where}.label 缺失或非 PluginText（字符串或 { default: string } 映射）`)
      if (c.scope !== 'file' && c.scope !== 'global') errors.push(`${where}.scope 须为 "file" 或 "global"`)
      if (c.when !== undefined) {
        if (!isRecord(c.when)) {
          errors.push(`${where}.when 须为对象`)
        } else if (c.when.exts !== undefined && (!Array.isArray(c.when.exts) || !c.when.exts.every((e) => typeof e === 'string'))) {
          errors.push(`${where}.when.exts 须为字符串数组`)
        }
      }
    })
  }

  // —— 规则 ⑦：activation 中 onEvent:<channel> 的 channel 必须以本插件 ipcPrefix 开头（防冒充宿主事件）——
  const activation = input.activation
  if (activation !== undefined) {
    if (!Array.isArray(activation)) {
      errors.push('activation 须为数组（"onStartupFinished" 或 "onEvent:<channel>"）')
    } else {
      activation.forEach((a, i) => {
        if (typeof a !== 'string') {
          errors.push(`activation[${i}] 须为字符串`)
          return
        }
        if (a === 'onStartupFinished') return
        if (a.startsWith('onEvent:')) {
          const channel = a.slice('onEvent:'.length)
          if (typeof input.ipcPrefix === 'string' && input.ipcPrefix.length > 0 && !channel.startsWith(input.ipcPrefix)) {
            errors.push(`activation[${i}] 的 onEvent 通道 ${JSON.stringify(channel)} 必须以本插件 ipcPrefix "${input.ipcPrefix}" 开头`)
          }
        } else {
          errors.push(`activation[${i}] 非法：${JSON.stringify(a)}（合法值："onStartupFinished" 或 "onEvent:<channel>"）`)
        }
      })
    }
  }

  // —— 其余可选字段类型校验 ——
  if (input.description !== undefined && !isPluginText(input.description)) {
    errors.push('description 须为 PluginText（字符串或 { default: string } 映射）')
  }
  for (const f of ['author', 'license', 'icon', 'homepage'] as const) {
    if (input[f] !== undefined && typeof input[f] !== 'string') {
      errors.push(`${f} 须为字符串`)
    }
  }
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || !input.keywords.every((k) => typeof k === 'string'))) {
    errors.push('keywords 须为字符串数组')
  }

  return { ok: errors.length === 0, errors }
}
