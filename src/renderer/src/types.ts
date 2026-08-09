// —— 双端共享类型（P2：收敛到 src/shared/types.ts，本文件 re-export）——
export type {
  ApiResult,
  WorkspaceInfo,
  NamingTemplate,
  WorkspaceConfig,
  ProductSetInfo,
  ProductSetCreateRequest,
  ProductSetUpdateRequest,
  ProductSetStats,
  FileEntry,
  FileMetadata,
  DashboardStats,
  SearchResult,
  ImportFileRequest,
  FileListRequest,
  MetadataUpdateRequest,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
  FileRenameRequest,
  MoveFilesRequest,
  BatchMoveResult,
  DeleteResult,
  TagInfo,
  TrashEntry,
} from "../../shared/types";

// —— 渲染进程独有类型（账号 / AI / 许可 / 更新）——

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
