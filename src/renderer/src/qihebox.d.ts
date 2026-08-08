/**
 * window.qihebox 类型声明（由 preload contextBridge 暴露）
 */
interface QiheboxApi {
  workspace: {
    list: () => Promise<unknown>
    current: () => Promise<unknown>
    create: (path: string) => Promise<unknown>
    open: (path: string) => Promise<unknown>
    switch: (path: string) => Promise<unknown>
  }
  config: {
    get: () => Promise<unknown>
    update: (config: unknown) => Promise<unknown>
  }
  productSets: {
    list: () => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    delete: (name: string) => Promise<unknown>
    stats: (name: string) => Promise<unknown>
    rename: (oldName: string, newName: string) => Promise<unknown>
    updateInfo: (req: unknown) => Promise<unknown>
  }
  files: {
    list: (req: unknown) => Promise<unknown>
    import: (req: unknown) => Promise<unknown>
    delete: (paths: string[]) => Promise<unknown>
    rename: (req: unknown) => Promise<unknown>
    copyFilesToClipboard: (paths: string[]) => Promise<unknown>
    showFilesInExplorer: (paths: string[]) => Promise<unknown>
    saveTextFile: (filePath: string, content: string) => Promise<unknown>
    createSubfolder: (req: unknown) => Promise<unknown>
    deleteSubfolder: (req: unknown) => Promise<unknown>
    dataUrl: (filePath: string) => Promise<unknown>
    workspaceUrl: (filePath: string) => Promise<unknown>
    openWithDefaultApp: (filePath: string) => Promise<unknown>
  }
  metadata: {
    get: (productSet: string, fileName: string) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
  }
  dashboard: {
    stats: () => Promise<unknown>
    expiringCerts: () => Promise<unknown>
  }
  search: (query: string) => Promise<unknown>
  csvTemplate: () => Promise<unknown>
  xlsx: {
    exportTemplate: (path: string) => Promise<unknown>
    import: (path: string) => Promise<unknown>
  }
  dialog: {
    openDirectory: (title: string) => Promise<unknown>
    openFile: (title: string, filters: unknown[]) => Promise<unknown>
    saveFile: (title: string, defaultFilename: string) => Promise<unknown>
  }
  window: {
    hideToTray: () => Promise<unknown>
    show: () => Promise<unknown>
    minimize: () => Promise<unknown>
    toggleMaximize: () => Promise<unknown>
    isMaximised: () => Promise<unknown>
    quit: () => Promise<unknown>
    getSize: () => Promise<{ w: number; h: number }>
    setSize: (w: number, h: number) => Promise<unknown>
    getPosition: () => Promise<{ x: number; y: number }>
    setPosition: (x: number, y: number) => Promise<unknown>
  }
  app: {
    version: () => Promise<unknown>
  }
  events: {
    on: (channel: string, callback: (data: unknown) => void) => () => void
  }
  updater: {
    check: () => Promise<unknown>
    download: (info: unknown) => Promise<unknown>
    apply: (installerPath: string, checksum: string) => Promise<unknown>
  }
  getPathForFile: (file: File) => string
}

declare global {
  interface Window {
    qihebox: QiheboxApi
  }
}

export {}
