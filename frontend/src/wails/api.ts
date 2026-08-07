import {
  WorkspaceList,
  WorkspaceCurrent,
  WorkspaceCreate,
  WorkspaceOpen,
  WorkspaceSwitch,
  GetWorkspaceConfig,
  UpdateWorkspaceConfig,
  ProductSetList,
  ProductSetCreate,
  ProductSetDelete,
  ProductSetStats,
  UpdateProductSetInfo,
  FileList,
  FileImport,
  FileDelete,
  FileRename,
  CopyFilesToClipboard,
  ShowFilesInExplorer,
  SaveTextFile,
  CreateSubfolder,
  DeleteSubfolder,
  MetadataGet,
  MetadataUpdate,
  DashboardStats,
  CheckExpiringCerts,
  Search,
  RenameProductSet,
  CsvTemplate,
  ExportXlsxTemplate,
  ImportProductSetsFromXlsx,
  GetFileDataUrl,
  GetWorkspaceFileUrl,
  OpenFileWithDefaultApp,
  OpenDirectoryDialog,
  OpenFileDialog,
  SaveFileDialog,
  WindowHideToTray,
  WindowShow,
  WindowMinimize,
  WindowToggleMaximize,
  WindowIsMaximised,
  WindowQuit,
  GetAppVersion,
  CheckUpdate,
  DownloadUpdate,
  ApplyUpdate,
  LicenseCheck,
  LicenseRequestCode,
  LicenseActivate,
  LicenseLogout,
  LicenseInfo as GetLicenseInfo,
} from "~/wailsjs/go/main/App";
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
  LicenseStatus,
  LicenseActivateRequest,
  LicenseInfo,
  UpdateInfo,
  ApiResult,
} from "~/types";

export const api = {
  workspace: {
    list: () => WorkspaceList() as Promise<ApiResult<WorkspaceInfo[]>>,
    current: () => WorkspaceCurrent() as Promise<ApiResult<WorkspaceInfo | null>>,
    create: (path: string) => WorkspaceCreate(path) as Promise<ApiResult<WorkspaceInfo>>,
    open: (path: string) => WorkspaceOpen(path) as Promise<ApiResult<WorkspaceInfo>>,
    switch: (path: string) => WorkspaceSwitch(path) as Promise<ApiResult<WorkspaceInfo>>,
  },
  config: {
    get: () => GetWorkspaceConfig() as Promise<ApiResult<WorkspaceConfig>>,
    update: (config: WorkspaceConfig) =>
      UpdateWorkspaceConfig(config as any) as Promise<ApiResult<WorkspaceConfig>>,
  },
  productSets: {
    list: () => ProductSetList() as Promise<ApiResult<ProductSetInfo[]>>,
    create: (req: ProductSetCreateRequest) => ProductSetCreate(req as any) as Promise<ApiResult<ProductSetInfo>>,
    delete: (name: string) => ProductSetDelete(name) as Promise<ApiResult<boolean>>,
    stats: (name: string) => ProductSetStats(name) as Promise<ApiResult<ProductSetStatsType>>,
    rename: (oldName: string, newName: string) => RenameProductSet(oldName, newName) as Promise<ApiResult<boolean>>,
    updateInfo: (req: ProductSetUpdateRequest) => UpdateProductSetInfo(req as any) as Promise<ApiResult<boolean>>,
  },
  files: {
    list: (req: FileListRequest) => FileList(req as any) as Promise<ApiResult<FileEntry[]>>,
    import: (req: ImportFileRequest) => FileImport(req as any) as Promise<ApiResult<FileEntry[]>>,
    delete: (paths: string[]) => FileDelete(paths) as Promise<ApiResult<boolean>>,
    rename: (req: FileRenameRequest) => FileRename(req as any) as Promise<ApiResult<boolean>>,
    copyFilesToClipboard: (paths: string[]) =>
      CopyFilesToClipboard(paths) as Promise<ApiResult<boolean>>,
    showFilesInExplorer: (paths: string[]) =>
      ShowFilesInExplorer(paths) as Promise<ApiResult<boolean>>,
    saveTextFile: (path: string, content: string) => SaveTextFile(path, content) as Promise<ApiResult<boolean>>,
    createSubfolder: (req: SubfolderCreateRequest) =>
      CreateSubfolder(req as any) as Promise<ApiResult<boolean>>,
    deleteSubfolder: (req: DeleteSubfolderRequest) =>
      DeleteSubfolder(req as any) as Promise<ApiResult<boolean>>,
    dataUrl: (path: string) => GetFileDataUrl(path) as Promise<ApiResult<string>>,
    workspaceUrl: (path: string) => GetWorkspaceFileUrl(path) as Promise<ApiResult<string>>,
    openWithDefaultApp: (path: string) => OpenFileWithDefaultApp(path) as Promise<ApiResult<boolean>>,
  },
  metadata: {
    get: (productSet: string, fileName: string) =>
      MetadataGet(productSet, fileName) as Promise<ApiResult<FileMetadata>>,
    update: (req: MetadataUpdateRequest) =>
      MetadataUpdate(req as any) as Promise<ApiResult<boolean>>,
  },
  dashboard: {
    stats: () => DashboardStats() as Promise<ApiResult<DashboardStatsType>>,
    expiringCerts: () => CheckExpiringCerts() as Promise<ApiResult<[string, string, string][]>>,
  },
  search: (query: string) => Search(query) as Promise<ApiResult<SearchResult>>,
  csvTemplate: () => CsvTemplate() as Promise<ApiResult<string>>,
  xlsx: {
    exportTemplate: (path: string) => ExportXlsxTemplate(path) as Promise<ApiResult<boolean>>,
    import: (path: string) => ImportProductSetsFromXlsx(path) as Promise<ApiResult<ProductSetInfo[]>>,
  },
  dialog: {
    openDirectory: async (title: string) => {
      const result = (await OpenDirectoryDialog(title)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
    openFile: async (title: string, filters: any[]) => {
      const result = (await OpenFileDialog(title, filters as any)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
    saveFile: async (title: string, defaultFilename: string) => {
      const result = (await SaveFileDialog(title, defaultFilename)) as ApiResult<string>;
      return result.success ? result.data : undefined;
    },
  },
  window: {
    hideToTray: () => WindowHideToTray(),
    show: () => WindowShow(),
    minimize: () => WindowMinimize(),
    toggleMaximize: () => WindowToggleMaximize(),
    isMaximised: () => WindowIsMaximised() as Promise<boolean>,
    quit: () => WindowQuit(),
  },
  app: {
    version: () => GetAppVersion() as Promise<string>,
  },
  license: {
    check: () => LicenseCheck() as Promise<ApiResult<LicenseStatus>>,
    requestCode: (email: string, key: string) =>
      LicenseRequestCode(email, key) as Promise<ApiResult<boolean>>,
    activate: (req: LicenseActivateRequest) =>
      LicenseActivate(req as any) as Promise<ApiResult<LicenseStatus>>,
    logout: () => LicenseLogout() as Promise<ApiResult<boolean>>,
    info: () => GetLicenseInfo() as Promise<ApiResult<LicenseInfo>>,
  },
  updater: {
    check: () => CheckUpdate() as Promise<ApiResult<UpdateInfo | null>>,
    download: (info: UpdateInfo) =>
      DownloadUpdate(info as any) as Promise<ApiResult<string>>,
    apply: (installerPath: string, checksum: string) =>
      ApplyUpdate(installerPath, checksum) as Promise<ApiResult<boolean>>,
  },
};
