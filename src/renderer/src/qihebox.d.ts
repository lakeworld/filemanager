/**
 * window.qihebox 类型声明（由 preload contextBridge 暴露）
 */
interface QiheboxApi {
  account: {
    status: () => Promise<unknown>
    login: (email: string, password: string) => Promise<unknown>
    logout: () => Promise<unknown>
  }
  ai: {
    call: (action: string, payload: unknown) => Promise<unknown>
  }
  workspace: {
    list: () => Promise<unknown>
    current: () => Promise<unknown>
    create: (path: string) => Promise<unknown>
    open: (path: string) => Promise<unknown>
    switch: (path: string) => Promise<unknown>
    renameSubfolder: (type: string, oldName: string, newName: string) => Promise<unknown>
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
  // v2.4.7：客户 / 发票 / 入库（纯透传，通道 qihebox:clients:* / qihebox:invoices:* / qihebox:inbound:*）
  clients: {
    list: () => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
    rename: (oldName: string, newName: string) => Promise<unknown>
    delete: (name: string) => Promise<unknown>
    linkRelation: (customer: string, productSet: string) => Promise<unknown>
    unlinkRelation: (customer: string, productSet: string) => Promise<unknown>
  }
  invoices: {
    list: (filter?: unknown) => Promise<unknown>
    checkNumber: (number: string, excludeNumber?: string | null) => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
    setStatus: (number: string, status: string) => Promise<unknown>
    remove: (number: string, opts?: unknown) => Promise<unknown>
    archiveFile: (sourcePath: string, date: string) => Promise<unknown>
    exportXlsx: (filePath: string, records: unknown) => Promise<unknown>
  }
  inbound: {
    list: () => Promise<unknown>
    checkId: (id: string, excludeId?: string | null) => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    update: (id: string, req: unknown) => Promise<unknown>
    remove: (id: string, opts?: unknown) => Promise<unknown>
    archiveFile: (sourcePath: string, date: string) => Promise<unknown>
  }
  files: {
    list: (req: unknown) => Promise<unknown>
    import: (req: unknown) => Promise<unknown>
    importCancel: (token: string) => Promise<unknown>
    delete: (paths: string[]) => Promise<unknown>
    rename: (req: unknown) => Promise<unknown>
    move: (req: unknown) => Promise<unknown>
    copyFilesToClipboard: (paths: string[]) => Promise<unknown>
    showFilesInExplorer: (paths: string[]) => Promise<unknown>
    saveTextFile: (filePath: string, content: string) => Promise<unknown>
    createSubfolder: (req: unknown) => Promise<unknown>
    deleteSubfolder: (req: unknown) => Promise<unknown>
    dataUrl: (filePath: string) => Promise<unknown>
    ensureThumbnail: (filePath: string) => Promise<unknown>
    thumbnailUrl: (filePath: string) => Promise<unknown>
    previewUrl: (filePath: string) => Promise<unknown>
    copyPaths: (paths: string[]) => Promise<unknown>
    startDrag: (paths: string[]) => Promise<unknown>
    workspaceUrl: (filePath: string) => Promise<unknown>
    openWithDefaultApp: (filePath: string) => Promise<unknown>
    videoThumbnail: (filePath: string) => Promise<unknown>
    saveVideoFrame: (filePath: string, buf: ArrayBuffer) => Promise<unknown>
  }
  metadata: {
    get: (filePath: string) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
    batchTag: (req: unknown) => Promise<unknown>
  }
  archive: {
    compress: (req: unknown) => Promise<unknown>
    extract: (req: unknown) => Promise<unknown>
    cancel: (token: string) => Promise<unknown>
  }
  // v2.4.8：导出区（工作区/导出/ 产物列表）
  exports: {
    list: () => Promise<unknown>
  }
  dashboard: {
    stats: () => Promise<unknown>
    expiringCerts: () => Promise<unknown>
    // v2.4.7：30 天内 due_date 且状态 ≠ 已入账的发票（due_date 升序）
    invoiceTodos: () => Promise<unknown>
  }
  search: (query: string) => Promise<unknown>
  csvTemplate: () => Promise<unknown>
  tags: {
    list: () => Promise<unknown>
    create: (name: string, color: string, parentName?: string | null) => Promise<unknown>
    setParent: (name: string, parentName: string | null) => Promise<unknown>
    setColor: (name: string, color: string) => Promise<unknown>
    rename: (oldName: string, newName: string) => Promise<unknown>
    delete: (name: string) => Promise<unknown>
    adopt: (name: string, color: string) => Promise<unknown>
  }
  trash: {
    list: () => Promise<unknown>
    restore: (id: string) => Promise<unknown>
    purge: (id: string) => Promise<unknown>
    empty: () => Promise<unknown>
  }
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
    state: () => Promise<unknown>
    download: (info: unknown) => Promise<unknown>
    apply: (installerPath: string, checksum: string) => Promise<unknown>
  }
  getPathForFile: (file: File) => string
  clearCache: () => void
}

declare global {
  interface Window {
    qihebox: QiheboxApi
  }
}

export {}
