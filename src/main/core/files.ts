/**
 * 文件操作（对照原 Go files.go）
 * 纯 TS 业务层。缩略图能力通过 ThumbnailProvider 注入，便于测试时替换。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  WorkspaceConfig,
  IMAGES_DIR,
  CERTS_DIR,
  PRODUCT_SETS_DIR,
  thumbnailPath,
  isPathInsideWorkspace,
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
import { globalFileListCache } from './scanCache'
import type { FileListCache } from './scanCache'
import type {
  FileEntry,
  FileListRequest,
  ImportFileRequest,
  FileRenameRequest,
  MoveFilesRequest,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
} from '../../shared/types'

export type {
  FileEntry,
  FileListRequest,
  ImportFileRequest,
  FileRenameRequest,
  MoveFilesRequest,
  SubfolderCreateRequest,
  DeleteSubfolderRequest,
} from '../../shared/types'

/** 文件列表缓存实例（v2.4.x：目录 mtime 签名缓存，避免切换文件夹重复全量扫描；条目类型 FileEntry） */
const fileListCache = globalFileListCache as FileListCache<FileEntry>

/** 缩略图能力抽象（生产用 sharp 实现，测试用假实现） */
export interface ThumbnailProvider {
  /** 返回缩略图路径；文件不存在/非图片返回空串 */
  ensureThumbnail(filePath: string): Promise<string>
  /** 缩略图存在则返回路径，否则空串 */
  thumbnailUrl(filePath: string): Promise<string>
  /** 删除文件对应的缩略图 */
  removeThumbnail(filePath: string): Promise<void>
  /** 删除目录下所有文件的缩略图 */
  removeThumbnailsInDir(dir: string): Promise<void>
}

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
  ) {}

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

  /** 列出目录内非隐藏文件（带文件列表缓存：命中直接返回，避免重复全量扫描） */
  private listDirFiles(dir: string): Promise<FileEntry[]> {
    return fileListCache.get(dir, () => this.listDirFilesRaw(dir))
  }

  /** 目录扫描原逻辑（readdir + 逐文件 stat + 缩略图查询），供缓存构建与预热复用 */
  private async listDirFilesRaw(dir: string): Promise<FileEntry[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      if (dir && (await fsp.stat(dir).catch(() => null)) === null) return []
      throw new Error(`无法读取目录: ${dir}`)
    }
    const items: FileWithTime[] = []
    for (const e of entries) {
      if (e.isDirectory()) continue
      const name = e.name
      if (name.startsWith('.')) continue
      const info = await fsp.stat(path.join(dir, name))
      const full = path.join(dir, name)
      items.push({
        entry: {
          name,
          path: full,
          size: info.size,
          modified: formatTime(info.mtime),
          file_type: classifyFileType(name),
          thumbnail_path: await this.thumbs.thumbnailUrl(full),
        },
        mod: info.mtimeMs,
      })
    }
    items.sort((a, b) => b.mod - a.mod)
    return items.map((it) => it.entry)
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
          const info = await fsp.stat(full)
          items.push({
            entry: {
              name,
              path: full,
              size: info.size,
              modified: formatTime(info.mtime),
              file_type: classifyFileType(name),
              thumbnail_path: await this.thumbs.thumbnailUrl(full),
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
    const dir =
      req.file_type === 'image'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, req.sub_folder)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, req.sub_folder)
    return this.listDirFiles(dir)
  }

  // —— FileImport（完整导入，返回导入结果；异步事件由 ipc 层处理）——
  async importFiles(
    req: ImportFileRequest,
    opts?: { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean },
  ): Promise<FileEntry[]> {
    const ws = this.requireWS()
    if (!req.source_paths || req.source_paths.length === 0) throw new Error('没有选择文件')
    const cfg = await this.loadConfig(ws)
    const targetDir = this.targetDir(req)
    await fsp.mkdir(targetDir, { recursive: true })

    // v2.3.3（P2）：源路径支持目录——先递归平铺展开为文件列表，再逐项导入
    const sourceFiles = await this.expandSourcePaths(req.source_paths)
    if (sourceFiles.length === 0) throw new Error('没有可导入的文件')

    const imported: FileEntry[] = []
    const total = sourceFiles.length
    for (let i = 0; i < total; i++) {
      // v2.3.0：支持取消（渲染层 importCancel 置位后中断抛错，已复制文件保留）
      if (opts?.isCancelled?.()) throw new ImportCancelledError(imported)
      imported.push(await this.importOneFile(sourceFiles[i], targetDir, req, cfg))
      // v2.4.x：导入改变目录内容 → 失效文件列表缓存（每导入一个失效一次，取消中断后列表也保持实时）
      globalFileListCache.invalidate(targetDir)
      opts?.onProgress?.(i + 1, total)
    }
    return imported
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
   */
  private async expandSourcePaths(paths: string[]): Promise<string[]> {
    const out: string[] = []
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
          out.push(full)
        }
      }
    }
    for (const raw of paths) {
      const p = this.normalizeSourcePath(raw)
      if (!p) continue
      const info = await fsp.stat(p)
      if (info.isDirectory()) {
        await walk(p)
      } else {
        out.push(p)
      }
    }
    return out
  }

  private async importOneFile(
    srcPath: string,
    targetDir: string,
    req: ImportFileRequest,
    cfg: WorkspaceConfig,
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
    await fsp.copyFile(p, finalDest)

    // 缩略图
    const thumb = await this.thumbs.ensureThumbnail(finalDest)

    // 记录元数据
    const fileMeta: FileMetadata = { tags: [], notes: '', added_at: currentTimeString(), cert_type: '', expiry_date: '' }
    await this.metadata.setFileMetadata(req.target_product_set, path.basename(finalDest), fileMeta)

    const info = await fsp.stat(finalDest)
    return {
      name: path.basename(finalDest),
      path: finalDest,
      size: info.size,
      modified: formatTime(info.mtime),
      file_type: classifyFileType(finalDest),
      thumbnail_path: thumb,
    }
  }

  // —— FileDelete（v2.3.1：改为移入回收站，可恢复；元数据/缩略图保留）——
  async fileDelete(paths: string[]): Promise<void> {
    const ws = this.requireWS()
    if (!this.trash) throw new Error('回收站服务未初始化')
    for (const p of paths) {
      if (!isPathInsideWorkspace(ws, p)) throw new Error('只能删除工作区内的文件')
      await this.trash.trashItem(ws, p, 'file')
      // v2.4.x：删除改变目录内容 → 失效所在目录的文件列表缓存
      globalFileListCache.invalidate(path.dirname(p))
    }
  }

  // —— CreateSubfolder / DeleteSubfolder ——
  async createSubfolder(req: SubfolderCreateRequest): Promise<void> {
    const ws = this.requireWS()
    const name = req.name.trim()
    if (!name) throw new Error('名称不能为空')
    const cfg = await this.loadConfig(ws)
    const dir =
      req.file_type === 'cert'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, name)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, name)
    if (await fsp.stat(dir).then(() => true).catch(() => false)) throw new Error('子文件夹已存在')
    await fsp.mkdir(dir, { recursive: true })
    // v2.4.x：新建子文件夹 → 失效父目录（图包/证书）与新子目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(dir))
    globalFileListCache.invalidate(dir)
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
    req.product_set = req.product_set.trim()
    req.name = req.name.trim()
    if (!req.product_set || !req.name) throw new Error('产品集和子文件夹名称不能为空')
    const dir =
      req.file_type === 'image'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, req.name)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, req.name)
    if (!(await fsp.stat(dir).then(() => true).catch(() => false))) throw new Error('子文件夹不存在')
    // v2.3.1：移入回收站（不再直接 rm；恢复时自动把子文件夹名加回 config）
    await this.trash.trashItem(ws, dir, 'subfolder')
    // v2.4.x：删除子文件夹 → 失效父目录与被删子目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(dir))
    globalFileListCache.invalidate(dir)
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
    const newName = req.newName.trim()
    if (!oldPath || !newName) throw new Error('路径和名称不能为空')

    if (!isPathInsideWorkspace(ws, oldPath)) throw new Error('只能重命名工作区内的文件')
    if (newName.includes('/') || newName.includes('\\')) throw new Error('文件名不能包含路径分隔符')

    const oldName = path.basename(oldPath)
    if (oldName === newName) return

    const newPath = path.join(path.dirname(oldPath), newName)
    if (await fsp.stat(newPath).then(() => true).catch(() => false)) throw new Error('目标文件已存在')
    await fsp.stat(oldPath)
    await fsp.rename(oldPath, newPath)
    // v2.4.x：改名改变目录内容 → 失效所在目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(oldPath))

    // 迁移元数据（key: 产品集/文件名）
    const productSet = productSetFromFilePath(ws, oldPath)
    if (productSet) {
      const store = await this.metadata.loadMetadataStore()
      const oldKey = this.metadata.fileMetadataKey(productSet, oldName)
      if (store.files[oldKey]) {
        const newKey = this.metadata.fileMetadataKey(productSet, newName)
        store.files[newKey] = store.files[oldKey]
        delete store.files[oldKey]
        await this.metadata.saveMetadataStore(store)
      }
    }

    // 迁移缩略图
    await this.thumbs.removeThumbnail(oldPath)
    if (classifyFileType(newPath) === 'image') {
      await this.thumbs.ensureThumbnail(newPath)
    }
  }

  // —— FileMove（v2.3.2：文件移动后端全链路，面向文件，不支持目录）——
  async moveFiles(req: MoveFilesRequest): Promise<FileEntry[]> {
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
    if (!isPathInsideWorkspace(ws, targetDir)) throw new Error('只能移动到工作区内的目录')

    // 目标目录：不存在则创建，已存在必须是目录
    const targetStat = await fsp.stat(targetDir).then((s) => s).catch(() => null)
    if (targetStat === null) {
      await fsp.mkdir(targetDir, { recursive: true })
    } else if (!targetStat.isDirectory()) {
      throw new Error('目标不是目录')
    }

    const cfg = await this.loadConfig(ws)
    const moved: FileEntry[] = []
    for (const raw of req.paths) {
      const p = raw.trim()
      if (!p) continue
      if (!isPathInsideWorkspace(ws, p)) throw new Error('只能移动工作区内的文件')
      // 同目录且同名（文件本身就在目标位置）→ 跳过
      if (path.resolve(path.join(targetDir, path.basename(p))) === path.resolve(p)) continue

      const srcInfo = await fsp.stat(p)
      if (srcInfo.isDirectory()) throw new Error(`不支持移动目录: ${p}`)

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
          await fsp.copyFile(p, finalDest)
          await fsp.rm(p, { force: true })
        } else {
          throw err
        }
      }

      // 元数据迁移（key: 产品集/文件名）：key 变化时迁移，新 key 已有内容则保留
      const oldSet = productSetFromFilePath(ws, p)
      const newSet = productSetFromFilePath(ws, finalDest)
      if (oldSet && newSet) {
        const oldKey = this.metadata.fileMetadataKey(oldSet, path.basename(p))
        const newKey = this.metadata.fileMetadataKey(newSet, path.basename(finalDest))
        if (oldKey !== newKey) {
          const store = await this.metadata.loadMetadataStore()
          if (store.files[oldKey] && !store.files[newKey]) {
            store.files[newKey] = store.files[oldKey]
            delete store.files[oldKey]
            await this.metadata.saveMetadataStore(store)
          }
        }
      }

      // 缩略图：清理旧路径，图片新路径重生
      await this.thumbs.removeThumbnail(p)
      let thumb = ''
      if (classifyFileType(finalDest) === 'image') {
        thumb = await this.thumbs.ensureThumbnail(finalDest)
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
      // v2.4.x：移动改变源/目标目录内容 → 两者文件列表缓存都失效
      globalFileListCache.invalidate(path.dirname(p))
      globalFileListCache.invalidate(targetDir)
    }
    return moved
  }

  // —— 初始化预热（v2.4.x：启动后异步建立文件列表索引）——

  /**
   * 预热文件列表缓存：遍历各产品集 图包/证书 目录下的所有子文件夹，
   * 逐个预填充（构建走 listDirFilesRaw，结果进缓存）——切换文件夹时命中缓存，不再全量扫描。
   * 不可读/不存在的目录静默跳过。返回预热的目录数。
   */
  async warmup(): Promise<number> {
    const ws = this.requireWS()
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const subDirs: string[] = []
    let sets: import('node:fs').Dirent[]
    try {
      sets = await fsp.readdir(setsDir, { withFileTypes: true })
    } catch {
      return 0 // 产品集目录不存在/不可读 → 无目录可预热
    }
    for (const s of sets) {
      if (!s.isDirectory()) continue
      for (const typeDir of [IMAGES_DIR, CERTS_DIR]) {
        const typePath = path.join(setsDir, s.name, typeDir)
        const subs = await fsp.readdir(typePath, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
        for (const sub of subs) {
          if (sub.isDirectory()) subDirs.push(path.join(typePath, sub.name))
        }
      }
    }
    // 逐个预填充（get 内部构建走 listDirFilesRaw）；失败目录静默跳过
    for (const d of subDirs) {
      await fileListCache.get(d, () => this.listDirFilesRaw(d)).catch(() => [])
    }
    return subDirs.length
  }

  // —— 预览/打开辅助 ——
  /** 校验文件在工作区内并存在（供 data URL / 协议层复用） */
  async resolveWorkspaceFile(filePath: string): Promise<string> {
    const ws = this.requireWS()
    const p = filePath.trim()
    if (!p) throw new Error('路径不能为空')
    if (!isPathInsideWorkspace(ws, p)) throw new Error('只能访问工作区内的文件')
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

  async removeMetadataForProductSet(productSet: string): Promise<void> {
    await this.metadata.removeFileMetadataForProductSet(productSet)
  }

  async removeSubfolderMetadata(productSet: string, fileName: string): Promise<void> {
    await this.metadata.removeFileMetadata(productSet, fileName)
  }

  /** 读取原始 JSON 文件内容（config 等；供协议层/SaveTextFile 场景） */
  static async readFileUtf8(filePath: string): Promise<string> {
    return fsp.readFile(filePath, 'utf-8')
  }

  static async writeFileUtf8(filePath: string, content: string): Promise<void> {
    await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o644 })
  }
}
