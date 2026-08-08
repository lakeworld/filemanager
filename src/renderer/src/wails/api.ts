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
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
  FileRenameRequest,
  UpdateInfo,
  TagInfo,
  ApiResult,
  AccountStatus,
  AiAction,
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
      qb.account.login(email, password) as Promise<ApiResult<{ ok: boolean; error?: string; remaining?: number | null }>>,
    logout: () => qb.account.logout() as Promise<ApiResult<boolean>>,
  },
  ai: {
    call: (action: AiAction, payload: unknown) =>
      qb.ai.call(action, payload) as Promise<ApiResult<unknown>>,
  },
  workspace: {
    list: () => qb.workspace.list() as Promise<ApiResult<WorkspaceInfo[]>>,
    current: () => qb.workspace.current() as Promise<ApiResult<WorkspaceInfo | null>>,
    create: (path: string) => qb.workspace.create(path) as Promise<ApiResult<WorkspaceInfo>>,
    open: (path: string) => qb.workspace.open(path) as Promise<ApiResult<WorkspaceInfo>>,
    switch: (path: string) => qb.workspace.switch(path) as Promise<ApiResult<WorkspaceInfo>>,
    renameSubfolder: (type: "image" | "cert", oldName: string, newName: string) =>
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
  files: {
    list: (req: FileListRequest) => qb.files.list(req as any) as Promise<ApiResult<FileEntry[]>>,
    import: (req: ImportFileRequest) => qb.files.import(req as any) as Promise<ApiResult<FileEntry[]>>,
    delete: (paths: string[]) => qb.files.delete(paths) as Promise<ApiResult<boolean>>,
    rename: (req: FileRenameRequest) => qb.files.rename(req as any) as Promise<ApiResult<boolean>>,
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
    dataUrl: (path: string) => qb.files.dataUrl(path) as Promise<ApiResult<string>>,
    workspaceUrl: (path: string) => qb.files.workspaceUrl(path) as Promise<ApiResult<string>>,
    openWithDefaultApp: (path: string) =>
      qb.files.openWithDefaultApp(path) as Promise<ApiResult<boolean>>,
  },
  preview: {
    open: (filePath: string) => qb.preview.open(filePath) as Promise<ApiResult<boolean>>,
  },
  metadata: {
    get: (productSet: string, fileName: string) =>
      qb.metadata.get(productSet, fileName) as Promise<ApiResult<FileMetadata>>,
    update: (req: MetadataUpdateRequest) =>
      qb.metadata.update(req as any) as Promise<ApiResult<boolean>>,
  },
  dashboard: {
    stats: () => qb.dashboard.stats() as Promise<ApiResult<DashboardStatsType>>,
    expiringCerts: () => qb.dashboard.expiringCerts() as Promise<ApiResult<[string, string, string][]>>,
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
  },
  updater: {
    check: () => qb.updater.check() as Promise<ApiResult<UpdateInfo | null>>,
    download: (info: UpdateInfo) => qb.updater.download(info as any) as Promise<ApiResult<string>>,
    apply: (installerPath: string, checksum: string) =>
      qb.updater.apply(installerPath, checksum) as Promise<ApiResult<boolean>>,
  },
};
