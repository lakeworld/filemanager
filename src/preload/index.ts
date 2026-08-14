/**
 * 预加载脚本：contextBridge 暴露 window.qihebox（白名单 API）。
 * 渲染进程不接触 Node/Electron 能力，全部经 IPC 与主进程交互。
 * 事件：events.on('import:complete', cb) → 主进程发 'qihebox:event:import:complete'
 */
import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import type { ApiResult, PluginInfo } from '../shared/types'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args)

const api = {
  account: {
    status: () => invoke('qihebox:account:status'),
    login: (email: string, password: string) => invoke('qihebox:account:login', email, password),
    logout: () => invoke('qihebox:account:logout'),
  },
  workspace: {
    list: () => invoke('qihebox:workspace:list'),
    current: () => invoke('qihebox:workspace:current'),
    create: (path: string) => invoke('qihebox:workspace:create', path),
    open: (path: string) => invoke('qihebox:workspace:open', path),
    switch: (path: string) => invoke('qihebox:workspace:switch', path),
    renameSubfolder: (type: string, oldName: string, newName: string) =>
      invoke('qihebox:workspace:renameSubfolder', type, oldName, newName),
  },
  config: {
    get: () => invoke('qihebox:config:get'),
    update: (config: unknown) => invoke('qihebox:config:update', config),
  },
  productSets: {
    list: () => invoke('qihebox:productSets:list'),
    create: (req: unknown) => invoke('qihebox:productSets:create', req),
    delete: (name: string) => invoke('qihebox:productSets:delete', name),
    stats: (name: string) => invoke('qihebox:productSets:stats', name),
    rename: (oldName: string, newName: string) =>
      invoke('qihebox:productSets:rename', oldName, newName),
    updateInfo: (req: unknown) => invoke('qihebox:productSets:updateInfo', req),
  },
  // v2.4.7：客户 / 发票台账 / 入库单（纯透传，业务在主进程 core/）
  clients: {
    list: () => invoke('qihebox:clients:list'),
    create: (req: unknown) => invoke('qihebox:clients:create', req),
    update: (req: unknown) => invoke('qihebox:clients:update', req),
    rename: (oldName: string, newName: string) => invoke('qihebox:clients:rename', oldName, newName),
    delete: (name: string) => invoke('qihebox:clients:delete', name),
    linkRelation: (customer: string, productSet: string) =>
      invoke('qihebox:clients:linkRelation', customer, productSet),
    unlinkRelation: (customer: string, productSet: string) =>
      invoke('qihebox:clients:unlinkRelation', customer, productSet),
  },
  // v2.4.9 S2：供应商（纯透传，业务在主进程 core/）
  suppliers: {
    list: () => invoke('qihebox:suppliers:list'),
    create: (req: unknown) => invoke('qihebox:suppliers:create', req),
    update: (req: unknown) => invoke('qihebox:suppliers:update', req),
    rename: (oldName: string, newName: string) => invoke('qihebox:suppliers:rename', oldName, newName),
    delete: (name: string) => invoke('qihebox:suppliers:delete', name),
    // v2.4.9 打磨 M8：供应商关联产品集（镜像客户通道）
    linkRelation: (supplier: string, productSet: string) =>
      invoke('qihebox:suppliers:linkRelation', supplier, productSet),
    unlinkRelation: (supplier: string, productSet: string) =>
      invoke('qihebox:suppliers:unlinkRelation', supplier, productSet),
  },
  // v2.4.9 S3：报价单（纯透传，业务在主进程 core/；delete = removeEntry 账物分离不删文件）
  quotes: {
    list: () => invoke('qihebox:quotes:list'),
    get: (quotationNo: string) => invoke('qihebox:quotes:get', quotationNo),
    create: (req: unknown) => invoke('qihebox:quotes:create', req),
    update: (req: unknown) => invoke('qihebox:quotes:update', req),
    setStatus: (quotationNo: string, status: string) =>
      invoke('qihebox:quotes:setStatus', quotationNo, status),
    delete: (quotationNo: string) => invoke('qihebox:quotes:delete', quotationNo),
    archiveFile: (sourcePath: string, date: string) =>
      invoke('qihebox:quotes:archiveFile', sourcePath, date),
  },
  invoices: {
    list: (filter?: unknown) => invoke('qihebox:invoices:list', filter),
    checkNumber: (number: string, excludeNumber?: string) =>
      invoke('qihebox:invoices:checkNumber', number, excludeNumber),
    create: (req: unknown) => invoke('qihebox:invoices:create', req),
    update: (req: unknown) => invoke('qihebox:invoices:update', req),
    setStatus: (number: string, status: string) => invoke('qihebox:invoices:setStatus', number, status),
    remove: (number: string, opts?: unknown) => invoke('qihebox:invoices:remove', number, opts),
    archiveFile: (sourcePath: string, date: string) =>
      invoke('qihebox:invoices:archiveFile', sourcePath, date),
    exportXlsx: (filePath: string, records: unknown[]) =>
      invoke('qihebox:invoices:exportXlsx', filePath, records),
  },
  inbound: {
    list: () => invoke('qihebox:inbound:list'),
    checkId: (id: string, excludeId?: string) => invoke('qihebox:inbound:checkId', id, excludeId),
    create: (req: unknown) => invoke('qihebox:inbound:create', req),
    update: (id: string, req: unknown) => invoke('qihebox:inbound:update', id, req),
    remove: (id: string, opts?: unknown) => invoke('qihebox:inbound:remove', id, opts),
    archiveFile: (sourcePath: string, date: string) =>
      invoke('qihebox:inbound:archiveFile', sourcePath, date),
  },
  files: {
    list: (req: unknown) => invoke('qihebox:files:list', req),
    import: (req: unknown) => invoke('qihebox:files:import', req),
    importCancel: (token: string) => invoke('qihebox:files:importCancel', token),
    delete: (paths: string[]) => invoke('qihebox:files:delete', paths),
    rename: (req: unknown) => invoke('qihebox:files:rename', req),
    move: (req: unknown) => invoke('qihebox:files:move', req),
    copyFilesToClipboard: (paths: string[]) => invoke('qihebox:files:copyFilesToClipboard', paths),
    showFilesInExplorer: (paths: string[]) => invoke('qihebox:files:showFilesInExplorer', paths),
    saveTextFile: (filePath: string, content: string) =>
      invoke('qihebox:files:saveTextFile', filePath, content),
    createSubfolder: (req: unknown) => invoke('qihebox:files:createSubfolder', req),
    deleteSubfolder: (req: unknown) => invoke('qihebox:files:deleteSubfolder', req),
    dataUrl: (filePath: string) => invoke('qihebox:files:dataUrl', filePath),
    ensureThumbnail: (filePath: string) => invoke('qihebox:files:ensureThumbnail', filePath),
    thumbnailUrl: (filePath: string) => invoke('qihebox:files:thumbnailUrl', filePath),
    // v2.4.6：图片预览降采样副本 URL（≤2048px JPEG，主进程 sharp 生成并缓存）
    previewUrl: (filePath: string) => invoke('qihebox:files:previewUrl', filePath),
    copyPaths: (paths: string[]) => invoke('qihebox:files:copyPaths', paths),
    startDrag: (paths: string[]) => invoke('qihebox:files:startDrag', paths),
    workspaceUrl: (filePath: string) => invoke('qihebox:files:workspaceUrl', filePath),
    openWithDefaultApp: (filePath: string) => invoke('qihebox:files:openWithDefaultApp', filePath),
    // v2.4.4：视频帧缩略图（缓存命中 → URL；miss → 渲染层抓帧后 saveVideoFrame 写入）
    videoThumbnail: (filePath: string) => invoke('qihebox:files:videoThumbnail', filePath),
    saveVideoFrame: (filePath: string, buf: ArrayBuffer) =>
      invoke('qihebox:files:saveVideoFrame', filePath, buf),
  },
  metadata: {
    // v2.4.2：主进程按文件绝对路径推导元数据 key（含子文件夹），不再传 productSet/fileName
    get: (filePath: string) => invoke('qihebox:metadata:get', filePath),
    update: (req: unknown) => invoke('qihebox:metadata:update', req),
    // v2.4.4：批量打标（多选）
    batchTag: (req: unknown) => invoke('qihebox:metadata:batchTag', req),
  },
  archive: {
    // v2.4.4：压缩分享 / 解压（异步，进度经 events.on('archive:progress')，完成经 events.on('archive:complete')）
    compress: (req: unknown) => invoke('qihebox:archive:compress', req),
    extract: (req: unknown) => invoke('qihebox:archive:extract', req),
    cancel: (token: string) => invoke('qihebox:archive:cancel', token),
  },
  // v2.4.8：导出区（工作区/导出/ 压缩分享产物列表）
  exports: {
    list: () => invoke('qihebox:exports:list'),
  },
  // v2.4.9（S6-2）：日志（「我的」页日志卡片）——导出 zip（薄透传；2026-08-12 用户反馈不再需要打开日志目录）
  log: {
    exportZip: () => invoke('qihebox:log:exportZip'),
  },
  dashboard: {
    stats: () => invoke('qihebox:dashboard:stats'),
    expiringCerts: () => invoke('qihebox:dashboard:expiringCerts'),
    // v2.4.7：发票待办（30 天内 due_date 且状态 ≠ 已入账，due_date 升序）
    invoiceTodos: () => invoke('qihebox:dashboard:invoiceTodos'),
  },
  search: (query: string) => invoke('qihebox:search', query),
  csvTemplate: () => invoke('qihebox:csvTemplate'),
  tags: {
    list: () => invoke('qihebox:tags:list'),
    create: (name: string, color: string, parentName?: string | null) =>
      invoke('qihebox:tags:create', name, color, parentName ?? null),
    setParent: (name: string, parentName: string | null) =>
      invoke('qihebox:tags:setParent', name, parentName),
    setColor: (name: string, color: string) => invoke('qihebox:tags:setColor', name, color),
    rename: (oldName: string, newName: string) => invoke('qihebox:tags:rename', oldName, newName),
    delete: (name: string) => invoke('qihebox:tags:delete', name),
    adopt: (name: string, color: string) => invoke('qihebox:tags:adopt', name, color),
  },
  trash: {
    list: () => invoke('qihebox:trash:list'),
    restore: (id: string) => invoke('qihebox:trash:restore', id),
    purge: (id: string) => invoke('qihebox:trash:purge', id),
    empty: () => invoke('qihebox:trash:empty'),
  },
  xlsx: {
    exportTemplate: (path: string) => invoke('qihebox:xlsx:exportTemplate', path),
    import: (path: string) => invoke('qihebox:xlsx:import', path),
  },
  dialog: {
    openDirectory: (title: string) => invoke('qihebox:dialog:openDirectory', title),
    openFile: (title: string, filters: unknown[]) => invoke('qihebox:dialog:openFile', title, filters),
    saveFile: (title: string, defaultFilename: string) =>
      invoke('qihebox:dialog:saveFile', title, defaultFilename),
  },
  window: {
    hideToTray: () => invoke('qihebox:window:hideToTray'),
    show: () => invoke('qihebox:window:show'),
    minimize: () => invoke('qihebox:window:minimize'),
    toggleMaximize: () => invoke('qihebox:window:toggleMaximize'),
    isMaximised: async () => {
      const r = (await invoke('qihebox:window:isMaximised')) as { success: boolean; data: boolean }
      return r?.data ?? false
    },
    quit: () => invoke('qihebox:window:quit'),
    // 与 Wails runtime.WindowGetSize 一致：直接返回 {w,h}（App.tsx FramelessResizer 依赖）
    getSize: async () => {
      const r = (await invoke('qihebox:window:getSize')) as { success: boolean; data: { w: number; h: number } }
      return r?.data ?? { w: 1280, h: 900 }
    },
    setSize: (w: number, h: number) => invoke('qihebox:window:setSize', w, h),
    getPosition: async () => {
      const r = (await invoke('qihebox:window:getPosition')) as { success: boolean; data: { x: number; y: number } }
      return r?.data ?? { x: 0, y: 0 }
    },
    setPosition: (x: number, y: number) => invoke('qihebox:window:setPosition', x, y),
  },
  app: {
    version: () => invoke('qihebox:app:version'),
    // v2.4.9（S4）：开机自启 / 托盘状态（薄透传）
    setAutoLaunch: (enabled: boolean) => invoke('qihebox:app:setAutoLaunch', enabled),
    isAutoLaunch: () => invoke('qihebox:app:isAutoLaunch'),
    isTrayReady: () => invoke('qihebox:app:isTrayReady'),
  },
  // v2.5：插件宿主命名空间（PLAN §3.5 / 交叉契约）——纯透传，不 import 任何插件代码。
  // 全部经 qihebox:plugins:* 通道（宿主返回 ApiResult 包装，此处不拆包）；插件代码不进 preload bundle
  plugins: {
    /** 已安装插件清单（含禁用/broken；管理页与 Sidebar/路由/菜单注入的数据源） */
    list: (): Promise<ApiResult<PluginInfo[]>> =>
      invoke('qihebox:plugins:list') as Promise<ApiResult<PluginInfo[]>>,
    /** 调用插件 IPC：plugins.call(id, action, payload) → 宿主路由到插件注册的 action */
    call: (pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>> =>
      invoke('qihebox:plugins:call', pluginId, action, payload) as Promise<ApiResult<unknown>>,
    /** 管理页：启停（即时生效 + 持久化 userData/plugins/config.json） */
    setEnabled: (pluginId: string, enabled: boolean): Promise<ApiResult<boolean>> =>
      invoke('qihebox:plugins:setEnabled', pluginId, enabled) as Promise<ApiResult<boolean>>,
    /** 侧载安装本地 .qbox（JSON Schema + SHA-256 校验在宿主侧；需开发者模式开启，PLAN §3.5） */
    install: (source: { filePath: string }): Promise<ApiResult<PluginInfo>> =>
      invoke('qihebox:plugins:install', source) as Promise<ApiResult<PluginInfo>>,
    /** 卸载（删除 userData/plugins/<id>/ 的代码与状态，UI 明示确认后调用） */
    uninstall: (pluginId: string): Promise<ApiResult<boolean>> =>
      invoke('qihebox:plugins:uninstall', pluginId) as Promise<ApiResult<boolean>>,
    /** 订阅插件广播事件（宿主 host.events.emit → qihebox:event:<channel>），返回退订函数 */
    on: (channel: string, cb: (data: unknown) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: unknown): void => cb(data)
      ipcRenderer.on(`qihebox:event:${channel}`, listener)
      return () => {
        ipcRenderer.removeListener(`qihebox:event:${channel}`, listener)
      }
    },
  },
  // v2.5：开发者模式设置（侧载收紧，PLAN §3.5）——默认关，userData/settings.json 持久化；
  // 返回 ApiResult<boolean> 包装（对齐全仓 handle() 纪律，P1-E2）
  settings: {
    getDevMode: (): Promise<ApiResult<boolean>> =>
      invoke('qihebox:settings:getDevMode') as Promise<ApiResult<boolean>>,
    setDevMode: (enabled: boolean): Promise<ApiResult<boolean>> =>
      invoke('qihebox:settings:setDevMode', enabled) as Promise<ApiResult<boolean>>,
  },
  events: {
    /** 订阅主进程事件，返回取消订阅函数 */
    on: (channel: string, callback: (data: unknown) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on(`qihebox:event:${channel}`, listener)
      return () => {
        ipcRenderer.removeListener(`qihebox:event:${channel}`, listener)
      }
    },
  },
  updater: {
    check: () => invoke('qihebox:updater:check'),
    // v2.4.7（评审 P1）：查询主进程缓存的更新可用状态（懒加载错过事件时兜底）
    state: () => invoke('qihebox:updater:state'),
    download: (info: unknown) => invoke('qihebox:updater:download', info),
    apply: (installerPath: string, checksum: string) =>
      invoke('qihebox:updater:apply', installerPath, checksum),
  },
  /** 拖拽：从 File 对象取真实路径（替代原 Wails OnFileDrop） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** v2.2.1：清理 Blink 图像解码缓存（窗口隐藏时调用，回收内存） */
  clearCache: (): void => webFrame.clearCache(),
}

contextBridge.exposeInMainWorld('qihebox', api)

export type QiheboxApi = typeof api
