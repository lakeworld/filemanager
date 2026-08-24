// —— 双端共享类型（P2：收敛到 src/shared/types.ts，本文件 re-export）——
export type {
  ApiResult,
  WorkspaceInfo,
  NamingTemplate,
  NamingField,
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
  BatchTagRequest,
  BatchTagResult,
  ArchiveCompressRequest,
  ArchiveExtractRequest,
  ArchiveProgress,
  ArchiveResult,
  ArchiveEventPayload,
  ExportEntry,
  TagInfo,
  TrashEntry,
  // —— v2.4.7：客户 / 发票 / 入库 / 交换区 ——
  CustomerInfo,
  CustomerExtraInfo,
  CustomerCreateRequest,
  CustomerUpdateRequest,
  // —— v2.4.9 S2：供应商 ——
  SupplierInfo,
  SupplierExtraInfo,
  SupplierCreateRequest,
  SupplierUpdateRequest,
  // —— v2.4.9 S3：报价单 ——
  QuoteRecord,
  QuoteLine,
  QuoteCreateRequest,
  QuoteUpdateRequest,
  InvoiceRecord,
  InboundRecord,
  ExchangeReceipt,
} from "../../shared/types";

// —— v2.4.7：发票 / 入库请求类型（镜像 main core 契约；shared/types.ts 仅承载持久形态）——

export type InvoiceStatus = "待报销" | "已报销" | "已入账";

export interface InvoiceCreateRequest {
  /** 发票号码（查重主键） */
  number: string;
  /** 发票代码（数电票可空） */
  code?: string;
  /** 开票日期（写入归一化 YYYY-MM-DD） */
  date: string;
  /** 金额（价税合计，元）；仅展示与页内合计 */
  amount: number;
  /** 开票方名称 */
  seller: string;
  /** 购买方抬头 */
  buyer: string;
  status: InvoiceStatus;
  /** 关联客户名 */
  customer?: string;
  /** 待办日期 */
  due_date?: string;
  /** 归档文件：工作区绝对路径或 发票/<YYYY>/ 相对路径（/ 分隔），须位于 发票/ 区且真实存在 */
  file_path: string;
  tags?: string[];
  notes?: string;
}

export interface InvoiceUpdateRequest {
  /** 原号码（记录标识，必须存在）；newNumber 省略 = 号码不变 */
  number: string;
  newNumber?: string;
  code?: string;
  date?: string;
  amount?: number;
  seller?: string;
  buyer?: string;
  status?: InvoiceStatus;
  customer?: string;
  due_date?: string;
  file_path?: string;
  tags?: string[];
  notes?: string;
}

export interface InvoiceListFilter {
  status?: InvoiceStatus;
  customer?: string;
  /** 仅待办：due_date 落在 30 天窗口内且状态 ≠ 已入账 */
  dueSoonOnly?: boolean;
  /** 号码 / 开票方 / 购买方 子串搜索 */
  query?: string;
}

export interface InboundCreateRequest {
  /** 单据编号（查重主键） */
  id: string;
  /** 入库日期（归一化 YYYY-MM-DD） */
  date: string;
  /** 供应商（自由文本，不建供应商表） */
  supplier: string;
  /** 关联供应商名（名字引用；不校验存在性——供应商删除后编辑旧入库单放行；rename 由 BoxService.renameSupplier 级联） */
  supplier_id?: string;
  /** 关联产品集名 */
  product_set?: string;
  /** 归档主体：已归档文件的绝对路径或工作区相对路径（统一存相对路径，/ 分隔） */
  file_path: string;
  /** 金额合计（仅展示） */
  amount?: number;
  notes?: string;
}

export type InboundUpdateRequest = InboundCreateRequest;

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
}

/** 孤儿未建档比对结果（v2.5.5 B3；与 main core/orphans.ts OrphanReport 结构一致，结构类型兼容）：
 *  三区（发票/入库/报价）未登记档案文件的工作区相对路径（/ 分隔）。 */
export interface OrphanReport {
  invoice: string[];
  inbound: string[];
  quote: string[];
}
