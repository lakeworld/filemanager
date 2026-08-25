import type {
  WorkspaceInfo,
  WorkspaceConfig,
  ProductSetInfo,
  ProductSetCreateRequest,
  ProductSetUpdateRequest,
  ProductSetStats as ProductSetStatsType,
  FileEntry,
  FileMetadata,
  DashboardStats as DashboardStatsType,
  SearchResult,
  ImportFileRequest,
  FileListRequest,
  MetadataUpdateRequest,
  BatchTagRequest,
  BatchTagResult,
  ArchiveCompressRequest,
  ArchiveExtractRequest,
  ExportEntry,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
  FileRenameRequest,
  MoveFilesRequest,
  UpdateInfo,
  TagInfo,
  TrashEntry,
  ApiResult,
  AccountStatus,
  DeleteResult,
  BatchMoveResult,
  // —— v2.4.7：客户 / 发票 / 入库 ——
  CustomerInfo,
  CustomerCreateRequest,
  CustomerUpdateRequest,
  // —— v2.4.9 S2：供应商 ——
  SupplierInfo,
  SupplierExtraInfo,
  SupplierCreateRequest,
  SupplierUpdateRequest,
  // —— v2.4.9 S3：报价单 ——
  QuoteRecord,
  QuoteCreateRequest,
  QuoteUpdateRequest,
  InvoiceRecord,
  InboundRecord,
  InvoiceStatus,
  InvoiceCreateRequest,
  InvoiceUpdateRequest,
  InvoiceListFilter,
  InboundCreateRequest,
  InboundUpdateRequest,
  OrphanReport,
  DirBrowseResult,
} from "~/types";

/**
 * API 门面：Wails 绑定层已替换为 Electron IPC（window.qihebox）。
 * 命名空间结构与原 wails/api.ts 完全一致，页面调用方零改动。
 */
const qb = window.qihebox;

export const api = {
  account: {
    status: () => qb.account.status() as Promise<ApiResult<AccountStatus>>,
    login: (email: string, password: string) =>
      qb.account.login(email, password) as Promise<ApiResult<{ ok: boolean; error?: string }>>,
    logout: () => qb.account.logout() as Promise<ApiResult<boolean>>,
  },
  workspace: {
    list: () => qb.workspace.list() as Promise<ApiResult<WorkspaceInfo[]>>,
    current: () => qb.workspace.current() as Promise<ApiResult<WorkspaceInfo | null>>,
    create: (path: string) => qb.workspace.create(path) as Promise<ApiResult<WorkspaceInfo>>,
    open: (path: string) => qb.workspace.open(path) as Promise<ApiResult<WorkspaceInfo>>,
    switch: (path: string) => qb.workspace.switch(path) as Promise<ApiResult<WorkspaceInfo>>,
    // v2.5.3（P2-19）：type 收口为与 main core 一致的联合（image/cert/customer/doc）
    renameSubfolder: (type: "image" | "cert" | "customer" | "doc", oldName: string, newName: string) =>
      qb.workspace.renameSubfolder(type, oldName, newName) as Promise<ApiResult<WorkspaceConfig>>,
  },
  config: {
    get: () => qb.config.get() as Promise<ApiResult<WorkspaceConfig>>,
    update: (config: WorkspaceConfig) =>
      qb.config.update(config as any) as Promise<ApiResult<WorkspaceConfig>>,
  },
  productSets: {
    list: () => qb.productSets.list() as Promise<ApiResult<ProductSetInfo[]>>,
    create: (req: ProductSetCreateRequest) =>
      qb.productSets.create(req as any) as Promise<ApiResult<ProductSetInfo>>,
    delete: (name: string) => qb.productSets.delete(name) as Promise<ApiResult<boolean>>,
    stats: (name: string) => qb.productSets.stats(name) as Promise<ApiResult<ProductSetStatsType>>,
    rename: (oldName: string, newName: string) =>
      qb.productSets.rename(oldName, newName) as Promise<ApiResult<boolean>>,
    updateInfo: (req: ProductSetUpdateRequest) =>
      qb.productSets.updateInfo(req as any) as Promise<ApiResult<boolean>>,
  },
  // v2.4.7：客户 / 发票 / 入库（对齐 main core 服务契约；preload 命名空间纯透传）
  clients: {
    list: () => qb.clients.list() as Promise<ApiResult<CustomerInfo[]>>,
    create: (req: CustomerCreateRequest) =>
      qb.clients.create(req as any) as Promise<ApiResult<CustomerInfo>>,
    update: (req: CustomerUpdateRequest) =>
      qb.clients.update(req as any) as Promise<ApiResult<CustomerInfo>>,
    rename: (oldName: string, newName: string) =>
      qb.clients.rename(oldName, newName) as Promise<ApiResult<boolean>>,
    delete: (name: string) => qb.clients.delete(name) as Promise<ApiResult<boolean>>,
    linkRelation: (customer: string, productSet: string) =>
      qb.clients.linkRelation(customer, productSet) as Promise<ApiResult<CustomerInfo>>,
    unlinkRelation: (customer: string, productSet: string) =>
      qb.clients.unlinkRelation(customer, productSet) as Promise<ApiResult<CustomerInfo>>,
  },
  // v2.4.9 S2：供应商（对齐 main core 服务契约；preload 命名空间纯透传，list 已含全量故无 get，与客户同形态）
  suppliers: {
    list: () => qb.suppliers.list() as Promise<ApiResult<SupplierInfo[]>>,
    create: (req: SupplierCreateRequest) =>
      qb.suppliers.create(req as any) as Promise<ApiResult<SupplierInfo>>,
    update: (req: SupplierUpdateRequest) =>
      qb.suppliers.update(req as any) as Promise<ApiResult<SupplierInfo>>,
    rename: (oldName: string, newName: string) =>
      qb.suppliers.rename(oldName, newName) as Promise<ApiResult<boolean>>,
    delete: (name: string) => qb.suppliers.delete(name) as Promise<ApiResult<boolean>>,
    // v2.4.9 打磨 M8：供应商关联产品集（镜像客户门面）
    linkRelation: (supplier: string, productSet: string) =>
      qb.suppliers.linkRelation(supplier, productSet) as Promise<ApiResult<SupplierInfo>>,
    unlinkRelation: (supplier: string, productSet: string) =>
      qb.suppliers.unlinkRelation(supplier, productSet) as Promise<ApiResult<SupplierInfo>>,
  },
  // v2.4.9 S3：报价单（对齐 main core 服务契约；delete = removeEntry 账物分离不删文件）
  quotes: {
    list: () => qb.quotes.list() as Promise<ApiResult<QuoteRecord[]>>,
    get: (quotationNo: string) =>
      qb.quotes.get(quotationNo) as Promise<ApiResult<QuoteRecord | null>>,
    create: (req: QuoteCreateRequest) =>
      qb.quotes.create(req as any) as Promise<ApiResult<QuoteRecord>>,
    update: (req: QuoteUpdateRequest) =>
      qb.quotes.update(req as any) as Promise<ApiResult<QuoteRecord>>,
    setStatus: (quotationNo: string, status: QuoteRecord["status"]) =>
      qb.quotes.setStatus(quotationNo, status) as Promise<ApiResult<QuoteRecord>>,
    delete: (quotationNo: string) => qb.quotes.delete(quotationNo) as Promise<ApiResult<boolean>>,
    archiveFile: (sourcePath: string, date: string) =>
      qb.quotes.archiveFile(sourcePath, date) as Promise<ApiResult<string>>,
  },
  invoices: {
    list: (filter?: InvoiceListFilter) =>
      qb.invoices.list(filter as any) as Promise<ApiResult<InvoiceRecord[]>>,
    checkNumber: (number: string, excludeNumber?: string | null) =>
      qb.invoices.checkNumber(number, excludeNumber ?? null) as Promise<ApiResult<InvoiceRecord | null>>,
    create: (req: InvoiceCreateRequest) =>
      qb.invoices.create(req as any) as Promise<ApiResult<InvoiceRecord>>,
    update: (req: InvoiceUpdateRequest) =>
      qb.invoices.update(req as any) as Promise<ApiResult<InvoiceRecord>>,
    setStatus: (number: string, status: InvoiceStatus) =>
      qb.invoices.setStatus(number, status) as Promise<ApiResult<InvoiceRecord>>,
    remove: (number: string, opts?: { deleteFile?: boolean }) =>
      qb.invoices.remove(number, opts ?? null) as Promise<ApiResult<boolean>>,
    archiveFile: (sourcePath: string, date: string) =>
      qb.invoices.archiveFile(sourcePath, date) as Promise<ApiResult<string>>,
    exportXlsx: (filePath: string, records: InvoiceRecord[]) =>
      qb.invoices.exportXlsx(filePath, records as any) as Promise<ApiResult<boolean>>,
  },
  inbound: {
    list: () => qb.inbound.list() as Promise<ApiResult<InboundRecord[]>>,
    checkId: (id: string, excludeId?: string | null) =>
      qb.inbound.checkId(id, excludeId ?? null) as Promise<ApiResult<InboundRecord | null>>,
    create: (req: InboundCreateRequest) =>
      qb.inbound.create(req as any) as Promise<ApiResult<InboundRecord>>,
    update: (id: string, req: InboundUpdateRequest) =>
      qb.inbound.update(id, req as any) as Promise<ApiResult<InboundRecord>>,
    remove: (id: string, opts?: { deleteFile?: boolean }) =>
      qb.inbound.remove(id, opts ?? null) as Promise<ApiResult<boolean>>,
    archiveFile: (sourcePath: string, date: string) =>
      qb.inbound.archiveFile(sourcePath, date) as Promise<ApiResult<string>>,
  },
  // v2.5.5（B3，任务 D）：孤儿未建档扫描（内部业务 IPC，协议面零变更）
  orphans: {
    scan: () => qb.orphans.scan() as Promise<ApiResult<OrphanReport>>,
  },
  // v2.5.5（打磨 2）：任意目录浏览（发票批量识别选文件夹；内部业务 IPC，协议面零变更）
  dirs: {
    list: (dirPath: string) => qb.dirs.list(dirPath) as Promise<ApiResult<DirBrowseResult>>,
  },
  files: {
    list: (req: FileListRequest) => qb.files.list(req as any) as Promise<ApiResult<FileEntry[]>>,
    import: (req: ImportFileRequest) => qb.files.import(req as any) as Promise<ApiResult<FileEntry[]>>,
    importCancel: (token: string) => qb.files.importCancel(token) as Promise<ApiResult<boolean>>,
    delete: (paths: string[]) => qb.files.delete(paths) as Promise<ApiResult<DeleteResult>>,
    rename: (req: FileRenameRequest) => qb.files.rename(req as any) as Promise<ApiResult<boolean>>,
    move: (req: MoveFilesRequest) => qb.files.move(req as any) as Promise<ApiResult<BatchMoveResult>>,
    copyFilesToClipboard: (paths: string[]) =>
      qb.files.copyFilesToClipboard(paths) as Promise<ApiResult<boolean>>,
    copyPaths: (paths: string[]) => qb.files.copyPaths(paths) as Promise<ApiResult<boolean>>,
    showFilesInExplorer: (paths: string[]) =>
      qb.files.showFilesInExplorer(paths) as Promise<ApiResult<boolean>>,
    saveTextFile: (path: string, content: string) =>
      qb.files.saveTextFile(path, content) as Promise<ApiResult<boolean>>,
    createSubfolder: (req: SubfolderCreateRequest) =>
      qb.files.createSubfolder(req as any) as Promise<ApiResult<boolean>>,
    deleteSubfolder: (req: DeleteSubfolderRequest) =>
      qb.files.deleteSubfolder(req as any) as Promise<ApiResult<boolean>>,
    previewUrl: (path: string) => qb.files.previewUrl(path) as Promise<ApiResult<string>>,
    externalUrl: (path: string) => qb.files.externalUrl(path) as Promise<ApiResult<string>>,
    workspaceUrl: (path: string) => qb.files.workspaceUrl(path) as Promise<ApiResult<string>>,
    statPath: (path: string) => qb.files.statPath(path) as Promise<ApiResult<{ mtime: number }>>,
    openWithDefaultApp: (path: string) =>
      qb.files.openWithDefaultApp(path) as Promise<ApiResult<boolean>>,
    readTextFile: (path: string) => qb.files.readTextFile(path) as Promise<ApiResult<string>>,
    videoThumbnail: (path: string) =>
      qb.files.videoThumbnail(path) as Promise<ApiResult<string>>,
    saveVideoFrame: (path: string, buf: ArrayBuffer) =>
      qb.files.saveVideoFrame(path, buf) as Promise<ApiResult<string>>,
  },
  metadata: {
    get: (filePath: string) =>
      qb.metadata.get(filePath) as Promise<ApiResult<FileMetadata>>,
    update: (req: MetadataUpdateRequest) =>
      qb.metadata.update(req as any) as Promise<ApiResult<boolean>>,
    batchTag: (req: BatchTagRequest) =>
      qb.metadata.batchTag(req as any) as Promise<ApiResult<BatchTagResult>>,
  },
  archive: {
    compress: (req: ArchiveCompressRequest) =>
      qb.archive.compress(req as any) as Promise<ApiResult<unknown[]>>,
    extract: (req: ArchiveExtractRequest) =>
      qb.archive.extract(req as any) as Promise<ApiResult<unknown[]>>,
    cancel: (token: string) => qb.archive.cancel(token) as Promise<ApiResult<boolean>>,
  },
  // v2.4.8：导出区（工作区/导出/ 产物列表）
  exports: {
    list: () => qb.exports.list() as Promise<ApiResult<ExportEntry[]>>,
  },
  // v2.4.9（S6-2）：日志（「我的」页日志卡片）——导出 zip（2026-08-12 用户反馈不再需要打开日志目录）
  log: {
    exportZip: () =>
      qb.log.exportZip() as Promise<ApiResult<{ path: string; count: number; size: number }>>,
  },
  dashboard: {
    stats: () => qb.dashboard.stats() as Promise<ApiResult<DashboardStatsType>>,
    expiringCerts: () => qb.dashboard.expiringCerts() as Promise<ApiResult<[string, string, string][]>>,
    invoiceTodos: () => qb.dashboard.invoiceTodos() as Promise<ApiResult<InvoiceRecord[]>>,
  },
  search: (query: string) => qb.search(query) as Promise<ApiResult<SearchResult>>,
  csvTemplate: () => qb.csvTemplate() as Promise<ApiResult<string>>,
  tags: {
    list: () => qb.tags.list() as Promise<ApiResult<TagInfo[]>>,
    create: (name: string, color: string, parentName?: string | null) =>
      qb.tags.create(name, color, parentName ?? null) as Promise<ApiResult<boolean>>,
    setParent: (name: string, parentName: string | null) =>
      qb.tags.setParent(name, parentName) as Promise<ApiResult<boolean>>,
    setColor: (name: string, color: string) =>
      qb.tags.setColor(name, color) as Promise<ApiResult<boolean>>,
    rename: (oldName: string, newName: string) =>
      qb.tags.rename(oldName, newName) as Promise<ApiResult<boolean>>,
    delete: (name: string) => qb.tags.delete(name) as Promise<ApiResult<boolean>>,
    adopt: (name: string, color: string) => qb.tags.adopt(name, color) as Promise<ApiResult<boolean>>,
  },
  trash: {
    list: () => qb.trash.list() as Promise<ApiResult<TrashEntry[]>>,
    restore: (id: string) => qb.trash.restore(id) as Promise<ApiResult<void>>,
    purge: (id: string) => qb.trash.purge(id) as Promise<ApiResult<void>>,
    empty: () => qb.trash.empty() as Promise<ApiResult<void>>,
  },
  xlsx: {
    exportTemplate: (path: string) => qb.xlsx.exportTemplate(path) as Promise<ApiResult<boolean>>,
    import: (path: string) => qb.xlsx.import(path) as Promise<ApiResult<ProductSetInfo[]>>,
  },
  dialog: {
    openDirectory: async (title: string) => {
      const result = (await qb.dialog.openDirectory(title)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
    openFile: async (title: string, filters: any[]) => {
      const result = (await qb.dialog.openFile(title, filters as any)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
    saveFile: async (title: string, defaultFilename: string) => {
      const result = (await qb.dialog.saveFile(title, defaultFilename)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
  },
  window: {
    hideToTray: () => qb.window.hideToTray(),
    show: () => qb.window.show(),
    minimize: () => qb.window.minimize(),
    toggleMaximize: () => qb.window.toggleMaximize(),
    isMaximised: () => qb.window.isMaximised() as Promise<boolean>,
    quit: () => qb.window.quit(),
  },
  app: {
    version: () => qb.app.version() as Promise<string>,
    // v2.4.9（S4）：开机自启（Linux .desktop / Win·mac 系统登录项）/ 托盘状态
    setAutoLaunch: (enabled: boolean) => qb.app.setAutoLaunch(enabled) as Promise<ApiResult<boolean>>,
    isAutoLaunch: () => qb.app.isAutoLaunch() as Promise<ApiResult<boolean>>,
    isTrayReady: () => qb.app.isTrayReady() as Promise<ApiResult<boolean>>,
  },
  updater: {
    check: () => qb.updater.check() as Promise<ApiResult<UpdateInfo | null>>,
    // v2.4.7（评审 P1）：主进程缓存的更新可用状态（Profile 懒加载错过 update:available 事件时兜底）
    state: () => qb.updater.state() as Promise<ApiResult<UpdateInfo | null>>,
    download: (info: UpdateInfo) => qb.updater.download(info as any) as Promise<ApiResult<string>>,
    apply: (installerPath: string, checksum: string) =>
      qb.updater.apply(installerPath, checksum) as Promise<ApiResult<boolean>>,
  },
};
