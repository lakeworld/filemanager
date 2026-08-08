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

export interface FileEntry {
  name: string
  path: string
  size: number
  modified: string
  file_type: string
  thumbnail_path: string
}

export interface FileListRequest {
  product_set: string
  file_type: string
  sub_folder: string
}

export interface ImportFileRequest {
  source_paths: string[]
  target_product_set: string
  target_folder: string
  target_type: string
  sub_folder: string
}

export interface FileRenameRequest {
  path: string
  newName: string
}

export interface SubfolderCreateRequest {
  product_set: string
  file_type: string
  name: string
}

export interface DeleteSubfolderRequest {
  product_set: string
  file_type: string
  name: string
}

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

interface FileWithTime {
  entry: FileEntry
  mod: number
}

export class FilesService {
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
    private thumbs: ThumbnailProvider,
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

  private async listDirFiles(dir: string): Promise<FileEntry[]> {
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
  async importFiles(req: ImportFileRequest): Promise<FileEntry[]> {
    const ws = this.requireWS()
    if (!req.source_paths || req.source_paths.length === 0) throw new Error('没有选择文件')
    const cfg = await this.loadConfig(ws)
    const targetDir = this.targetDir(req)
    await fsp.mkdir(targetDir, { recursive: true })

    const imported: FileEntry[] = []
    for (const src of req.source_paths) {
      imported.push(await this.importOneFile(src, targetDir, req, cfg))
    }
    return imported
  }

  private async importOneFile(
    srcPath: string,
    targetDir: string,
    req: ImportFileRequest,
    cfg: WorkspaceConfig,
  ): Promise<FileEntry> {
    let p = srcPath.trim()
    if (!p) throw new Error('源路径为空')
    // 兼容 file:// 前缀（对照原 Go：先剥 file://，再剥 file:///）
    p = p.replace(/^file:\/\//, '').replace(/^file:\/\/\//, '')
    p = path.normalize(p)
    const srcInfo = await fsp.stat(p)
    if (srcInfo.isDirectory()) throw new Error(`不支持导入目录: ${p}`)

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

  // —— FileDelete ——
  async fileDelete(paths: string[]): Promise<void> {
    const ws = this.requireWS()
    for (const p of paths) {
      if (!isPathInsideWorkspace(ws, p)) throw new Error('只能删除工作区内的文件')
      await fsp.rm(p, { force: true }).catch(() => {})
      await this.thumbs.removeThumbnail(p)
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
    if (req.file_type === 'cert') {
      cfg.cert_subfolders.push(name)
    } else {
      cfg.image_subfolders.push(name)
    }
    await this.workspace.saveConfig(ws, cfg)
  }

  async deleteSubfolder(req: DeleteSubfolderRequest): Promise<void> {
    const ws = this.requireWS()
    req.product_set = req.product_set.trim()
    req.name = req.name.trim()
    if (!req.product_set || !req.name) throw new Error('产品集和子文件夹名称不能为空')
    const dir =
      req.file_type === 'image'
        ? path.join(ws, PRODUCT_SETS_DIR, req.product_set, IMAGES_DIR, req.name)
        : path.join(ws, PRODUCT_SETS_DIR, req.product_set, CERTS_DIR, req.name)
    if (!(await fsp.stat(dir).then(() => true).catch(() => false))) throw new Error('子文件夹不存在')
    // 清理元数据与缩略图（仅该子文件夹内文件）
    await this.thumbs.removeThumbnailsInDir(dir)
    await fsp.rm(dir, { recursive: true, force: true })
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
