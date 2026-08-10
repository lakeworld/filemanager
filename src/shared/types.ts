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

export interface NamingTemplate {
  product_set_prefix: string
  product_set_suffix: string
  sku_separator: string
  sku_fields: string[]
  conflict_suffix: string
}

export interface WorkspaceConfig {
  name: string
  naming_template: NamingTemplate
  image_subfolders: string[]
  cert_subfolders: string[]
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
}

export interface SubfolderCreateRequest {
  product_set: string
  file_type: string
  name: string
}

export interface DeleteSubfolderRequest {
  product_set: string
  file_type: string
  name: string
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
}

export interface SearchResult {
  files: FileEntry[]
  product_sets: ProductSetInfo[]
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

export type TrashKind = 'file' | 'subfolder' | 'productSet'

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
