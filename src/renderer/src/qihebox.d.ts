/**
 * window.qihebox 类型声明（由 preload contextBridge 暴露）
 */
import type {
  ApiResult,
  WindowFirstFrameAckMessage,
  WindowParkedAckMessage,
  WindowPrepareHideMessage,
  WindowRestoredMessage,
} from '../../shared/types'
import type {
  CreatePrefillPayload,
  PrefillEntity,
} from './stores/createPrefillNormalize'

interface QiheboxApi {
  account: {
    status: () => Promise<unknown>
    login: (email: string, password: string) => Promise<unknown>
    logout: () => Promise<unknown>
  }
  workspace: {
    list: () => Promise<unknown>
    current: () => Promise<unknown>
    create: (path: string) => Promise<unknown>
    open: (path: string) => Promise<unknown>
    switch: (path: string) => Promise<unknown>
    // v2.5.3（P2-19）：renameSubfolder 类型收口（与 main core workspace.ts 联合一致）
    renameSubfolder: (type: "image" | "cert" | "customer" | "doc", oldName: string, newName: string) => Promise<unknown>
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
  // v2.4.9 S2：供应商（纯透传，通道 qihebox:suppliers:*）
  suppliers: {
    list: () => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
    rename: (oldName: string, newName: string) => Promise<unknown>
    delete: (name: string) => Promise<unknown>
    // v2.4.9 打磨 M8：供应商关联产品集（镜像客户通道 qihebox:clients:linkRelation/unlinkRelation）
    linkRelation: (supplier: string, productSet: string) => Promise<unknown>
    unlinkRelation: (supplier: string, productSet: string) => Promise<unknown>
  }
  // v2.4.9 S3：报价单（纯透传，通道 qihebox:quotes:*；delete = removeEntry 账物分离不删文件）
  quotes: {
    list: () => Promise<unknown>
    get: (quotationNo: string) => Promise<unknown>
    create: (req: unknown) => Promise<unknown>
    update: (req: unknown) => Promise<unknown>
    setStatus: (quotationNo: string, status: string) => Promise<unknown>
    delete: (quotationNo: string) => Promise<unknown>
    archiveFile: (sourcePath: string, date: string) => Promise<unknown>
    // v2.5.5（打磨 2）：报价文档文件夹（报价/<YYYY>/<单号>/）
    docList: (no: string, date: string) => Promise<unknown>
    docCopy: (no: string, date: string, sourcePaths: string[]) => Promise<unknown>
    docCount: (no: string, date: string) => Promise<unknown>
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
  // v2.5.5（B3，任务 D）：孤儿未建档扫描（内部业务 IPC，协议面零变更——不在 plugins-api-surface 跟踪面）
  orphans: {
    scan: () => Promise<unknown>
  }
  // v2.5.5（打磨 2）：任意目录浏览（发票批量识别选文件夹；内部业务 IPC，协议面零变更）
  dirs: {
    list: (dirPath: string) => Promise<unknown>
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
    ensureThumbnail: (filePath: string) => Promise<unknown>
    thumbnailUrl: (filePath: string) => Promise<unknown>
    previewUrl: (filePath: string) => Promise<unknown>
    // v2.5.5（打磨 2）：外部文件预览 URL（批量识别任意系统文件夹）
    externalUrl: (filePath: string) => Promise<unknown>
    copyPaths: (paths: string[]) => Promise<unknown>
    startDrag: (paths: string[]) => Promise<unknown>
    workspaceUrl: (filePath: string) => Promise<unknown>
    statPath: (filePath: string) => Promise<unknown>
    openWithDefaultApp: (filePath: string) => Promise<unknown>
    readTextFile: (filePath: string) => Promise<unknown>
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
  // v2.4.9（S6-2）：日志（「我的」页日志卡片）
  log: {
    exportZip: () => Promise<unknown>
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
    // v2.5.5（打磨 2）：多选文件对话框
    openFiles: (title: string, filters: unknown[]) => Promise<unknown>
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
  // v2.5.3 常驻轻壳：窗口生命周期（preload windowLifecycle 白名单；事件订阅返回退订函数）
  windowLifecycle: {
    parked: (generation: number) => Promise<ApiResult<boolean>>
    firstFrame: (generation: number) => Promise<ApiResult<boolean>>
    onPrepareHide: (cb: (msg: WindowPrepareHideMessage) => void) => () => void
    onRestored: (cb: (msg: WindowRestoredMessage) => void) => () => void
  }
  app: {
    version: () => Promise<unknown>
    // v2.4.9（S4）：开机自启 / 托盘状态
    setAutoLaunch: (enabled: boolean) => Promise<unknown>
    isAutoLaunch: () => Promise<unknown>
    isTrayReady: () => Promise<unknown>
  }
  // v2.5：插件宿主命名空间（纯透传；宿主返回 ApiResult 包装，渲染层 registry 直读 success/error）
  plugins: {
    list: () => Promise<unknown>
    call: (pluginId: string, action: string, payload?: unknown) => Promise<unknown>
    setEnabled: (pluginId: string, enabled: boolean) => Promise<unknown>
    install: (source: { filePath: string }) => Promise<unknown>
    uninstall: (pluginId: string) => Promise<unknown>
    on: (channel: string, cb: (data: unknown) => void) => () => void
  }
  // v2.5：开发者模式设置（侧载收紧，PLAN §3.5；返回 ApiResult<boolean> 包装）
  settings: {
    getDevMode: () => Promise<ApiResult<boolean>>
    setDevMode: (enabled: boolean) => Promise<ApiResult<boolean>>
  }
  events: {
    on: (channel: string, callback: (data: unknown) => void) => () => void
  }
  // v2.5.4：全业务新建通用预填（PLAN-v2.5.4 §3.1；纯渲染层 UI 钩子，不过 IPC、不自动建档；
  // payload 全字段可选、传啥填啥；数组 = 批量逐条确认（创建推进 / 取消清空），单批 ≤50、自然键去重）
  ui: {
    openCreatePrefill: (
      entity: PrefillEntity,
      payload: CreatePrefillPayload | CreatePrefillPayload[],
    ) => void
    // v2.5.4（弹一 C-6）：编辑预填——key = 实体自然键（customer/supplier/productSet=name、
    // quote=quotation_no、invoice=number、inbound=id）；payload = 建议改动（与 create 同 schema）；
    // 弹窗先加载原值再覆盖建议；单条制、开弹窗后清空
    openEditPrefill: (entity: PrefillEntity, key: string, payload: CreatePrefillPayload) => void
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
