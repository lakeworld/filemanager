export interface ApiResult<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  created_at: string;
}

export interface NamingTemplate {
  product_set_prefix: string;
  product_set_suffix: string;
  sku_separator: string;
  sku_fields: string[];
  conflict_suffix: string;
}

export interface WorkspaceConfig {
  name: string;
  naming_template: NamingTemplate;
  image_subfolders: string[];
  cert_subfolders: string[];
}

export interface ProductSetInfo {
  name: string;
  image_count: number;
  cert_count: number;
  created_at: string;
  tags: string[];
  notes: string;
}

export interface ProductSetCreateRequest {
  name: string;
  tags: string[];
  notes: string;
}

export interface ProductSetUpdateRequest {
  name: string;
  tags: string[];
  notes: string;
}

export interface ProductSetStats {
  image_count: number;
  cert_count: number;
  created_at: string;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  modified: string;
  file_type: string;
  thumbnail_path: string | null;
}

export interface FileMetadata {
  cert_type: string;
  expiry_date: string;
  tags: string[];
  notes: string;
  added_at: string;
}

export interface DashboardStats {
  total_product_sets: number;
  total_images: number;
  total_certs: number;
  expiring_certs: number;
  recent_files: FileEntry[];
}

export interface SearchResult {
  files: FileEntry[];
  product_sets: ProductSetInfo[];
}

export interface ImportFileRequest {
  source_paths: string[];
  target_product_set: string;
  target_folder: string;
  target_type: string;
  sub_folder: string;
  /** v2.3.0：批量导入取消标记（GlobalDropOverlay 生成，主进程轮询检测） */
  cancelToken?: string;
}

export interface FileListRequest {
  product_set: string;
  file_type: string;
  sub_folder: string;
}

export interface MetadataUpdateRequest {
  product_set: string;
  file_name: string;
  cert_type: string;
  expiry_date: string;
  tags: string[];
  notes: string;
}

export interface SubfolderCreateRequest {
  product_set: string;
  file_type: string;
  name: string;
}

export interface DeleteSubfolderRequest {
  product_set: string;
  file_type: "image" | "cert";
  name: string;
}

export interface FileRenameRequest {
  path: string;
  newName: string;
}

/** v2.3.x：文件移动请求（与主进程 MoveFilesRequest 对应） */
export interface MoveFilesRequest {
  paths: string[];
  /** 目标绝对目录（与结构化目标二选一，保留兼容） */
  targetDir?: string;
  /** 结构化目标：产品集名（由后端拼路径，产品集名含特殊字符也安全） */
  target_product_set?: string;
  /** 结构化目标：image → 图包，cert → 证书 */
  target_type?: "image" | "cert";
  /** 结构化目标：子文件夹 */
  sub_folder?: string;
}

export interface TagInfo {
  name: string;
  color: string;
  count: number;
  /** 父标签名（子标签）或 null（顶层标签） */
  parent: string | null;
  /** 子标签名列表（仅顶层标签有） */
  children: string[];
  /** 固定色预设标签（颜色不可改） */
  builtin: boolean;
  /** v2.3.0：是否已定义；false = 被引用但 tags.json 无定义的「孤儿标签」 */
  defined?: boolean;
}

/** v2.3.1：回收站条目 */
export interface TrashEntry {
  id: string;
  /** 删除前的原始绝对路径 */
  originalPath: string;
  deletedAt: string;
  kind: "file" | "subfolder" | "productSet";
  name: string;
  size: number;
}

export interface LicenseInfo {
  license: string;
  email: string;
  type: string;
  activated_at: string;
  fingerprint: string;
  is_trial: boolean;
  trial_expired: boolean;
  expires_at: string;
  days_left: number;
}

export interface LicenseStatus {
  activated: boolean;
  info: LicenseInfo;
}

export interface LicenseActivateRequest {
  license: string;
  email: string;
  code: string;
}

export interface UpdateInfo {
  version: string;
  download_url: string;
  checksum: string;
  release_notes: string;
}

// —— v2.2.0：账号 + AI ——

export interface AccountStatus {
  loggedIn: boolean;
  email: string;
  sessionExpired: boolean;
  remaining: number | null;
}

export type AiAction = "rename" | "tag" | "cert" | "search";

export interface AiRenameSuggestion {
  original: string;
  suggested: string;
  note?: string;
}

export interface AiTagSuggestion {
  file: string;
  tags: string[];
}

export interface AiCertInfo {
  name: string;
  number: string;
  issuer: string;
  valid_from: string;
  valid_to: string;
}

export interface AiSearchFilters {
  type?: string;
  recent_days?: number;
  product_set?: string;
  tags?: string[];
  subfolder?: string;
  file_type_ext?: string;
}

export interface AiSearchResult {
  keywords: string[];
  filters: AiSearchFilters;
}
