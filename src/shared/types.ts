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
  product_set: string
  file_name: string
  cert_type?: string
  expiry_date?: string
  tags?: string[]
  notes?: string
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
