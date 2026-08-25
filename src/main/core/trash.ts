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
  isPathInsideWorkspaceReal,
  productSetFromFilePath,
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  DOCS_DIR,
  CUSTOMERS_DIR,
  SUPPLIERS_DIR,
  SUPPLIER_SUBFOLDERS,
} from './paths'
import { WorkspaceService } from './workspace'
import { MetadataService, currentTimeString } from './metadata'
import { globalWorkspaceIndex } from './indexCache'
import type { ThumbnailProvider } from './files'
import type { ClientsService } from './clients'
import type { SuppliersService } from './suppliers'
import type { TrashEntry, TrashKind } from '../../shared/types'

export type { TrashEntry, TrashKind } from '../../shared/types'

export const TRASH_DIR = 'trash'

interface TrashMeta extends TrashEntry {}

export class TrashService {
  /**
   * v2.4.7：clients 注入用于 kind='customer' 的 purge 时清理 customers.json 条目
   * （可选——未注入（旧调用方）时跳过条目清理，其余行为不变）。
   * v2.4.9 S2：suppliers 注入同样式——kind='supplier' 的 purge 时清理 suppliers.json 条目、
   * restore 时回填固定子文件夹与缺失档案条目。
   */
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
    private thumbs: ThumbnailProvider,
    private clients?: ClientsService,
    private suppliers?: SuppliersService,
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
    if (!(await isPathInsideWorkspaceReal(ws, srcPath))) throw new Error('只能删除工作区内的内容')
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
    // v2.4.x：目录内容变化（移入回收站）→ 失效源路径与其父目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(srcPath))
    globalWorkspaceIndex.invalidate(srcPath)
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

    // v2.4.x：恢复移回 → 失效目标路径与其父目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(target))
    globalWorkspaceIndex.invalidate(target)

    // 子文件夹恢复：名字加回 config（产品集列表为目录扫描，无需额外注册）
    if (meta.kind === 'subfolder') {
      // v2.4.7（§4.4）：原路径首段为 客户 → 回填 cfg.customer_subfolders；否则走现有 image/cert 逻辑
      const relRoot = path.relative(ws, meta.originalPath)
      const rootParts = relRoot.split(path.sep)
      const subName = rootParts[rootParts.length - 1]
      if (rootParts[0] === CUSTOMERS_DIR && subName) {
        const cfg = await this.workspace.loadConfig(ws)
        if (!(cfg.customer_subfolders ?? []).includes(subName)) {
          cfg.customer_subfolders = [...(cfg.customer_subfolders ?? []), subName]
          await this.workspace.saveConfig(ws, cfg)
        }
      } else {
        const rel = path.relative(path.join(ws, PRODUCT_SETS_DIR), meta.originalPath)
        const parts = rel.split(path.sep)
        // v2.5.1（F1）：文档 子文件夹恢复 → 回填 cfg.doc_subfolders
        const type = parts[1] === IMAGES_DIR ? 'image' : parts[1] === CERTS_DIR ? 'cert' : parts[1] === DOCS_DIR ? 'doc' : null
        if (type && subName) {
          const cfg = await this.workspace.loadConfig(ws)
          if (type === 'doc') {
            if (!(cfg.doc_subfolders ?? []).includes(subName)) {
              cfg.doc_subfolders = [...(cfg.doc_subfolders ?? []), subName]
              await this.workspace.saveConfig(ws, cfg)
            }
          } else {
            const list = type === 'image' ? cfg.image_subfolders : cfg.cert_subfolders
            if (!list.includes(subName)) {
              if (type === 'image') cfg.image_subfolders.push(subName)
              else cfg.cert_subfolders.push(subName)
              await this.workspace.saveConfig(ws, cfg)
            }
          }
        }
      }
    }
    // v2.4.9 S2：供应商恢复——按 config.supplier_subfolders 回填子文件夹结构（v2.5.5 起可配置，旧固定集默认 合同/对账单/往来文件）；
    // 档案条目在删除时保留（恢复即复原），若缺失（如目录为外部手工创建）则补回最小条目（参照客户对 customers.json 的处理）
    if (meta.kind === 'supplier') {
      const cfg = await this.workspace.loadConfig(ws).catch(() => null)
      for (const sub of (cfg?.supplier_subfolders?.length ? cfg.supplier_subfolders : SUPPLIER_SUBFOLDERS)) {
        await fsp.mkdir(path.join(target, sub), { recursive: true })
      }
      if (this.suppliers) {
        const name = meta.name
        const store = await this.suppliers.loadSuppliersInfo().catch(() => null)
        if (store && !store[name]) {
          const now = currentTimeString()
          store[name] = { created_at: now, updated_at: now }
          await this.suppliers.saveSuppliersInfo(ws, store).catch(() => {})
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
      await this.metadata.removeFileMetadata(meta.originalPath).catch(() => {})
      await this.thumbs.removeThumbnail(meta.originalPath).catch(() => {})
    } else {
      // v2.4.2（D2）：目录类条目——dataDir 已移入回收站，meta.originalPath 已不存在，
      // 旧实现 removeThumbnailsInDir(originalPath) 是空操作（缓存只涨不消 + 同路径新文件可能显示旧图）。
      // 改为遍历回收站 dataDir，按相对 originalPath 的位置映射回原路径，批量清理元数据与缩略图。
      const originalFiles: string[] = []
      const collect = async (d: string, rel: string): Promise<void> => {
        let entries: import('node:fs').Dirent[]
        try {
          entries = await fsp.readdir(d, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const full = path.join(d, e.name)
          if (e.isDirectory()) {
            await collect(full, path.join(rel, e.name))
          } else {
            originalFiles.push(path.join(rel, e.name))
          }
        }
      }
      await collect(dataDir, meta.originalPath)
      if (meta.kind === 'subfolder') {
        for (const f of originalFiles) await this.metadata.removeFileMetadata(f).catch(() => {})
      } else if (meta.kind === 'productSet') {
        // productSet：整个产品集元数据按前缀清理
        const name = path.basename(meta.originalPath)
        await this.metadata.removeFileMetadataForProductSet(name).catch(() => {})
      } else if (meta.kind === 'customer') {
        // v2.4.7（§4.4）：客户区元数据按前缀 客户/<名>/ 清理（key 泛化后为工作区相对路径）
        // v2.5.3（P1-3）：改走 mutateKeys 锁内读改写——旧实现「锁外读旧快照 + 整档替换」在 purge
        // 与其他 metadata 写并发时会抹掉锁内最新值。回调内保留前缀判定原语义；无匹配时多一次
        // 原子重写（PLAN 已接受）。
        const name = path.basename(meta.originalPath)
        const prefixes = [`${CUSTOMERS_DIR}/${name}/`, `${CUSTOMERS_DIR}\\${name}\\`]
        await this.metadata.mutateKeys(ws, (files) => {
          for (const key of Object.keys(files)) {
            if (prefixes.some((p) => key.startsWith(p))) delete files[key]
          }
        })
        // customers.json 条目清理（账物分离：invoices/inbound 中 customer 字段保留字面值，本处不动）
        await this.clients?.removeEntry(name).catch(() => {})
      } else if (meta.kind === 'supplier') {
        // v2.4.9 S2：供应商四清理——①目录（dataDir 已在回收站内，随本条 rm）②metadata 前缀 供应商/<名>/ 清理
        // ③缩略图（下方统一 removeThumbnails）④suppliers.json 条目删除。
        // inbound.supplier_id 留字面值不级联删入库单（账物分离同发票 customer 字段，S2 §五）
        // v2.5.3（P1-3）：同 customer 分支改走 mutateKeys 锁内读改写（整档替换的丢失更新窗口已消除）；
        // 无匹配前缀时多一次原子重写（PLAN 已接受）。
        const name = path.basename(meta.originalPath)
        const prefixes = [`${SUPPLIERS_DIR}/${name}/`, `${SUPPLIERS_DIR}\\${name}\\`]
        await this.metadata.mutateKeys(ws, (files) => {
          for (const key of Object.keys(files)) {
            if (prefixes.some((p) => key.startsWith(p))) delete files[key]
          }
        })
        await this.suppliers?.removeEntry(name).catch(() => {})
      }
      await this.thumbs.removeThumbnails(originalFiles).catch(() => {})
    }

    await fsp.rm(dir, { recursive: true, force: true })
    // v2.4.x：彻底删除 → 失效原路径与其父目录的索引快照
    globalWorkspaceIndex.invalidate(path.dirname(meta.originalPath))
    globalWorkspaceIndex.invalidate(meta.originalPath)
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
