/**
 * 双端共享纯类型（P2 类型共享批）：
 * 消除 src/renderer/src/types.ts 与 src/main/core/*、src/main/ipc.ts 中重复的类型定义。
 * 本文件为纯类型模块（无任何运行时导出），main 与 renderer 均以 `import type` / `export type` 引用，
 * 编译后不产生任何运行时依赖；字段取值按「两端的并集」取宽松版本（如可选字段）。
 * 注意：本文件不 import 任何模块，也不使用 electron / node 类型。
 */

// —— 通用响应包装 ——
export interface ApiResult<T> {
  success: boolean
  data: T | null
  error: string | null
}

// —— 工作区 / 产品集 / 配置 ——
export interface WorkspaceInfo {
  path: string
  name: string
  created_at: string
}

/** v2.4.9 S5：命名模板槽位（product_set/sub_folder/original_name/sequence；sequence 缺省/空 → 槽位跳过） */
export type NamingField = 'product_set' | 'sub_folder' | 'original_name' | 'sequence'

export interface NamingTemplate {
  product_set_prefix: string
  product_set_suffix: string
  sku_separator: string
  sku_fields: NamingField[]
  conflict_suffix: string
}

export interface WorkspaceConfig {
  name: string
  naming_template: NamingTemplate
  image_subfolders: string[]
  cert_subfolders: string[]
  /** v2.4.7：客户子文件夹默认集（旧 config 缺省时由 loadConfig 合并默认值，向后兼容零迁移） */
  customer_subfolders?: string[]
}

export interface ProductSetInfo {
  name: string
  image_count: number
  cert_count: number
  created_at: string
  tags: string[]
  notes: string
}

export interface ProductSetStats {
  image_count: number
  cert_count: number
  created_at: string
}

export interface ProductSetCreateRequest {
  name: string
  tags?: string[]
  notes?: string
}

export interface ProductSetUpdateRequest {
  name: string
  tags?: string[]
  notes?: string
}

// —— 文件 / 元数据 ——
export interface FileEntry {
  name: string
  path: string
  size: number
  modified: string
  file_type: string
  /** 缩略图路径；无缩略图时可能为 null（渲染端以此判断占位） */
  thumbnail_path: string | null
  /** v2.4.4：文件标签（fileList 从 metadata 缓存 join；无元数据或缺省为空数组） */
  tags?: string[]
}

export interface FileMetadata {
  cert_type: string
  expiry_date: string
  tags: string[]
  notes: string
  added_at: string
}

export interface FileListRequest {
  product_set: string
  file_type: string
  sub_folder: string
  /**
   * v2.4.7：实体区域作用域，缺省 'productSet'（旧调用方零改动，PLAN §4.6）。
   * - 'productSet'：product_set 槽位 = 产品集名（现行为）
   * - 'customer'：product_set 槽位 = 客户名，file_type 忽略，sub_folder 为客户子文件夹
   * - 'supplier'（v2.4.9 S2）：product_set 槽位 = 供应商名，file_type 忽略，sub_folder 为供应商固定子文件夹
   */
  scope?: 'productSet' | 'customer' | 'supplier'
  /**
   * v2.4.4：媒体类型过滤（图包库「图片/视频」筛选用）。
   * 仅在图包目录（file_type='image'/'video'）语义下生效：传入后按条目实际类型过滤；
   * 不传则列出目录内全部文件（FileBrowser 文件管理视图依赖此行为）。
   */
  media_type?: 'image' | 'video'
}

export interface ImportFileRequest {
  source_paths: string[]
  target_product_set: string
  target_folder: string
  target_type: string
  sub_folder: string
  /** v2.4.7：scope 语义同 FileListRequest；'customer' 时 target_product_set 槽位承载客户名、file_type 忽略；'supplier'（v2.4.9 S2）同构（供应商名） */
  scope?: 'productSet' | 'customer' | 'supplier'
  /** v2.3.0：批量导入取消标记（GlobalDropOverlay 生成，主进程轮询检测） */
  cancelToken?: string
}

export interface FileRenameRequest {
  path: string
  newName: string
}

export interface MoveFilesRequest {
  paths: string[]
  /** 目标绝对目录（与结构化目标二选一；保留兼容旧调用方/测试） */
  targetDir?: string
  /** 结构化目标：产品集名（后端拼路径，产品集名含特殊字符也安全） */
  target_product_set?: string
  /** 结构化目标：image → 图包，cert → 证书 */
  target_type?: string
  /** 结构化目标：子文件夹 */
  sub_folder?: string
  /** v2.4.7：scope 语义同 FileListRequest；'customer'/'supplier'（v2.4.9 S2）时结构化目标路径 = <区根>/<名>/<sub_folder> */
  scope?: 'productSet' | 'customer' | 'supplier'
}

export interface SubfolderCreateRequest {
  product_set: string
  file_type: string
  name: string
  /** v2.4.7：scope 语义同 FileListRequest；'customer' 时 config 写入 customer_subfolders；'supplier'（v2.4.9 S2）固定子文件夹集不写 config */
  scope?: 'productSet' | 'customer' | 'supplier'
}

export interface DeleteSubfolderRequest {
  product_set: string
  file_type: string
  name: string
  /** v2.4.7：scope 语义同 FileListRequest；'customer' 时 config 从 customer_subfolders 移除；'supplier'（v2.4.9 S2）无 config 键（固定集） */
  scope?: 'productSet' | 'customer' | 'supplier'
}

export interface MetadataUpdateRequest {
  /** v2.4.2：改为绝对文件路径（主进程按路径推导 产品集/图包|证书/子文件夹，元数据 key 含子文件夹、跨平台分隔符统一） */
  file_path: string
  cert_type?: string
  expiry_date?: string
  tags?: string[]
  notes?: string
}

// —— v2.4.2：批量操作的聚合结果（部分失败不回滚，明细可见）——

export interface FailedItem {
  /** 失败的文件绝对路径或导入源路径 */
  path: string
  error: string
}

export interface ImportResult {
  imported: FileEntry[]
  failed: FailedItem[]
}

export interface BatchMoveResult {
  moved: FileEntry[]
  failed: FailedItem[]
}

export interface DeleteResult {
  deleted: number
  failed: FailedItem[]
}

// —— 仪表盘 / 搜索 ——
export interface DashboardStats {
  total_product_sets: number
  total_images: number
  total_certs: number
  expiring_certs: number
  recent_files: FileEntry[]
  /** v2.4.7：客户数（客户/ 一级目录数） */
  total_customers?: number
  /** v2.4.9 打磨 M5：供应商数（供应商/ 一级目录数，同 total_customers 目录扫描口径；渲染端 ?? 0 兜底） */
  total_suppliers?: number
  /** v2.4.9 打磨 M5：报价数（报价.json 条目数；台账缺失按 0） */
  total_quotes?: number
  /** v2.4.9 打磨 M5：草稿报价数（status='草稿'；台账缺失按 0） */
  draft_quotes?: number
}

export interface SearchResult {
  files: FileEntry[]
  product_sets: ProductSetInfo[]
  /** v2.4.7：客户实体命中（客户名/别名/标签命中，对齐产品集结果形态） */
  customers?: CustomerInfo[]
}

// —— 标签 / 回收站 ——
export interface TagInfo {
  name: string
  color: string
  count: number
  /** 父标签名（子标签）或 null（顶层标签） */
  parent: string | null
  /** 子标签名列表（仅顶层标签有） */
  children: string[]
  /** 固定色预设标签（颜色不可改） */
  builtin: boolean
  /** v2.3.0：是否已定义；false = 被引用但 tags.json 无定义的「孤儿标签」 */
  defined?: boolean
}

export type TrashKind = 'file' | 'subfolder' | 'productSet' | 'customer' | 'supplier'

export interface TrashEntry {
  id: string
  /** 删除前的原始绝对路径 */
  originalPath: string
  deletedAt: string
  kind: TrashKind
  name: string
  size: number
}

// —— v2.4.4：压缩分享 / 解压 ——
export interface ArchiveCompressRequest {
  /** 待压缩的文件/目录绝对路径（须在工作区内） */
  paths: string[]
  /** 压缩包文件名（不含 .zip）；缺省按「<产品集名>_分享 或 分享_时间戳」自动生成 */
  name?: string
  /** 取消令牌（与导入取消同机制） */
  cancelToken?: string
}
export interface ArchiveExtractRequest {
  /** .zip 文件绝对路径（须在工作区内） */
  zipPath: string
  /** 'here' = 解压到当前文件夹；'folder' = 解压到 <zip 名>/ 子文件夹 */
  mode: 'here' | 'folder'
  /** 取消令牌 */
  cancelToken?: string
}
export interface ArchiveProgress {
  phase: 'compress' | 'extract'
  done: number
  total: number
  /** 当前处理条目名 */
  current: string
}
export interface ArchiveResult {
  /** 产物绝对路径（压缩包 / 解压目标目录） */
  path: string
  /** 处理的条目数 */
  count: number
  /** 总字节数 */
  size: number
}
// —— v2.4.8：导出区条目（工作区/导出/ 下的压缩分享产物）——
export interface ExportEntry {
  /** 文件名（如 xx.zip） */
  name: string
  /** 绝对路径 */
  path: string
  /** 文件大小（字节） */
  size: number
  /** 修改时间（ISO 字符串） */
  mtime: string
}
export interface ArchiveEventPayload {
  success: boolean
  cancelled?: boolean
  error?: string | null
  result?: ArchiveResult | null
}

// —— v2.4.4：批量打标 ——
export interface BatchTagRequest {
  paths: string[]
  /** 添加的标签（已有则跳过） */
  add?: string[]
  /** 移除的标签（没有则跳过） */
  remove?: string[]
}
export interface BatchTagResult {
  updated: number
  failed: FailedItem[]
}

// —— v2.4.7：客户 / 发票 / 入库 / 交换区 ——

/** 客户（对外展示，对齐 ProductSetInfo 形态：name/file_count/tags/notes/created_at/updated_at 必填，其余可选） */
export interface CustomerInfo {
  name: string
  /** 文件数统计（客户目录递归计数） */
  file_count: number
  alias?: string
  country?: string
  contact?: string
  source?: string
  /** 客户类型（启禾 OS company/individual 中文枚举；缺省=未分类，v2.4.9 S1） */
  type?: '企业' | '个人'
  phone?: string
  email?: string
  address?: string
  tags: string[]
  notes: string
  /** 关联产品集名数组（唯一写点在客户侧，产品集侧只读反查） */
  related_product_sets?: string[]
  /** 预留命名空间（v2.7 erp-bridge 写回；本体只读不校验、API 面不含入参） */
  erp_ext?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** customers.json 单条档案（客户名 = 目录名 = JSON key，不重复存于档案内；读取侧宽松容错） */
export interface CustomerExtraInfo {
  alias?: string
  country?: string
  contact?: string
  source?: string
  /** 客户类型（启禾 OS company/individual 中文枚举；缺省=未分类，旧档案宽松读取，v2.4.9 S1） */
  type?: '企业' | '个人'
  phone?: string
  email?: string
  address?: string
  tags?: string[]
  notes?: string
  related_product_sets?: string[]
  /** 预留命名空间（本体不校验其结构） */
  erp_ext?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

export interface CustomerCreateRequest {
  name: string
  alias?: string
  country?: string
  contact?: string
  source?: string
  type?: '企业' | '个人'
  phone?: string
  email?: string
  address?: string
  tags?: string[]
  notes?: string
  related_product_sets?: string[]
}

/** 客户档案更新：不含 erp_ext 字段（本体物理不可写，v2.7 erp-bridge 才写回） */
export interface CustomerUpdateRequest {
  name: string
  alias?: string
  country?: string
  contact?: string
  source?: string
  type?: '企业' | '个人'
  phone?: string
  email?: string
  address?: string
  tags?: string[]
  notes?: string
  related_product_sets?: string[]
}

// —— v2.4.9 S2：供应商（对齐客户范式：name = 目录名 = JSON key；目录扫描为实，suppliers.json 为档案）——

/** 供应商（对外展示，对齐 CustomerInfo 形态；name = 目录名 = suppliers.json key） */
export interface SupplierInfo {
  /** 主键 = 目录名 */
  name: string
  /** 联系人 */
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes?: string
  /** 标签（沿用标签体系） */
  tags?: string[]
  /** 关联产品集名数组（唯一写点在供应商侧，产品集侧只读反查留 v2.7，v2.4.9 打磨 M8） */
  related_product_sets?: string[]
  /** 文件数统计（供应商目录递归计数，同客户） */
  file_count: number
  /** 预留命名空间（v2.7 启禾 OS 同步，本体只读不校验、API 面不含入参） */
  erp_ext?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** suppliers.json 单条档案（同上但全可选；读取侧宽松容错同 customers.json） */
export interface SupplierExtraInfo {
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes?: string
  tags?: string[]
  related_product_sets?: string[]
  /** 预留命名空间（本体不校验其结构） */
  erp_ext?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

export interface SupplierCreateRequest {
  name: string
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes?: string
  tags?: string[]
  /** 关联产品集名数组（透传 create；校验产品集存在，拒绝孤儿关联，v2.4.9 打磨 M8） */
  related_product_sets?: string[]
}

/** 供应商档案更新：不含 erp_ext 字段（本体物理不可写，同 CustomerUpdateRequest 口径） */
export interface SupplierUpdateRequest {
  name: string
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes?: string
  tags?: string[]
  /** 关联产品集名数组（未传保留原值；校验产品集存在 + 去重，v2.4.9 打磨 M8） */
  related_product_sets?: string[]
}

/** 发票台账记录（invoices.json: { invoices: Record<发票号码, InvoiceRecord> }；号码 = 查重主键 = key） */
export interface InvoiceRecord {
  /** 发票号码 */
  number: string
  /** 发票代码（数电票可空） */
  code?: string
  /** 开票日期（写入归一化 YYYY-MM-DD） */
  date: string
  /** 金额（价税合计，元）；仅展示与页内合计，不进任何计算 */
  amount: number
  /** 开票方名称 */
  seller: string
  /** 购买方抬头 */
  buyer: string
  /** 状态枚举，自由流转（允许纠正误操作） */
  status: '待报销' | '已报销' | '已入账'
  /** 关联客户名（客户被删时保留字面值，UI 灰显） */
  customer?: string
  /** 待办日期（30 天内且状态 ≠ 已入账 → 待办提醒，语义用户自定） */
  due_date?: string
  /** 归档主体：工作区相对路径（/ 分隔），指向 发票/<YYYY>/ 下原件 */
  file_path: string
  tags?: string[]
  notes?: string
  /** 预留命名空间（v2.6 OCR 插件写回），本体不校验 */
  ocr_ext?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 入库单记录（inbound.json: { records: Record<单据编号, InboundRecord> }；编号 = 查重主键 = key） */
export interface InboundRecord {
  /** 单据编号 */
  id: string
  /** 入库日期（归一化 YYYY-MM-DD） */
  date: string
  /** 供应商（自由文本，不建供应商表；旧数据兼容不迁移） */
  supplier: string
  /** 关联供应商名（名字引用；供应商删除/重命名时保留字面值或由 BoxService.renameSupplier 级联，不校验存在性） */
  supplier_id?: string
  /** 关联产品集名（chip 跳转，打通「产品 → 入库凭证」下钻） */
  product_set?: string
  /** 归档主体：入库/<YYYY>/ 下文件相对路径 */
  file_path: string
  /** 金额合计（仅展示） */
  amount?: number
  notes?: string
  created_at: string
  updated_at: string
}

/** 交换区投递回执（交换区/已处理/<id>.receipt.json） */
export interface ExchangeReceipt {
  id: string
  status: 'ok' | 'error' | 'duplicate'
  /** 归集后的目标相对路径（ok 时非空） */
  target_paths: string[]
  error?: string
  processed_at: string
}

// —— v2.4.9 S3：报价单（对齐启禾 OS 报价单 Quotation；明细行 + 三态状态机；台账 报价.json: { quotes: Record<报价单号, QuoteRecord> }）——

/** 报价明细行（金额写入时计算：amount = round2(qty × unit_price)，外部注入不一致拒绝） */
export interface QuoteLine {
  /** 品名 */
  product: string
  /** 货号 */
  sku?: string
  /** 数量（≥1） */
  qty: number
  /** 单价（元，两位小数） */
  unit_price: number
  /** 小计 = round2(qty × unit_price)（写入时计算） */
  amount: number
}

/** 报价单记录（报价单号 = 查重主键 = key） */
export interface QuoteRecord {
  /** 报价单号（查重主键，自动生成或手输覆盖） */
  quotation_no: string
  /** 报价日期 YYYY-MM-DD（归档年份基准） */
  date: string
  /** 关联客户名（改名级联更新；删除保留字面值 UI 灰显） */
  customer?: string
  /** 明细行（≥1 行） */
  lines: QuoteLine[]
  /** 汇总 = round2(Σ lines.amount)（写入时计算） */
  total_amount: number
  /** 状态枚举（对齐 keji draft/confirmed/revising） */
  status: '草稿' | '已确认' | '修订中'
  /** 确认时间 ISO（状态→已确认时写入；修订中→已确认 刷新） */
  confirmed_at?: string
  notes?: string
  /** 归档主体：报价/<YYYY>/ 下原件（PDF/图片），可空 */
  file_path: string
  /** 预留命名空间（v2.7 keji 同步写回：confirmed_by/expand/keji_lines），本体只读不校验、API 面不含入参 */
  quote_ext?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 新建请求：quotation_no 可选（不传自动生成 QT-YYYYMMDD-序号；传了查重覆盖）；total_amount/quote_ext 不在 API 面（内部计算/只读保留） */
export interface QuoteCreateRequest {
  quotation_no?: string
  /** 报价日期（严格 YYYY-MM-DD） */
  date: string
  /** 关联客户名（名字引用，不校验存在性） */
  customer?: string
  /** 明细行（≥1 行） */
  lines: QuoteLine[]
  notes?: string
  /** 归档主体：工作区绝对路径或 报价/<YYYY>/ 相对路径（/ 分隔），须位于 报价/ 区且真实存在；可空 */
  file_path?: string
}

/** 编辑请求：quotation_no = 记录单号（查重主键，必填）；total_amount/quote_ext 不在 API 面 */
export interface QuoteUpdateRequest {
  quotation_no: string
  /** 未传保留原值 */
  date?: string
  customer?: string
  /** 明细行变更（status='已确认' 时拒绝——明细锁定，须先转修订中） */
  lines?: QuoteLine[]
  notes?: string
  file_path?: string
}
