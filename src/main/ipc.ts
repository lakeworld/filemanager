/**
 * IPC 注册层：薄壳，只做参数透传与 ApiResult 包装（无业务逻辑）。
 * 业务全部在 core/（BoxService），保证可测性。
 */
import { ipcMain, dialog, app, BrowserWindow, clipboard as electronClipboard, nativeImage } from 'electron'
import path from 'node:path'
import { BoxService } from './core'
import { AccountService } from './account'
import { copyFilesToClipboard } from './clipboard'
import { showFilesInExplorer } from './explorer'
import { workspaceFileUrl, thumbnailFileUrl } from './protocol'
import { checkUpdate, downloadUpdate, applyUpdate, UpdateInfo } from './updater'
import { isPathInsideWorkspace, classifyFileType } from './core/paths'
import { FilesService, ImportCancelledError } from './core/files'
import { openFileWithDefaultApp } from './open'
import {
  getMainWindow,
  windowHideToTray,
  windowShow,
  windowMinimize,
  windowToggleMaximize,
  windowIsMaximised,
  windowQuit,
  windowGetSize,
  windowSetSize,
  windowGetPosition,
  windowSetPosition,
} from './window'

/** 与前端 types.ts 一致的响应包装 */
export interface ApiResult<T> {
  success: boolean
  data: T | null
  error: string | null
}

function ok<T>(data: T): ApiResult<T> {
  return { success: true, data, error: null }
}

function fail<T>(err: unknown): ApiResult<T> {
  return { success: false, data: null, error: err instanceof Error ? err.message : String(err) }
}

async function handle<T>(fn: () => Promise<T> | T): Promise<ApiResult<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    return fail<T>(err)
  }
}

/** CSV 模板（对照原 csv.go） */
function csvTemplate(): string {
  return '产品集\n示例产品集\n'
}

/** v2.3.0：导入取消标记集合（渲染层 importCancel(token) 置位，importFiles 循环检测） */
const importCancelled = new Set<string>()

export function registerIpc(box: BoxService, account: AccountService): void {
  // —— 账号（v2.2.0：可选登录复用 ERP 账号，解锁 AI；心跳统计活跃）——
  ipcMain.handle('qihebox:account:status', () => handle(() => account.status()))
  ipcMain.handle('qihebox:account:login', (_e, email: string, password: string) =>
    handle(() => account.login(email, password)),
  )
  ipcMain.handle('qihebox:account:logout', () => handle(() => account.logout()))
  ipcMain.handle('qihebox:ai:call', (_e, action: string, payload: unknown) =>
    handle(() => account.aiCall(action as Parameters<AccountService['aiCall']>[0], payload)),
  )

  // —— 工作区 / 配置 / 产品集 ——
  ipcMain.handle('qihebox:workspace:list', () => handle(() => box.workspace.list()))
  ipcMain.handle('qihebox:workspace:current', () => handle(() => box.workspace.current()))
  ipcMain.handle('qihebox:workspace:create', (_e, p: string) => handle(() => box.workspace.create(p)))
  ipcMain.handle('qihebox:workspace:open', (_e, p: string) => handle(() => box.workspace.open(p)))
  ipcMain.handle('qihebox:workspace:switch', (_e, p: string) => handle(() => box.workspace.switchTo(p)))
  ipcMain.handle('qihebox:workspace:renameSubfolder', (_e, type: 'image' | 'cert', oldName: string, newName: string) =>
    handle(() => box.workspace.renameSubfolder(type, oldName, newName)),
  )

  ipcMain.handle('qihebox:config:get', () => handle(() => box.workspace.getConfig()))
  ipcMain.handle('qihebox:config:update', (_e, cfg) => handle(() => box.workspace.updateConfig(cfg)))

  ipcMain.handle('qihebox:productSets:list', () => handle(() => box.workspace.productSetList()))
  ipcMain.handle('qihebox:productSets:create', (_e, req) => handle(() => box.workspace.productSetCreate(req)))
  ipcMain.handle('qihebox:productSets:delete', (_e, name: string) => handle(() => box.deleteProductSet(name)))
  ipcMain.handle('qihebox:productSets:stats', (_e, name: string) => handle(() => box.workspace.productSetStats(name)))
  ipcMain.handle('qihebox:productSets:rename', (_e, oldName: string, newName: string) =>
    handle(() => box.workspace.renameProductSet(oldName, newName)),
  )
  ipcMain.handle('qihebox:productSets:updateInfo', (_e, req) => handle(() => box.workspace.updateProductSetInfo(req)))

  // —— 文件 ——
  ipcMain.handle('qihebox:files:list', (_e, req) => handle(() => box.files.fileList(req)))
  ipcMain.handle('qihebox:files:import', async (e, req) => {
    // 与原 Go goroutine 模式一致：立即返回，完成后发 import:complete 事件
    const win = BrowserWindow.fromWebContents(e.sender)
    const token: string | undefined = req?.cancelToken
    box.files
      .importFiles(req, {
        onProgress: (done, total) => {
          win?.webContents.send('qihebox:event:import:progress', { done, total })
        },
        isCancelled: () => !!token && importCancelled.has(token),
      })
      .then((imported) => {
        win?.webContents.send('qihebox:event:import:complete', {
          success: true,
          count: imported.length,
          cancelled: false,
          error: null,
        })
      })
      .catch((err: unknown) => {
        if (err instanceof ImportCancelledError) {
          win?.webContents.send('qihebox:event:import:complete', {
            success: false,
            count: err.imported.length,
            cancelled: true,
            error: null,
          })
        } else {
          win?.webContents.send('qihebox:event:import:complete', {
            success: false,
            count: 0,
            cancelled: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
      .finally(() => {
        if (token) {
          importCancelled.delete(token)
        }
      })
    return ok<never[]>([])
  })
  // v2.3.0：取消导入（置位取消标记，importFiles 循环内检测中断；已复制文件保留）
  ipcMain.handle('qihebox:files:importCancel', (_e, token: string) => {
    if (token) importCancelled.add(token)
    return ok<boolean>(true)
  })
  ipcMain.handle('qihebox:files:delete', (_e, paths: string[]) => handle(() => box.files.fileDelete(paths)))
  ipcMain.handle('qihebox:files:rename', (_e, req) => handle(() => box.files.renameFile(req)))
  ipcMain.handle('qihebox:files:copyFilesToClipboard', (_e, paths: string[]) =>
    handle(() => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      for (const p of paths) {
        if (!isPathInsideWorkspace(ws, p)) throw new Error('只能复制工作区内的文件')
      }
      return copyFilesToClipboard(paths)
    }),
  )
  ipcMain.handle('qihebox:files:showFilesInExplorer', (_e, paths: string[]) =>
    handle(() => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      for (const p of paths) {
        if (!isPathInsideWorkspace(ws, p)) throw new Error('只能显示工作区内的文件')
      }
      return showFilesInExplorer(paths)
    }),
  )
  ipcMain.handle('qihebox:files:saveTextFile', (_e, filePath: string, content: string) =>
    handle(() => FilesService.writeFileUtf8(filePath, content)),
  )
  ipcMain.handle('qihebox:files:createSubfolder', (_e, req) => handle(() => box.files.createSubfolder(req)))
  ipcMain.handle('qihebox:files:deleteSubfolder', (_e, req) => handle(() => box.files.deleteSubfolder(req)))
  ipcMain.handle('qihebox:files:dataUrl', (_e, filePath: string) => handle(() => box.files.getFileDataUrl(filePath)))
  ipcMain.handle('qihebox:files:ensureThumbnail', (_e, filePath: string) =>
    handle(() => box.ensureThumbnailFor(filePath)),
  )
  // v2.1.0：一次 IPC 返回可直接加载的缩略图 URL（内部 ensureThumbnail + qihebox://thumb/），
  // 渲染层无需两次往返，且缩略图缓存位于 userData（不进坚果云同步）
  ipcMain.handle('qihebox:files:thumbnailUrl', (_e, filePath: string) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!isPathInsideWorkspace(ws, filePath)) throw new Error('只能访问工作区内的文件')
      const t = classifyFileType(filePath)
      if (t !== 'image' && t !== 'pdf') return ''
      const thumb = await box.ensureThumbnailFor(filePath)
      return thumb ? thumbnailFileUrl(thumb) : ''
    }),
  )
  ipcMain.handle('qihebox:files:copyPaths', (_e, paths: string[]) =>
    handle(() => {
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      electronClipboard.writeText(paths.join('\n'))
    }),
  )
  ipcMain.handle('qihebox:files:startDrag', async (e, paths: string[]) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      for (const p of paths) {
        if (!isPathInsideWorkspace(ws, p)) throw new Error('只能拖出工作区内的文件')
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('窗口不存在')
      // v2.3.0 ghost 图：首文件缩略图磁盘缓存（image/pdf 才有）作为拖拽图标，跟手看到真实图
      let icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build/logo.png'))
      try {
        const thumb = await box.ensureThumbnailFor(paths[0])
        if (thumb) {
          const t = nativeImage.createFromPath(thumb)
          if (!t.isEmpty()) icon = t
        }
      } catch {
        // 缩略图获取失败兜底 logo
      }
      // 原生文件拖出（files 支持多文件，覆盖 file 字段；多文件由系统显示叠影）
      win.webContents.startDrag({ files: paths, icon })
    }),
  )
  ipcMain.handle('qihebox:files:workspaceUrl', (_e, filePath: string) =>
    handle(() => box.files.resolveWorkspaceFile(filePath).then(() => workspaceFileUrl(filePath))),
  )
  ipcMain.handle('qihebox:files:openWithDefaultApp', (_e, filePath: string) =>
    handle(() => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!isPathInsideWorkspace(ws, filePath)) throw new Error('只能打开工作区内的文件')
      return openFileWithDefaultApp(filePath)
    }),
  )

  // —— 元数据 ——
  ipcMain.handle('qihebox:metadata:get', (_e, productSet: string, fileName: string) =>
    handle(() => box.metadata.get(productSet, fileName)),
  )
  ipcMain.handle('qihebox:metadata:update', (_e, req) => handle(() => box.metadata.update(req)))

  // —— 仪表盘 / 搜索 ——
  ipcMain.handle('qihebox:dashboard:stats', () => handle(() => box.dashboard.dashboardStats()))
  ipcMain.handle('qihebox:dashboard:expiringCerts', () => handle(() => box.dashboard.checkExpiringCerts()))
  ipcMain.handle('qihebox:search', (_e, query: string) => handle(() => box.search.search(query)))
  ipcMain.handle('qihebox:csvTemplate', () => handle(() => csvTemplate()))

  // —— 标签 ——
  ipcMain.handle('qihebox:tags:list', () => handle(() => box.tags.list()))
  ipcMain.handle('qihebox:tags:create', (_e, name: string, color: string, parentName: string | null) =>
    handle(() => box.tags.create(name, color, parentName)),
  )
  ipcMain.handle('qihebox:tags:setParent', (_e, name: string, parentName: string | null) =>
    handle(() => box.tags.setParent(name, parentName)),
  )
  ipcMain.handle('qihebox:tags:setColor', (_e, name: string, color: string) =>
    handle(() => box.tags.setColor(name, color)),
  )
  ipcMain.handle('qihebox:tags:rename', (_e, oldName: string, newName: string) =>
    handle(() => box.tags.rename(oldName, newName)),
  )
  ipcMain.handle('qihebox:tags:delete', (_e, name: string) => handle(() => box.tags.delete(name)))
  ipcMain.handle('qihebox:tags:adopt', (_e, name: string, color: string) =>
    handle(() => box.tags.adopt(name, color)),
  )

  // —— 回收站（v2.3.1）——
  ipcMain.handle('qihebox:trash:list', () => handle(() => box.trash.list()))
  ipcMain.handle('qihebox:trash:restore', (_e, id: string) => handle(() => box.trash.restore(id)))
  ipcMain.handle('qihebox:trash:purge', (_e, id: string) => handle(() => box.trash.purge(id)))
  ipcMain.handle('qihebox:trash:empty', () => handle(() => box.trash.empty()))

  // —— XLSX ——
  ipcMain.handle('qihebox:xlsx:exportTemplate', (_e, p: string) => handle(() => box.xlsxExportTemplate(p)))
  ipcMain.handle('qihebox:xlsx:import', (_e, p: string) => handle(() => box.xlsxImport(p)))

  // —— 对话框 ——
  ipcMain.handle('qihebox:dialog:openDirectory', (_e, title: string) =>
    handle(async () => {
      const r = await dialog.showOpenDialog(getMainWindow() ?? undefined, {
        title: title || '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || r.filePaths.length === 0) return ''
      return r.filePaths[0]
    }),
  )
  ipcMain.handle('qihebox:dialog:openFile', (_e, title: string, filters: unknown[]) =>
    handle(async () => {
      const r = await dialog.showOpenDialog(getMainWindow() ?? undefined, {
        title: title || '选择文件',
        filters: filters as Electron.FileFilter[],
        properties: ['openFile'],
      })
      if (r.canceled || r.filePaths.length === 0) return ''
      return r.filePaths[0]
    }),
  )
  ipcMain.handle('qihebox:dialog:saveFile', (_e, title: string, defaultFilename: string) =>
    handle(async () => {
      const r = await dialog.showSaveDialog(getMainWindow() ?? undefined, {
        title: title || '保存文件',
        defaultPath: defaultFilename || undefined,
      })
      if (r.canceled || !r.filePath) return ''
      return r.filePath
    }),
  )

  // —— 窗口 ——
  ipcMain.handle('qihebox:window:hideToTray', () => {
    windowHideToTray()
    return ok(true)
  })
  ipcMain.handle('qihebox:window:show', () => {
    windowShow()
    return ok(true)
  })
  ipcMain.handle('qihebox:window:minimize', () => {
    windowMinimize()
    return ok(true)
  })
  ipcMain.handle('qihebox:window:toggleMaximize', () => {
    windowToggleMaximize()
    return ok(true)
  })
  ipcMain.handle('qihebox:window:isMaximised', () => ok(windowIsMaximised()))
  ipcMain.handle('qihebox:window:quit', () => {
    windowQuit()
    return ok(true)
  })
  ipcMain.handle('qihebox:window:getSize', () => ok(windowGetSize()))
  ipcMain.handle('qihebox:window:setSize', (_e, w: number, h: number) => {
    windowSetSize(w, h)
    return ok(true)
  })
  ipcMain.handle('qihebox:window:getPosition', () => ok(windowGetPosition()))
  ipcMain.handle('qihebox:window:setPosition', (_e, x: number, y: number) => {
    windowSetPosition(x, y)
    return ok(true)
  })

  // —— 应用信息 ——
  ipcMain.handle('qihebox:app:version', () => app.getVersion())

  // —— 更新（占位）——
  ipcMain.handle('qihebox:updater:check', () => handle(() => checkUpdate(app.getVersion())))
  ipcMain.handle('qihebox:updater:download', (_e, info: UpdateInfo) => handle(() => downloadUpdate(info)))
  ipcMain.handle('qihebox:updater:apply', (_e, installerPath: string, checksum: string) =>
    handle(() => applyUpdate(installerPath, checksum)),
  )
}
