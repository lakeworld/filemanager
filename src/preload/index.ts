/**
 * 预加载脚本：contextBridge 暴露 window.qihebox（白名单 API）。
 * 渲染进程不接触 Node/Electron 能力，全部经 IPC 与主进程交互。
 * 事件：events.on('import:complete', cb) → 主进程发 'qihebox:event:import:complete'
 */
import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args)

const api = {
  account: {
    status: () => invoke('qihebox:account:status'),
    login: (email: string, password: string) => invoke('qihebox:account:login', email, password),
    logout: () => invoke('qihebox:account:logout'),
  },
  ai: {
    call: (action: string, payload: unknown) => invoke('qihebox:ai:call', action, payload),
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
  files: {
    list: (req: unknown) => invoke('qihebox:files:list', req),
    import: (req: unknown) => invoke('qihebox:files:import', req),
    importCancel: (token: string) => invoke('qihebox:files:importCancel', token),
    delete: (paths: string[]) => invoke('qihebox:files:delete', paths),
    rename: (req: unknown) => invoke('qihebox:files:rename', req),
    copyFilesToClipboard: (paths: string[]) => invoke('qihebox:files:copyFilesToClipboard', paths),
    showFilesInExplorer: (paths: string[]) => invoke('qihebox:files:showFilesInExplorer', paths),
    saveTextFile: (filePath: string, content: string) =>
      invoke('qihebox:files:saveTextFile', filePath, content),
    createSubfolder: (req: unknown) => invoke('qihebox:files:createSubfolder', req),
    deleteSubfolder: (req: unknown) => invoke('qihebox:files:deleteSubfolder', req),
    dataUrl: (filePath: string) => invoke('qihebox:files:dataUrl', filePath),
    ensureThumbnail: (filePath: string) => invoke('qihebox:files:ensureThumbnail', filePath),
    thumbnailUrl: (filePath: string) => invoke('qihebox:files:thumbnailUrl', filePath),
    copyPaths: (paths: string[]) => invoke('qihebox:files:copyPaths', paths),
    startDrag: (paths: string[]) => invoke('qihebox:files:startDrag', paths),
    workspaceUrl: (filePath: string) => invoke('qihebox:files:workspaceUrl', filePath),
    openWithDefaultApp: (filePath: string) => invoke('qihebox:files:openWithDefaultApp', filePath),
  },
  metadata: {
    get: (productSet: string, fileName: string) =>
      invoke('qihebox:metadata:get', productSet, fileName),
    update: (req: unknown) => invoke('qihebox:metadata:update', req),
  },
  dashboard: {
    stats: () => invoke('qihebox:dashboard:stats'),
    expiringCerts: () => invoke('qihebox:dashboard:expiringCerts'),
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
