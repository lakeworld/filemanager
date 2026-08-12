/**
 * IPC 注册层：薄壳，只做参数透传与 ApiResult 包装（无业务逻辑）。
 * 业务全部在 core/（BoxService），保证可测性。
 *
 * v2.4.2（上线前批次一）改动：
 * - files:list 入口调用 box.beginBrowse()：作废旧文件夹积压的浏览缩略图任务（修复 2）
 * - 导入事件全部经 sendTo 守卫（R2：窗口被休眠销毁后不再抛 "Object has been destroyed" 中断导入）
 * - 导入完成事件上报 failed 明细（I1）；saveTextFile 加工作区/对话框白名单校验（S2）
 * - 路径类 handler 统一升级 isPathInsideWorkspaceReal（D7）
 * - metadata get/update 改为按文件路径（D3+D4）；startDrag 缩略图 150ms 快速命中（R6）
 */
import { ipcMain, dialog, app, BrowserWindow, clipboard as electronClipboard, nativeImage } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { BoxService } from './core'
import { AccountService } from './account'
import { copyFilesToClipboard } from './clipboard'
import { showFilesInExplorer } from './explorer'
import { workspaceFileUrl, thumbnailFileUrl } from './protocol'
import { checkUpdate, downloadUpdate, applyUpdate, getCachedUpdate, UpdateInfo } from './updater'
import { setAutoLaunch, isAutoLaunch } from './autoLaunchMain'
import { isPathInsideWorkspaceReal, classifyFileType } from './core/paths'
import { FilesService, ImportCancelledError } from './core/files'
import { ZipCancelledError, compressToZip } from './core/archive'
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

/** 与前端 types.ts 一致的响应包装（P2：类型收敛到 src/shared/types.ts） */
import type { ApiResult } from '../shared/types'

export type { ApiResult } from '../shared/types'

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

/**
 * v2.4.2（R2）：向窗口发送事件的安全通道——窗口已被休眠销毁（close → 托盘 → 30 秒 → destroy，v2.4.5 T3）
 * 时 webContents.send 会抛 "Object has been destroyed"，旧实现会让异常同步传播进导入循环、
 * 静默中断导入。此处统一守卫 + try/catch。
 */
function sendTo(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    // 发送瞬间被销毁的竞态兜底
  }
}

/** CSV 模板（对照原 csv.go） */
function csvTemplate(): string {
  return '产品集\n示例产品集\n'
}

/** v2.3.0：导入取消标记集合（渲染层 importCancel(token) 置位，importFiles 循环检测） */
const importCancelled = new Set<string>()

/**
 * v2.4.2（S2）：saveTextFile 白名单——记录最近一次系统保存对话框选出的路径，
 * 该路径（或工作区内路径）之外的写入一律拒绝。上限 20 条防无界。
 */
const recentSavePaths = new Set<string>()
function rememberSavePath(p: string): void {
  if (!p) return
  recentSavePaths.add(p)
  if (recentSavePaths.size > 20) {
    const first = recentSavePaths.values().next().value
    if (first !== undefined) recentSavePaths.delete(first)
  }
}

/**
 * v2.4.9（S4）：app 命名空间 IPC 依赖注入——index.ts 闭包态（托盘状态）经此传入，
 * 避免 ipc.ts 反向依赖 index.ts（环）。isTrayReady 供渲染层/自启态查询托盘是否已初始化。
 */
export interface AppIpcHooks {
  isTrayReady: () => boolean
}

export function registerIpc(
  box: BoxService,
  account: AccountService,
  hooks: AppIpcHooks = { isTrayReady: () => false },
): void {
  // —— 账号（v2.2.0：可选登录复用 ERP 账号；心跳统计活跃）——
  ipcMain.handle('qihebox:account:status', () => handle(() => account.status()))
  ipcMain.handle('qihebox:account:login', (_e, email: string, password: string) =>
    handle(() => account.login(email, password)),
  )
  ipcMain.handle('qihebox:account:logout', () => handle(() => account.logout()))

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

  // —— v2.4.7：客户（客户/ 目录 + customers.json 档案，PLAN §5）——
  ipcMain.handle('qihebox:clients:list', () => handle(() => box.clients.list()))
  ipcMain.handle('qihebox:clients:create', (_e, req) => handle(() => box.clients.create(req)))
  ipcMain.handle('qihebox:clients:update', (_e, req) => handle(() => box.clients.update(req)))
  // v2.4.9（S3b r3 P1-5）：客户改名编排——clients.rename（目录/档案）+ quotes.renameCustomer（报价台账 customer 级联）
  ipcMain.handle('qihebox:clients:rename', (_e, oldName: string, newName: string) =>
    handle(() => box.renameCustomer(oldName, newName)),
  )
  ipcMain.handle('qihebox:clients:delete', (_e, name: string) => handle(() => box.deleteCustomer(name)))
  ipcMain.handle('qihebox:clients:linkRelation', (_e, customer: string, productSet: string) =>
    handle(() => box.clients.linkRelation(customer, productSet)),
  )
  ipcMain.handle('qihebox:clients:unlinkRelation', (_e, customer: string, productSet: string) =>
    handle(() => box.clients.unlinkRelation(customer, productSet)),
  )

  // —— v2.4.9 S2：供应商（供应商/ 目录 + suppliers.json 档案，镜像客户；get 省略——list 已含全量，与客户同形态）——
  ipcMain.handle('qihebox:suppliers:list', () => handle(() => box.suppliers.list()))
  ipcMain.handle('qihebox:suppliers:create', (_e, req) => handle(() => box.suppliers.create(req)))
  ipcMain.handle('qihebox:suppliers:update', (_e, req) => handle(() => box.suppliers.update(req)))
  ipcMain.handle('qihebox:suppliers:rename', (_e, oldName: string, newName: string) =>
    handle(() => box.renameSupplier(oldName, newName)),
  )
  ipcMain.handle('qihebox:suppliers:delete', (_e, name: string) => handle(() => box.deleteSupplier(name)))
  // v2.4.9 打磨 M8：供应商关联产品集（镜像客户 linkRelation/unlinkRelation 通道）
  ipcMain.handle('qihebox:suppliers:linkRelation', (_e, supplier: string, productSet: string) =>
    handle(() => box.suppliers.linkRelation(supplier, productSet)),
  )
  ipcMain.handle('qihebox:suppliers:unlinkRelation', (_e, supplier: string, productSet: string) =>
    handle(() => box.suppliers.unlinkRelation(supplier, productSet)),
  )

  // —— v2.4.9 S3：报价单台账（报价.json + 报价/<YYYY>/ 归档；delete = removeEntry 账物分离不删文件）——
  ipcMain.handle('qihebox:quotes:list', () => handle(() => box.quotes.list()))
  ipcMain.handle('qihebox:quotes:get', (_e, quotationNo: string) => handle(() => box.quotes.get(quotationNo)))
  ipcMain.handle('qihebox:quotes:create', (_e, req) => handle(() => box.quotes.create(req)))
  ipcMain.handle('qihebox:quotes:update', (_e, req) => handle(() => box.quotes.update(req)))
  ipcMain.handle('qihebox:quotes:setStatus', (_e, quotationNo: string, status: '草稿' | '已确认' | '修订中') =>
    handle(() => box.quotes.setStatus(quotationNo, status)),
  )
  ipcMain.handle('qihebox:quotes:delete', (_e, quotationNo: string) => handle(() => box.quotes.removeEntry(quotationNo)))
  ipcMain.handle('qihebox:quotes:archiveFile', (_e, sourcePath: string, date: string) =>
    handle(() => box.quotes.archiveFile(sourcePath, date)),
  )

  // —— v2.4.7：发票台账（invoices.json，PLAN §6）——
  ipcMain.handle('qihebox:invoices:list', (_e, filter) => handle(() => box.invoices.list(filter)))
  ipcMain.handle('qihebox:invoices:checkNumber', (_e, number: string, excludeNumber?: string) =>
    handle(() => box.invoices.checkNumber(number, excludeNumber)),
  )
  ipcMain.handle('qihebox:invoices:create', (_e, req) => handle(() => box.invoices.create(req)))
  ipcMain.handle('qihebox:invoices:update', (_e, req) => handle(() => box.invoices.update(req)))
  ipcMain.handle('qihebox:invoices:setStatus', (_e, number: string, status: '待报销' | '已报销' | '已入账') =>
    handle(() => box.invoices.setStatus(number, status)),
  )
  ipcMain.handle('qihebox:invoices:remove', (_e, number: string, opts) =>
    handle(() => box.invoices.remove(number, opts)),
  )
  ipcMain.handle('qihebox:invoices:archiveFile', (_e, sourcePath: string, date: string) =>
    handle(() => box.invoices.archiveFile(sourcePath, date)),
  )
  ipcMain.handle('qihebox:invoices:exportXlsx', (_e, filePath: string, records) =>
    handle(() => box.invoices.exportXlsx(filePath, records)),
  )

  // —— v2.4.7：入库单（inbound.json，PLAN §7）——
  ipcMain.handle('qihebox:inbound:list', () => handle(() => box.inbound.list()))
  ipcMain.handle('qihebox:inbound:checkId', (_e, id: string, excludeId?: string) =>
    handle(() => box.inbound.checkId(id, excludeId)),
  )
  ipcMain.handle('qihebox:inbound:create', (_e, req) => handle(() => box.inbound.create(req)))
  ipcMain.handle('qihebox:inbound:update', (_e, id: string, req) =>
    handle(() => box.inbound.update(id, req)),
  )
  ipcMain.handle('qihebox:inbound:remove', (_e, id: string, opts) =>
    handle(() => box.inbound.remove(id, opts)),
  )
  ipcMain.handle('qihebox:inbound:archiveFile', (_e, sourcePath: string, date: string) =>
    handle(() => box.inbound.archiveFile(sourcePath, date)),
  )

  // —— 文件 ——
  ipcMain.handle('qihebox:files:list', (_e, req) =>
    handle(async () => {
      // v2.4.2（修复 2）：切文件夹 → 作废旧文件夹积压的浏览缩略图任务，新文件夹优先拿槽位
      box.beginBrowse()
      return box.files.fileList(req)
    }),
  )
  ipcMain.handle('qihebox:files:import', async (e, req) => {
    // 与原 Go goroutine 模式一致：立即返回，完成后发 import:complete 事件
    const win = BrowserWindow.fromWebContents(e.sender)
    const token: string | undefined = req?.cancelToken
    box.files
      .importFiles(req, {
        onProgress: (done, total) => sendTo(win, 'qihebox:event:import:progress', { done, total }),
        isCancelled: () => !!token && importCancelled.has(token),
      })
      .then((result) => {
        // v2.4.2（I1）：完成事件携带失败明细；单文件失败不再整批中断
        sendTo(win, 'qihebox:event:import:complete', {
          success: true,
          count: result.imported.length,
          failed: result.failed,
          cancelled: false,
          error: null,
        })
      })
      .catch((err: unknown) => {
        if (err instanceof ImportCancelledError) {
          sendTo(win, 'qihebox:event:import:complete', {
            success: false,
            count: err.imported.length,
            failed: [],
            cancelled: true,
            error: null,
          })
        } else {
          // 整批性失败（源展开错误等）：count=0 是真实值，不再误导
          sendTo(win, 'qihebox:event:import:complete', {
            success: false,
            count: 0,
            failed: [],
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
  ipcMain.handle('qihebox:files:move', (_e, req) => handle(() => box.files.moveFiles(req)))
  ipcMain.handle('qihebox:files:copyFilesToClipboard', (_e, paths: string[]) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      for (const p of paths) {
        if (!(await isPathInsideWorkspaceReal(ws, p))) throw new Error('只能复制工作区内的文件')
      }
      return copyFilesToClipboard(paths)
    }),
  )
  ipcMain.handle('qihebox:files:showFilesInExplorer', (_e, paths: string[]) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!paths || paths.length === 0) throw new Error('没有选择文件')
      for (const p of paths) {
        if (!(await isPathInsideWorkspaceReal(ws, p))) throw new Error('只能显示工作区内的文件')
      }
      return showFilesInExplorer(paths)
    }),
  )
  ipcMain.handle('qihebox:files:saveTextFile', (_e, filePath: string, content: string) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      const p = String(filePath ?? '').trim()
      if (!p) throw new Error('保存路径不能为空')
      // v2.4.2（S2）：只允许「工作区内」或「最近一次系统保存对话框选出的路径」（模板导出场景）
      const insideWs = await isPathInsideWorkspaceReal(ws, p)
      if (!insideWs && !recentSavePaths.has(p)) throw new Error('保存路径不在工作区内')
      return FilesService.writeFileUtf8(p, content)
    }),
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
      if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
      const t = classifyFileType(filePath)
      if (t !== 'image' && t !== 'pdf') return ''
      const thumb = await box.ensureThumbnailFor(filePath, 'browse')
      return thumb ? thumbnailFileUrl(thumb) : ''
    }),
  )
  // v2.4.6：图片预览降采样副本 URL（≤2048px JPEG，走 qihebox://thumb 协议与长缓存头；
  // 渲染层预览不再 <img> 直挂原图全尺寸解码）。空串表示不可用（渲染层回退原图）
  ipcMain.handle('qihebox:files:previewUrl', (_e, filePath: string) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
      if (classifyFileType(filePath) !== 'image') return ''
      const preview = await box.ensurePreviewFor(filePath)
      return preview ? thumbnailFileUrl(preview) : ''
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
        if (!(await isPathInsideWorkspaceReal(ws, p))) throw new Error('只能拖出工作区内的文件')
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('窗口不存在')
      // v2.3.0 ghost 图：首文件缩略图磁盘缓存（image/pdf 才有）作为拖拽图标，跟手看到真实图
      // v2.4.2（R6）：只做快速缓存命中判断（150ms 内拿不到直接用 logo 发起拖拽），
      // 不等生成队列/慢文件系统——拖拽即时响应，不因缩略图生成积压而「没反应」
      let icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build/logo.png'))
      const thumbReady = box
        .ensureThumbnailFor(paths[0], 'background')
        .then((thumb) => {
          if (thumb) {
            const t = nativeImage.createFromPath(thumb)
            if (!t.isEmpty()) icon = t
          }
        })
        .catch(() => {})
      await Promise.race([thumbReady, new Promise((r) => setTimeout(r, 150))])
      // 原生文件拖出（file 必填且指向首文件；files 支持多文件，多文件由系统显示叠影）
      win.webContents.startDrag({ file: paths[0], files: paths, icon })
    }),
  )
  ipcMain.handle('qihebox:files:workspaceUrl', (_e, filePath: string) =>
    handle(() => box.files.resolveWorkspaceFile(filePath).then(() => workspaceFileUrl(filePath))),
  )
  ipcMain.handle('qihebox:files:openWithDefaultApp', (_e, filePath: string) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能打开工作区内的文件')
      return openFileWithDefaultApp(filePath)
    }),
  )

  // —— 元数据 ——
  // v2.4.2（D3+D4）：按文件绝对路径读写（key 含子文件夹、跨平台分隔符统一）
  ipcMain.handle('qihebox:metadata:get', (_e, filePath: string) =>
    handle(() => box.metadata.get(String(filePath ?? ''))),
  )
  ipcMain.handle('qihebox:metadata:update', (_e, req) => handle(() => box.metadata.update(req)))
  // v2.4.4（T4）：批量打标（一次加载 + 一次落盘）
  ipcMain.handle('qihebox:metadata:batchTag', (_e, req) => handle(() => box.metadata.setTagsBatch(req)))

  // —— v2.4.4：压缩分享 / 解压（进度事件 + 取消令牌，与导入同机制）——
  const archiveCancelled = new Set<string>()
  ipcMain.handle('qihebox:archive:compress', async (e, req) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const token: string | undefined = req?.cancelToken
    box.archive
      .compress(req, {
        onProgress: (done, total, current) =>
          sendTo(win, 'qihebox:event:archive:progress', { phase: 'compress', done, total, current }),
        isCancelled: () => !!token && archiveCancelled.has(token),
      })
      .then((result) => {
        sendTo(win, 'qihebox:event:archive:complete', { success: true, cancelled: false, error: null, result })
      })
      .catch((err: unknown) => {
        sendTo(win, 'qihebox:event:archive:complete', {
          success: false,
          cancelled: err instanceof ZipCancelledError,
          error: err instanceof Error ? err.message : String(err),
          result: null,
        })
      })
      .finally(() => {
        if (token) archiveCancelled.delete(token)
      })
    return ok<never[]>([])
  })
  ipcMain.handle('qihebox:archive:extract', async (e, req) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const token: string | undefined = req?.cancelToken
    box.archive
      .extract(req, {
        onProgress: (done, total, current) =>
          sendTo(win, 'qihebox:event:archive:progress', { phase: 'extract', done, total, current }),
        isCancelled: () => !!token && archiveCancelled.has(token),
      })
      .then((result) => {
        sendTo(win, 'qihebox:event:archive:complete', { success: true, cancelled: false, error: null, result })
      })
      .catch((err: unknown) => {
        sendTo(win, 'qihebox:event:archive:complete', {
          success: false,
          cancelled: err instanceof ZipCancelledError,
          error: err instanceof Error ? err.message : String(err),
          result: null,
        })
      })
      .finally(() => {
        if (token) archiveCancelled.delete(token)
      })
    return ok<never[]>([])
  })
  ipcMain.handle('qihebox:archive:cancel', (_e, token: string) => {
    if (token) archiveCancelled.add(token)
    return ok<boolean>(true)
  })

  // —— v2.4.4：视频帧缩略图（渲染层抓帧 → 主进程落盘 / 缓存命中直取 URL）——
  ipcMain.handle('qihebox:files:videoThumbnail', (_e, filePath: string) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
      const thumb = await box.videoThumbnail(filePath)
      return thumb ? thumbnailFileUrl(thumb) : ''
    }),
  )
  ipcMain.handle('qihebox:files:saveVideoFrame', (_e, filePath: string, buf: ArrayBuffer) =>
    handle(async () => {
      const ws = box.workspace.currentWorkspacePath()
      if (!ws) throw new Error('未打开工作区')
      if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
      if (classifyFileType(filePath) !== 'video') throw new Error('非视频文件')
      const data = Buffer.from(buf ?? new ArrayBuffer(0))
      if (data.length === 0 || data.length > 512 * 1024) throw new Error('帧数据无效或过大（>512KB）')
      const thumb = await box.saveVideoFrame(filePath, data)
      return thumb ? thumbnailFileUrl(thumb) : ''
    }),
  )

  // —— 仪表盘 / 搜索 ——
  ipcMain.handle('qihebox:dashboard:stats', () => handle(() => box.dashboard.dashboardStats()))
  ipcMain.handle('qihebox:dashboard:expiringCerts', () => handle(() => box.dashboard.checkExpiringCerts()))
  // v2.4.7（§4.3）：发票待办（30 天内 due_date 且状态 ≠ 已入账，due_date 升序）——对齐 R1 契约
  ipcMain.handle('qihebox:dashboard:invoiceTodos', () => handle(() => box.dashboard.invoiceTodos()))
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
  // v2.4.8：导出区产物列表（工作区/导出/）
  ipcMain.handle('qihebox:exports:list', () => handle(() => box.archive.listExports()))
  ipcMain.handle('qihebox:trash:restore', (_e, id: string) => handle(() => box.trash.restore(id)))
  ipcMain.handle('qihebox:trash:purge', (_e, id: string) => handle(() => box.trash.purge(id)))
  ipcMain.handle('qihebox:trash:empty', () => handle(() => box.trash.empty()))

  // —— XLSX ——
  ipcMain.handle('qihebox:xlsx:exportTemplate', (_e, p: string) => handle(() => box.xlsxExportTemplate(p)))
  ipcMain.handle('qihebox:xlsx:import', (_e, p: string) => handle(() => box.xlsxImport(p)))

  // —— 对话框 ——
  ipcMain.handle('qihebox:dialog:openDirectory', (_e, title: string) =>
    handle(async () => {
      const win = getMainWindow()
      const opts: Electron.OpenDialogOptions = {
        title: title || '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || r.filePaths.length === 0) return ''
      return r.filePaths[0]
    }),
  )
  ipcMain.handle('qihebox:dialog:openFile', (_e, title: string, filters: unknown[]) =>
    handle(async () => {
      const win = getMainWindow()
      const opts: Electron.OpenDialogOptions = {
        title: title || '选择文件',
        filters: filters as Electron.FileFilter[],
        properties: ['openFile'],
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || r.filePaths.length === 0) return ''
      return r.filePaths[0]
    }),
  )
  ipcMain.handle('qihebox:dialog:saveFile', (_e, title: string, defaultFilename: string) =>
    handle(async () => {
      const win = getMainWindow()
      const opts: Electron.SaveDialogOptions = {
        title: title || '保存文件',
        defaultPath: defaultFilename || undefined,
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return ''
      // v2.4.2（S2）：记录用户显式选出的保存路径（saveTextFile 白名单）
      rememberSavePath(r.filePath)
      return r.filePath
    }),
  )

  // —— v2.4.9（S6-2）：日志（「我的」页日志卡片；导出 zip；2026-08-12 用户反馈不再需要打开日志目录）——
  // 只收集 main-YYYY-MM-DD.log（与 core FileLogger 同口径，不碰目录内其他文件）
  const LOG_FILE_RE = /^main-(\d{4}-\d{2}-\d{2})\.log$/
  ipcMain.handle('qihebox:log:exportZip', () =>
    handle(async () => {
      const logDir = app.getPath('logs')
      let names: string[]
      try {
        names = await fsp.readdir(logDir)
      } catch {
        throw new Error('没有可导出的日志')
      }
      const logs = names.filter((n) => LOG_FILE_RE.test(n)).map((n) => path.join(logDir, n))
      if (logs.length === 0) throw new Error('没有可导出的日志')
      // 本地日期命名默认包名（如 qihebox-logs-2026-08-12.zip）
      const pad = (n: number) => String(n).padStart(2, '0')
      const now = new Date()
      const defaultName = `qihebox-logs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`
      const opts: Electron.SaveDialogOptions = {
        title: '导出日志',
        defaultPath: defaultName,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      }
      const win = getMainWindow()
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { path: '', count: 0, size: 0 } // 用户取消：渲染层不提示错误
      // 复用 core archive.compressToZip（v2.4.4 先例，node zlib 打包，零新增依赖）
      const { count, size } = await compressToZip(logs, r.filePath)
      return { path: r.filePath, count, size }
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

  // —— v2.4.9（S4）：开机自启（平台薄壳在 autoLaunchMain.ts；Linux .desktop / Win·mac 系统登录项）——
  ipcMain.handle('qihebox:app:setAutoLaunch', (_e, enabled: boolean) =>
    handle(() => {
      setAutoLaunch(!!enabled)
      return true
    }),
  )
  ipcMain.handle('qihebox:app:isAutoLaunch', () => handle(() => isAutoLaunch()))
  // r3 P1-2 定稿：tray 为 index.ts 闭包变量、e2e/渲染层无法直接访问——查询 IPC 返回 tray !== null
  ipcMain.handle('qihebox:app:isTrayReady', () => ok(hooks.isTrayReady()))

  // —— 更新（占位）——
  ipcMain.handle('qihebox:updater:check', () => handle(() => checkUpdate(app.getVersion())))
  // v2.4.7（评审 P1）：查询主进程缓存的更新可用状态（Profile 懒加载错过 update:available 事件时兜底）
  ipcMain.handle('qihebox:updater:state', () => ok(getCachedUpdate()))
  ipcMain.handle('qihebox:updater:download', (_e, info: UpdateInfo) => handle(() => downloadUpdate(info)))
  ipcMain.handle('qihebox:updater:apply', (_e, installerPath: string, checksum: string) =>
    handle(() => applyUpdate(installerPath, checksum)),
  )
}
