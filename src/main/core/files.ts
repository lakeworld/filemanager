/**
 * 文件操作（对照原 Go files.go）
 * 纯 TS 业务层。缩略图能力通过 ThumbnailProvider 注入，便于测试时替换。
 *
 * v2.4.2（上线前批次一）改动一览：
 * - D5：fileDelete / moveFiles 部分失败聚合（{deleted,moved,failed}），不回滚、失败明细可见
 * - D6：listRaw / listDirFilesRecursive 单文件 stat 容错（同步中文件被替换不拖垮整个列表）
 * - D7：安全边界校验升级为 realpath 版（isPathInsideWorkspaceReal，防符号链接逃逸）
 * - S1：fileList / createSubfolder / deleteSubfolder 名称入参校验（防路径穿越）
 * - I1：导入逐文件容错收集失败清单，单文件失败不整批中断
 * - I2：导入互斥锁（withImportLock）+ COPYFILE_EXCL（防并发同名覆盖丢数据）
 * - I3：导入元数据批量落盘（setFileMetadataBatch，消除逐文件全量重写 metadata.json）
 * - I4：导入缩略图异步生成（不 await，不阻塞导入吞吐、不长期占满生成队列）
 * - D3+D4：元数据操作全部改为按文件路径推导 key（含子文件夹、跨平台分隔符统一）
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import {
  WorkspaceConfig,
  IMAGES_DIR,
  CERTS_DIR,
  PRODUCT_SETS_DIR,
  thumbnailPath,
  isPathInsideWorkspace,
  isPathInsideWorkspaceReal,
  assertSafePathSegment,
  assertSafeFolderName,
  assertSafeFileName,
  classifyFileType,
  productSetFromFilePath,
  filterSlice,
  readJsonFile,
  writeJsonAtomic,
  configPath,
} from './paths'
import { WorkspaceService, formatTime } from './workspace'
import { MetadataService, FileMetadata, currentTimeString } from './metadata'
import { sanitizeName, composeTargetName, resolveConflictName, ImportContext } from './naming'
import { globalWorkspaceIndex } from './indexCache'
import type { CompactItem } from './indexCache'
import type {
  FileEntry,
  FileListRequest,
  ImportFileRequest,
  ImportResult,
  FileRenameRequest,
  MoveFilesRequest,
  BatchMoveResult,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
  DeleteResult,
  FailedItem,
} from '../../shared/types'

export type {
  FileEntry,
  FileListRequest,
  ImportFileRequest,
  ImportResult,
  FileRenameRequest,
  MoveFilesRequest,
  BatchMoveResult,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
  DeleteResult,
} from '../../shared/types'

/** 缩略图能力抽象（生产用 sharp 实现，测试用假实现） */
export interface ThumbnailProvider {
  /** 返回缩略图路径；文件不存在/非图片返回空串。origin：browse=浏览请求（可作废/插队），background=导入/改名等后台任务 */
  ensureThumbnail(filePath: string, origin?: ThumbOrigin): Promise<string>
  /** 缩略图存在则返回路径，否则空串 */
  thumbnailUrl(filePath: string): Promise<string>
  /** 删除文件对应的缩略图 */
  removeThumbnail(filePath: string): Promise<void>
  /** 批量删除多个文件的缩略图（v2.4.2 D2：回收站 purge 目录类条目按原路径映射批量清理） */
  removeThumbnails(files: string[]): Promise<void>
  /** 删除目录下所有文件的缩略图 */
  removeThumbnailsInDir(dir: string): Promise<void>
  /** v2.4.2（修复 2）：作废所有排队中的浏览缩略图任务（files:list 入口调用；无此能力的实现可省略） */
  cancelPendingBrowse?(): void
  /** v2.4.4：视频帧缩略图能力（SharpThumbnailService 实现；无能力实现可省略） */
  videoThumbPath?(filePath: string): string
  saveVideoFrame?(filePath: string, data: Buffer): Promise<string>
  videoThumbnail?(filePath: string): Promise<string>
  /** v2.4.6：图片预览降采样副本（≤2048px JPEG）路径；非图片/无能力/失败返回空串 */
  ensurePreview?(filePath: string): Promise<string>
}

/** 缩略图生成请求来源（v2.4.2：队列据此区分优先级与代际作废） */
export type ThumbOrigin = 'browse' | 'background'

/** v2.3.0：导入被用户取消（携带已导入部分，供事件上报） */
export class ImportCancelledError extends Error {
  imported: FileEntry[]
  constructor(imported: FileEntry[]) {
    super('导入已取消')
    this.name = 'ImportCancelledError'
    this.imported = imported
  }
}

interface FileWithTime {
  entry: FileEntry
  mod: number
}

export class FilesService {
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
    private thumbs: ThumbnailProvider,
    private trash?: import('./trash').TrashService,
  ) {
    // v2.4.x：索引展开时的缩略图路径由 files.ts 提供（thumbnailPath 纯路径推导，无 IO；thumb 标志已过滤）
    globalWorkspaceIndex.setResolveThumb((filePath) => this.resolveThumbPath(filePath))
  }

  /** v2.4.2（I2）：导入互斥——串行化并发导入，防同名文件 TOCTOU 覆盖与 metadata 交错写 */
  private importTail: Promise<unknown> = Promise.resolve()
  private withImportLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.importTail.then(fn)
    this.importTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  private async loadConfig(ws?: string): Promise<WorkspaceConfig> {
    return this.workspace.loadConfig(ws)
  }

  private targetDir(req: ImportFileRequest): string {
    const ws = this.requireWS()
    if (req.target_type === 'image') {
      return path.join(ws, PRODUCT_SETS_DIR, req.target_product_set, IMAGES_DIR, req.sub_folder)
    }
    return path.join(ws, PRODUCT_SETS_DIR, req.target_product_set, CERTS_DIR, req.sub_folder)
  }

  /** 列出目录内非隐藏文件（工作区索引：命中即内存展开，零 readdir/stat；签名变化或脏标记 → 重建） */
  private listDirFiles(dir: string): Promise<FileEntry[]> {
    return globalWorkspaceIndex.query(dir, (d) => this.listRaw(d))
  }

  /**
   * 目录 → 紧凑条目（readdir + 逐文件 stat + 缩略图存在性一次判定，全部为索引构建期成本；
   * 查询命中后由索引直接内存展开，不再触发任何 IO）。
   * 目录不存在返回 []；存在但不可读抛错（与旧 listDirFilesRaw 一致）。
   * 公开：启动接线（index.ts 索引 load/validate/build）复用。
   * v2.4.2（D6）：单文件 stat 失败（同步中文件被替换/移除/坏符号链接）跳过，不拖垮整个列表。
   */
  async listRaw(dir: string): Promise<CompactItem[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      if (dir && (await fsp.stat(dir).catch(() => null)) === null) return []
      throw new Error(`无法读取目录: ${dir}`)
    }
    const items: CompactItem[] = []
    for (const e of entries) {
      if (e.isDirectory()) continue
      const name = e.name
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const info = await fsp.stat(full).catch(() => null)
      if (!info) continue
      const thumb = (await this.thumbs.thumbnailUrl(full).catch(() => '')) ? 1 : 0
      items.push([name, info.size, info.mtimeMs, classifyFileType(name), thumb])
    }
    items.sort((a, b) => b[2] - a[2])
    return items
  }

  /** 递归列出目录内所有非隐藏文件（供 dashboard/search 复用） */
  async listDirFilesRecursive(dir: string): Promise<FileEntry[]> {
    const items: FileWithTime[] = []
    const walk = async (d: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const name = e.name
        if (name.startsWith('.')) continue
        const full = path.join(d, name)
        if (e.isDirectory()) {
          await walk(full)
        } else {
          const info = await fsp.stat(full).catch(() => null)
          if (!info) continue
          const thumb = await this.thumbs.thumbnailUrl(full).catch(() => '')
          items.push({
            entry: {
              name,
              path: full,
              size: info.size,
              modified: formatTime(info.mtime),
              file_type: classifyFileType(name),
              thumbnail_path: thumb,
            },
            mod: info.mtimeMs,
          })
        }
      }
    }
    await walk(dir)
    items.sort((a, b) => b.mod - a.mod)
    return items.map((it) => it.entry)
  }

  // —— FileList ——
  async fileList(req: FileListRequest): Promise<FileEntry[]> {
    const ws = this.requireWS()
    // v2.4.2（S1）：拼路径入口做段校验，防穿越
    const ps = assertSafePathSegment(req.product_set, '产品集')
    const sub = assertSafePathSegment(req.sub_folder, '子文件夹')
    // v2.4.4（验收修复）：视频与图片同居图包目录（沿用图包子文件夹结构）；'cert' 及其余 → 证书目录
    const dir =
      req.file_type === 'image' || req.file_type === 'video'
        ? path.join(ws, PRODUCT_SETS_DIR, ps, IMAGES_DIR, sub)
        : path.join(ws, PRODUCT_SETS_DIR, ps, CERTS_DIR, sub)
    let entries = await this.listDirFiles(dir)
    // v2.4.4（验收修复）：media_type 显式过滤（图包库「图片/视频」切换）；不传则目录内全部列出（FileBrowser 语义）
    if (req.media_type) entries = entries.filter((f) => f.file_type === req.media_type)
    if (entries.length === 0) return entries
    // v2.4.4（T2）：从 metadata 内存缓存 join 标签（纯内存操作，不碰文件索引；无元数据/空标签不附加）
    const store = await this.metadata.loadMetadataStore()
    for (const f of entries) {
      const key = this.metadata.fileMetadataKey(f.path)
      const tags = key ? store.files[key]?.tags : undefined
      if (tags && tags.length > 0) f.tags = tags
    }
    return entries
  }

  // —— FileImport（完整导入，返回导入结果；异步事件由 ipc 层处理）——
  async importFiles(
    req: ImportFileRequest,
    opts?: { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean },
  ): Promise<ImportResult> {
    const ws = this.requireWS()
    if (!req.source_paths || req.source_paths.length === 0) throw new Error('没有选择文件')
    const cfg = await this.loadConfig(ws)
    const targetDir = this.targetDir(req)
    // v2.4.2（I2）：互斥锁串行化导入，返回 Promise<ImportResult>
    return this.withImportLock(async () => {
      await fsp.mkdir(targetDir, { recursive: true })

      // v2.3.3（P2）：源路径支持目录——先递归平铺展开为文件列表，再逐项导入
      // v2.4.2（I1）：展开阶段不可读的源（未水合/坏符号链接/不存在）进入失败清单，不中断整批
      const { files: sourceFiles, failed: expandFailed } = await this.expandSourcePaths(req.source_paths)
      if (sourceFiles.length === 0 && expandFailed.length === 0) throw new Error('没有可导入的文件')

      const imported: FileEntry[] = []
      const failed: FailedItem[] = [...expandFailed]
      // v2.4.2（I3）：元数据累积，循环结束一次落盘（finally 兜底取消路径）
      const metaEntries: { filePath: string; meta: FileMetadata }[] = []
      const total = sourceFiles.length
      try {
        for (let i = 0; i < total; i++) {
          // v2.3.0：支持取消（渲染层 importCancel 置位后中断抛错，已复制文件保留）
          if (opts?.isCancelled?.()) throw new ImportCancelledError(imported)
          try {
            const entry = await this.importOneFile(sourceFiles[i], targetDir, req, cfg, metaEntries)
            imported.push(entry)
          } catch (err) {
            // v2.4.2（I1）：单文件失败收集，不中断整批
            failed.push({
              path: sourceFiles[i],
              error: err instanceof Error ? err.message : String(err),
            })
          }
          // v2.4.x：导入改变目录内容 → 失效该目录的索引快照（每导入一个失效一次，取消中断后列表也保持实时）
          globalWorkspaceIndex.invalidate(targetDir)
          opts?.onProgress?.(i + 1, total)
        }
      } finally {
        // 取消/异常路径也把已完成文件的元数据落盘（已复制文件保留，元数据同样保留）
        if (metaEntries.length > 0) {
          await this.metadata.setFileMetadataBatch(metaEntries).catch((err) =>
            console.warn('[import] 元数据批量写入失败:', err),
          )
        }
      }
      return { imported, failed }
    })
  }

  /** 归一化源路径：trim + 剥 file:// 前缀 + normalize（对照原 Go：先剥 file:// 再剥 file:///） */
  private normalizeSourcePath(raw: string): string {
    const p = raw.trim()
    if (!p) return ''
    return path.normalize(p.replace(/^file:\/\//, '').replace(/^file:\/\/\//, ''))
  }

  /**
   * v2.3.3（P2）：把源路径展开为待导入文件列表。
   * 目录 → 递归收集其内所有非隐藏文件（跳过隐藏项与空目录，平铺不保留子目录结构）；
   * 普通文件 → 原样保留。进度回调的 total 以展开后的文件数为准。
   * v2.4.2（I1）：不可读/不存在的源进入 failed 清单，不中断整批。
   */
  private async expandSourcePaths(paths: string[]): Promise<{ files: string[]; failed: FailedItem[] }> {
    const files: string[] = []
    const failed: FailedItem[] = []
    const walk = async (d: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        return // 子目录不可读时跳过（与 listDirFilesRecursive 行为一致）
      }
      for (const e of entries) {
        const name = e.name
        if (name.startsWith('.')) continue // 跳过隐藏文件与隐藏目录
        const full = path.join(d, name)
        if (e.isDirectory()) {
          await walk(full)
        } else if (e.isFile()) {
          files.push(full)
        }
      }
    }
    for (const raw of paths) {
      const p = this.normalizeSourcePath(raw)
      if (!p) continue
      const info = await fsp.stat(p).catch(() => null)
      if (!info) {
        failed.push({ path: p, error: '源文件不存在或不可读' })
        continue
      }
      if (info.isDirectory()) {
        await walk(p)
      } else {
        files.push(p)
      }
    }
    return { files, failed }
  }

  private async importOneFile(
    srcPath: string,
    targetDir: string,
    req: ImportFileRequest,
    cfg: WorkspaceConfig,
    metaEntries: { filePath: string; meta: FileMetadata }[],
  ): Promise<FileEntry> {
    const p = this.normalizeSourcePath(srcPath)
    if (!p) throw new Error('源路径为空')
    const srcInfo = await fsp.stat(p)
    // 目录已在 importFiles 中展开为文件列表，此处仅保留防御（正常流程不会到达）
    if (srcInfo.isDirectory()) throw new Error(`目录应在导入前展开为文件列表: ${p}`)

    const ext = path.extname(p).toLowerCase()
    const base = sanitizeName(path.basename(p, ext))

    // 命名模板组合
    const ctx: ImportContext = { targetProductSet: req.target_product_set, subFolder: req.sub_folder }
    let candidate = composeTargetName(cfg, base, ext, ctx)

    // 冲突后缀
    const destPath = path.join(targetDir, candidate)
    if (await fsp.stat(destPath).then(() => true).catch(() => false)) {
      candidate = await resolveConflictName(targetDir, candidate, cfg.naming_template.conflict_suffix, ext)
    }

    const finalDest = path.join(targetDir, candidate)
    // v2.4.2（I2）：COPYFILE_EXCL 兜底并发同名冲突（互斥锁之外的最后防线），EEXIST 由外层收集为失败项
    await fsp.copyFile(p, finalDest, fs.constants.COPYFILE_EXCL)

    // v2.4.2（I4）：缩略图不再阻塞导入——已缓存则直接带上路径，未缓存异步触发后台生成
    let thumb = ''
    try {
      thumb = await this.thumbs.thumbnailUrl(finalDest)
    } catch {
      thumb = ''
    }
    if (!thumb) {
      void this.thumbs.ensureThumbnail(finalDest, 'background').catch(() => {})
    }

    // v2.4.2（I3）：元数据累积批量落盘；已存在元数据的同名文件（删除后重导入）在批量写入时保留原内容
    metaEntries.push({
      filePath: finalDest,
      meta: { tags: [], notes: '', added_at: currentTimeString(), cert_type: '', expiry_date: '' },
    })

    const info = await fsp.stat(finalDest)
    return {
      name: path.basename(finalDest),
      path: finalDest,
      size: info.size,
      modified: formatTime(info.mtime),
      file_type: classifyFileType(finalDest),
      thumbnail_path: thumb || null,
    }
  }

  // —— FileDelete（v2.3.1：改为移入回收站，可恢复；元数据/缩略图保留）——
  // v2.4.2（D5）：逐文件容错聚合，单个失败不中断整体
  async fileDelete(paths: string[]): Promise<DeleteResult> {
    const ws = this.requireWS()
    if (!this.trash) throw new Error('回收站服务未初始化')
    const failed: FailedItem[] = []
    let deleted = 0
    for (const raw of paths) {
      const p = raw.trim()
      if (!p) continue
      if (!(await isPathInsideWorkspaceReal(ws, p))) {
        failed.push({ path: p, error: '只能删除工作区内的文件' })
        continue
      }
      try {
        await this.trash.trashItem(ws, p, 'file')
        // v2.4.x：删除改变目录内容 → 失效所在目录的索引快照
        globalWorkspaceIndex.invalidate(path.dirname(p))
        deleted++
      } catch (err) {
        failed.push({ path: p, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { deleted, failed }
  }

  // —— CreateSubfolder / DeleteSubfolder ——
  async createSubfolder(req: SubfolderCreateRequest): Promise<void> {
    const ws = this.requireWS()
    const name = assertSafeFolderName(req.name, '子文件夹名称')
    const cfg = await this.loadConfig(ws)
    const dir =
      req.file_type === 'cert'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, name)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, name)
    if (await fsp.stat(dir).then(() => true).catch(() => false)) throw new Error('子文件夹已存在')
    await fsp.mkdir(dir, { recursive: true })
    // v2.4.x：新建子文件夹 → 失效父目录（图包/证书）与新子目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(dir))
    globalWorkspaceIndex.invalidate(dir)
    if (req.file_type === 'cert') {
      cfg.cert_subfolders.push(name)
    } else {
      cfg.image_subfolders.push(name)
    }
    await this.workspace.saveConfig(ws, cfg)
  }

  async deleteSubfolder(req: DeleteSubfolderRequest): Promise<void> {
    const ws = this.requireWS()
    if (!this.trash) throw new Error('回收站服务未初始化')
    req.product_set = assertSafePathSegment(req.product_set, '产品集')
    req.name = assertSafePathSegment(req.name, '子文件夹名称')
    const dir =
      req.file_type === 'image'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, req.name)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, req.name)
    if (!(await fsp.stat(dir).then(() => true).catch(() => false))) throw new Error('子文件夹不存在')
    // v2.3.1：移入回收站（不再直接 rm；恢复时自动把子文件夹名加回 config）
    await this.trash.trashItem(ws, dir, 'subfolder')
    // v2.4.x：删除子文件夹 → 失效父目录与被删子目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(dir))
    globalWorkspaceIndex.invalidate(dir)
    // 从 config 移除
    const cfg = await this.loadConfig(ws)
    if (req.file_type === 'image') {
      cfg.image_subfolders = filterSlice(cfg.image_subfolders, req.name)
    } else {
      cfg.cert_subfolders = filterSlice(cfg.cert_subfolders, req.name)
    }
    await this.workspace.saveConfig(ws, cfg)
  }

  // —— FileRename ——
  async renameFile(req: FileRenameRequest): Promise<void> {
    const ws = this.requireWS()
    const oldPath = req.path.trim()
    const newName = assertSafeFileName(req.newName.trim())
    if (!oldPath) throw new Error('路径不能为空')

    if (!(await isPathInsideWorkspaceReal(ws, oldPath))) throw new Error('只能重命名工作区内的文件')

    const oldName = path.basename(oldPath)
    if (oldName === newName) return

    const newPath = path.join(path.dirname(oldPath), newName)
    if (await fsp.stat(newPath).then(() => true).catch(() => false)) throw new Error('目标文件已存在')
    await fsp.stat(oldPath)
    await fsp.rename(oldPath, newPath)
    // v2.4.x：改名改变目录内容 → 失效所在目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(oldPath))

    // v2.4.2（D3+D4）：元数据迁移改为路径推导 key（含子文件夹，跨平台一致）
    const oldKey = this.metadata.fileMetadataKey(oldPath)
    if (oldKey) {
      const store = await this.metadata.loadMetadataStore()
      if (store.files[oldKey]) {
        const newKey = this.metadata.fileMetadataKey(newPath)
        if (newKey) {
          store.files[newKey] = store.files[oldKey]
          delete store.files[oldKey]
          await this.metadata.saveMetadataStore(store)
        }
      }
    }

    // 迁移缩略图
    await this.thumbs.removeThumbnail(oldPath)
    if (classifyFileType(newPath) === 'image') {
      await this.thumbs.ensureThumbnail(newPath, 'background')
    }
  }

  // —— FileMove（v2.3.2：文件移动后端全链路，面向文件，不支持目录）——
  // v2.4.2（D5）：逐文件容错聚合，返回 { moved, failed }
  async moveFiles(req: MoveFilesRequest): Promise<BatchMoveResult> {
    const ws = this.requireWS()
    if (!req.paths || req.paths.length === 0) throw new Error('没有选择文件')
    // 目标目录解析：结构化目标（产品集/类型/子文件夹）由后端拼路径，避免前端拼接风险
    const targetDir =
      req.target_product_set && req.target_type && req.sub_folder
        ? path.join(
            ws,
            PRODUCT_SETS_DIR,
            req.target_product_set,
            req.target_type === 'image' ? IMAGES_DIR : CERTS_DIR,
            req.sub_folder,
          )
        : (req.targetDir ?? '').trim()
    if (!targetDir) throw new Error('目标目录不能为空')
    if (!(await isPathInsideWorkspaceReal(ws, targetDir))) throw new Error('只能移动到工作区内的目录')

    // 目标目录：不存在则创建，已存在必须是目录
    const targetStat = await fsp.stat(targetDir).then((s) => s).catch(() => null)
    if (targetStat === null) {
      await fsp.mkdir(targetDir, { recursive: true })
    } else if (!targetStat.isDirectory()) {
      throw new Error('目标不是目录')
    }

    const cfg = await this.loadConfig(ws)
    const moved: FileEntry[] = []
    const failed: FailedItem[] = []
    for (const raw of req.paths) {
      const p = raw.trim()
      if (!p) continue
      if (!(await isPathInsideWorkspaceReal(ws, p))) {
        failed.push({ path: p, error: '只能移动工作区内的文件' })
        continue
      }
      try {
        // 同目录且同名（文件本身就在目标位置）→ 跳过
        if (path.resolve(path.join(targetDir, path.basename(p))) === path.resolve(p)) continue

        const srcInfo = await fsp.stat(p)
        if (srcInfo.isDirectory()) {
          failed.push({ path: p, error: '不支持移动目录' })
          continue
        }

        // 目标文件名：同名冲突按命名模板加 _1 序号
        const candidate = path.basename(p)
        let destName = candidate
        if (await fsp.stat(path.join(targetDir, destName)).then(() => true).catch(() => false)) {
          destName = await resolveConflictName(targetDir, destName, cfg.naming_template.conflict_suffix, path.extname(destName))
        }
        const finalDest = path.join(targetDir, destName)

        // 执行移动：同盘 rename；EXDEV 跨设备回退 copyFile + rm（源删除）
        try {
          await fsp.rename(p, finalDest)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            await fsp.copyFile(p, finalDest, fs.constants.COPYFILE_EXCL)
            await fsp.rm(p, { force: true })
          } else {
            throw err
          }
        }

        // v2.4.2（D3+D4）：元数据迁移按路径推导 key（含子文件夹），新 key 已有内容则保留
        const oldKey = this.metadata.fileMetadataKey(p)
        const newKey = this.metadata.fileMetadataKey(finalDest)
        if (oldKey && newKey && oldKey !== newKey) {
          const store = await this.metadata.loadMetadataStore()
          if (store.files[oldKey] && !store.files[newKey]) {
            store.files[newKey] = store.files[oldKey]
            delete store.files[oldKey]
            await this.metadata.saveMetadataStore(store)
          }
        }

        // 缩略图：清理旧路径，图片新路径重生
        await this.thumbs.removeThumbnail(p)
        let thumb = ''
        if (classifyFileType(finalDest) === 'image') {
          thumb = await this.thumbs.ensureThumbnail(finalDest, 'background')
        }

        const info = await fsp.stat(finalDest)
        moved.push({
          name: path.basename(finalDest),
          path: finalDest,
          size: info.size,
          modified: formatTime(info.mtime),
          file_type: classifyFileType(finalDest),
          thumbnail_path: thumb,
        })
        // v2.4.x：移动改变源/目标目录内容 → 两者索引快照都失效
        globalWorkspaceIndex.invalidate(path.dirname(p))
        globalWorkspaceIndex.invalidate(targetDir)
      } catch (err) {
        failed.push({ path: p, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { moved, failed }
  }

  // —— 初始化预热（v2.4.x：启动后异步建立工作区文件索引）——

  /**
   * 预热工作区索引：遍历各产品集 图包/证书 目录下的所有子文件夹，
   * 逐个构建快照（listRaw 构建进索引）——切换文件夹时命中索引，不再全量扫描。
   * 不可读/不存在的目录静默跳过。返回成功构建的目录数。
   */
  async warmup(): Promise<number> {
    const ws = this.requireWS()
    return globalWorkspaceIndex.build(ws, (d) => this.listRaw(d))
  }

  // —— 预览/打开辅助 ——
  /** 校验文件在工作区内并存在（供 data URL / 协议层复用） */
  async resolveWorkspaceFile(filePath: string): Promise<string> {
    const ws = this.requireWS()
    const p = filePath.trim()
    if (!p) throw new Error('路径不能为空')
    if (!(await isPathInsideWorkspaceReal(ws, p))) throw new Error('只能访问工作区内的文件')
    await fsp.stat(p)
    return p
  }

  /** 读取文件为 base64 data URL（保留兼容；新前端走协议流式，此方法保留供测试） */
  async getFileDataUrl(filePath: string): Promise<string> {
    const p = await this.resolveWorkspaceFile(filePath)
    const data = await fsp.readFile(p)
    const ext = path.extname(p).toLowerCase()
    let mime = 'application/octet-stream'
    if (['.jpg', '.jpeg'].includes(ext)) mime = 'image/jpeg'
    else if (ext === '.png') mime = 'image/png'
    else if (ext === '.gif') mime = 'image/gif'
    else if (ext === '.webp') mime = 'image/webp'
    else if (ext === '.pdf') mime = 'application/pdf'
    return `data:${mime};base64,${data.toString('base64')}`
  }

  // —— 编排辅助（供 BoxService 跨服务操作使用）——
  thumbnailPathFor(filePath: string): string {
    const ws = this.requireWS()
    return thumbnailPath(ws, filePath)
  }

  /** 索引展开时的缩略图路径：与缩略图服务同源的纯路径推导（currentThumbsRoot 注入 userData 缓存根） */
  private resolveThumbPath(filePath: string): string {
    const ws = this.requireWS()
    const root = (this.thumbs as { currentThumbsRoot?: () => string }).currentThumbsRoot?.()
    return thumbnailPath(ws, filePath, root ?? undefined)
  }

  async removeMetadataForProductSet(productSet: string): Promise<void> {
    await this.metadata.removeFileMetadataForProductSet(productSet)
  }

  /** 读取原始 JSON 文件内容（config 等；供协议层/SaveTextFile 场景） */
  static async readFileUtf8(filePath: string): Promise<string> {
    return fsp.readFile(filePath, 'utf-8')
  }

  static async writeFileUtf8(filePath: string, content: string): Promise<void> {
    await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o644 })
  }
}
