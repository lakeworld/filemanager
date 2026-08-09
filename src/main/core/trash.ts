/**
 * 回收站（v2.3.1）：删除改为移入回收站，可恢复 / 彻底删除 / 清空。
 *
 * 数据：<ws>/.qihefilemanager/trash/<entryId>/
 *   meta.json  { id, originalPath, deletedAt, kind, name, size }
 *   data/      原文件或目录内容（移动到此）
 * - 放在工作区内：工作区自包含，同盘 rename 恢复快，可手动清理
 * - 删除时**不动**元数据（metadata.json）与缩略图缓存 → 恢复后文件标签/备注/缩略图原样可用
 * - 产品集删除走回收站：productSetList 是扫描目录，目录移走即消失；extra（tags/notes）保留，
 *   恢复移回即重新出现且信息完好
 * - 彻底删除（purge）才清理元数据与缩略图
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  cmDir,
  writeJsonAtomic,
  readJsonFile,
  isPathInsideWorkspace,
  productSetFromFilePath,
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
} from './paths'
import { WorkspaceService } from './workspace'
import { MetadataService } from './metadata'
import { globalFileListCache } from './scanCache'
import type { ThumbnailProvider } from './files'
import type { TrashEntry, TrashKind } from '../../shared/types'

export type { TrashEntry, TrashKind } from '../../shared/types'

export const TRASH_DIR = 'trash'

interface TrashMeta extends TrashEntry {}

export class TrashService {
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

  private trashRoot(ws: string): string {
    return path.join(cmDir(ws), TRASH_DIR)
  }

  private entryDir(ws: string, id: string): string {
    return path.join(this.trashRoot(ws), id)
  }

  private newEntryId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** 移动文件 / 子文件夹 / 产品集目录到回收站（不清理元数据与缩略图，恢复可原样还原） */
  async trashItem(ws: string, srcPath: string, kind: TrashKind): Promise<void> {
    if (!isPathInsideWorkspace(ws, srcPath)) throw new Error('只能删除工作区内的内容')
    const id = this.newEntryId()
    const dir = this.entryDir(ws, id)
    const dataDir = path.join(dir, 'data')
    await fsp.mkdir(dir, { recursive: true })
    // 同盘 rename；跨设备（不同文件系统）回退 copy + rm
    try {
      await fsp.rename(srcPath, dataDir)
    } catch {
      await fsp.cp(srcPath, dataDir, { recursive: true, force: true })
      await fsp.rm(srcPath, { recursive: true, force: true })
    }
    const stat = await fsp.stat(dataDir)
    const meta: TrashMeta = {
      id,
      originalPath: srcPath,
      deletedAt: new Date().toISOString(),
      kind,
      name: path.basename(srcPath),
      size: stat.size,
    }
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta)
    // v2.4.x：目录内容变化（移入回收站）→ 失效源路径与其父目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(srcPath))
    globalFileListCache.invalidate(srcPath)
  }

  /** 回收站条目列表（新→旧） */
  async list(): Promise<TrashEntry[]> {
    const ws = this.requireWS()
    const root = this.trashRoot(ws)
    const ids = await fsp.readdir(root).catch(() => [] as string[])
    const out: TrashEntry[] = []
    for (const id of ids) {
      const meta = await readJsonFile<TrashMeta>(path.join(this.entryDir(ws, id), 'meta.json'))
      if (!meta) continue
      // data 已被外部清掉 → 视为无效条目跳过
      const ok = await fsp.stat(path.join(this.entryDir(ws, id), 'data')).then(() => true).catch(() => false)
      if (!ok) continue
      out.push(meta)
    }
    out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
    return out
  }

  /** 恢复：data 移回原路径（父目录重建；同名冲突自动加「-恢复N」后缀；子文件夹名加回 config） */
  async restore(id: string): Promise<void> {
    const ws = this.requireWS()
    const dir = this.entryDir(ws, id)
    const meta = await readJsonFile<TrashMeta>(path.join(dir, 'meta.json'))
    if (!meta) throw new Error('回收站条目不存在')
    const dataDir = path.join(dir, 'data')
    if (!(await fsp.stat(dataDir).then(() => true).catch(() => false))) throw new Error('回收站内容已丢失')

    // 目标冲突 → 自动加「-恢复N」后缀
    let target = meta.originalPath
    await fsp.mkdir(path.dirname(target), { recursive: true })
    if (await fsp.stat(target).then(() => true).catch(() => false)) {
      const ext = meta.kind === 'file' ? path.extname(meta.name) : ''
      const base = meta.kind === 'file' ? path.basename(meta.name, ext) : meta.name
      let n = 1
      do {
        target = path.join(path.dirname(meta.originalPath), `${base}-恢复${n}${ext}`)
        n++
      } while (await fsp.stat(target).then(() => true).catch(() => false))
    }

    try {
      await fsp.rename(dataDir, target)
    } catch {
      await fsp.cp(dataDir, target, { recursive: true, force: true })
      await fsp.rm(dataDir, { recursive: true, force: true })
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})

    // v2.4.x：恢复移回 → 失效目标路径与其父目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(target))
    globalFileListCache.invalidate(target)

    // 子文件夹恢复：名字加回 config（产品集列表为目录扫描，无需额外注册）
    if (meta.kind === 'subfolder') {
      const rel = path.relative(path.join(ws, PRODUCT_SETS_DIR), meta.originalPath)
      const parts = rel.split(path.sep)
      const subName = parts[parts.length - 1]
      const type = parts[1] === IMAGES_DIR ? 'image' : parts[1] === CERTS_DIR ? 'cert' : null
      if (type && subName) {
        const cfg = await this.workspace.loadConfig(ws)
        const list = type === 'image' ? cfg.image_subfolders : cfg.cert_subfolders
        if (!list.includes(subName)) {
          if (type === 'image') cfg.image_subfolders.push(subName)
          else cfg.cert_subfolders.push(subName)
          await this.workspace.saveConfig(ws, cfg)
        }
      }
    }
  }

  /** 彻底删除：清理 data + 对应元数据与缩略图缓存 */
  async purge(id: string): Promise<void> {
    const ws = this.requireWS()
    const dir = this.entryDir(ws, id)
    const meta = await readJsonFile<TrashMeta>(path.join(dir, 'meta.json'))
    if (!meta) throw new Error('回收站条目不存在')
    const dataDir = path.join(dir, 'data')

    if (meta.kind === 'file') {
      const ps = productSetFromFilePath(ws, meta.originalPath)
      if (ps) await this.metadata.removeFileMetadata(ps, path.basename(meta.originalPath))
      await this.thumbs.removeThumbnail(meta.originalPath).catch(() => {})
    } else if (meta.kind === 'subfolder') {
      const ps = productSetFromFilePath(ws, meta.originalPath)
      if (ps) {
        const files = await fsp.readdir(dataDir).catch(() => [] as string[])
        for (const f of files) await this.metadata.removeFileMetadata(ps, f)
      }
      await this.thumbs.removeThumbnailsInDir(meta.originalPath).catch(() => {})
    } else {
      const name = path.basename(meta.originalPath)
      await this.metadata.removeFileMetadataForProductSet(name)
      await this.thumbs.removeThumbnailsInDir(meta.originalPath).catch(() => {})
    }

    await fsp.rm(dir, { recursive: true, force: true })
    // v2.4.x：彻底删除 → 失效原路径与其父目录的文件列表缓存
    globalFileListCache.invalidate(path.dirname(meta.originalPath))
    globalFileListCache.invalidate(meta.originalPath)
  }

  /** 清空回收站（全部彻底删除） */
  async empty(): Promise<void> {
    const entries = await this.list()
    for (const e of entries) {
      await this.purge(e.id).catch(() => {})
    }
  }

  /**
   * 自动清理过期回收站条目（v2.4.0）：
   * 策略——保留最近 maxDays 天内的条目（用户可能还会恢复），超期条目逐个彻底删除
   * （purge 同时清理对应元数据与缩略图缓存，不留残留）。
   * 并发执行加速；单条失败跳过不阻断整体。返回清理条数。
   * 调用时机：应用启动时执行一次即可（运行中不重复扫描，避免误删）。
   */
  async cleanupExpired(maxDays = 30): Promise<number> {
    const entries = await this.list()
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    const expired = entries.filter((e) => {
      const t = new Date(e.deletedAt).getTime()
      return !Number.isNaN(t) && t < cutoff
    })
    await Promise.all(expired.map((e) => this.purge(e.id).catch(() => {})))
    return expired.length
  }
}
