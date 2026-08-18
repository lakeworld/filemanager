/**
 * 文件元数据（对照原 Go metadata.go）
 * 纯 TS 业务层。
 *
 * v2.4.2（D3+D4）：元数据 key 重构
 * - 旧格式：`产品集/文件名`（path.join 拼接 → Windows 落盘 `\`、Linux 落盘 `/`，且不含子文件夹，
 *   同产品集不同子文件夹的同名文件元数据互相串号、回收站 purge 会误删仍在使用的同名文件）
 * - 新格式：`产品集/图包|证书/子文件夹/文件名`，由「相对工作区的文件路径」推导、固定 `/` 分隔符
 *   → 跨平台（Win/Linux 双机坚果云共享）一致、子文件夹间隔离
 * - 兼容：读取按 keyCandidates 回退旧格式 key；首次写入新 key 时把旧条目懒迁移并删除旧 key
 * - v2.4.2（C1）：expiry_date 写入时归一化为 YYYY-MM-DD（可解析则转换，解析失败原样保留由读取侧宽松解析）
 *
 * v2.5.3（T2）：写路径统一走 mutateStore 事务——
 * - 锁内严格读 + 修改 + 保存同事务（mutateJsonFile 按路径串行），杜绝「内存已改、写盘失败」的假成功；
 * - 缓存只存深拷贝、只在保存成功后更新，读路径不再持有可被锁外改写的共享引用；
 * - 损坏 JSON 的写路径首次拒绝覆盖（隔离备份留证），只读路径降级为空库且备份命名与 jsonStore 规范一致。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  metadataPath,
  ensureWorkspaceDirs,
  PRODUCT_SETS_DIR,
  CUSTOMERS_DIR,
  INVOICES_DIR,
  INBOUND_DIR,
  EXCHANGE_DIR,
  SUPPLIERS_DIR,
  QUOTES_DIR,
  productSetFromFilePath,
} from './paths'
import { mutateJsonFile, readJsonDetailed } from './jsonStore'
import { WorkspaceService } from './workspace'
import type { FileMetadata, MetadataUpdateRequest, BatchTagRequest, BatchTagResult, FailedItem } from '../../shared/types'

export type { FileMetadata, MetadataUpdateRequest, BatchTagRequest, BatchTagResult } from '../../shared/types'

interface MetadataStore {
  files: Record<string, FileMetadata>
}

/**
 * v2.5.3（T2）：metadata.json 结构校验（jsonStore validate 约定：合法返回原值、非法返回 null）。
 * files 必须为对象；非法即视为损坏——写入路径拒绝覆盖并留证，只读路径降级为空库。
 */
export function validateMetadataStore(value: unknown): MetadataStore | null {
  if (typeof value !== 'object' || value === null) return null
  const store = value as MetadataStore
  if (store.files && typeof store.files === 'object') return store
  return null
}

function emptyMetadata(): FileMetadata {
  return { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: '' }
}

export function currentTimeString(): string {
  return new Date().toISOString()
}

/**
 * v2.4.2（C1）：宽松解析到期日期。
 * 优先按 YYYY[-/.]M[-/.]D 提取（严格校验年月日合法性，杜绝 2023-02-30 这类滚动日期），
 * 再回退整串 ISO 解析（提取/导入可能带时间）。解析失败返回 Invalid Date。
 */
export function parseExpiryDate(s: string): Date {
  const v = s.trim()
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    const t = new Date(y, mo - 1, d)
    if (t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d) return t
    return new Date(NaN) // 非法日（2023-02-30）明确失败
  }
  const full = new Date(v)
  return Number.isNaN(full.getTime()) ? new Date(NaN) : full
}

/** v2.4.2（C1）：归一化为 YYYY-MM-DD；解析失败返回 null（调用方决定保留原文还是拒收） */
export function normalizeExpiryDate(s: string): string | null {
  const t = parseExpiryDate(s)
  if (Number.isNaN(t.getTime())) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** v2.4.7（§4.1）：元数据 key 首段所属区域（结构化解析 key 的统一判读出口）；v2.4.9 S2 追加 'supplier'、S3 追加 'quote' */
export type MetadataKeyRegion = 'productSet' | 'customer' | 'invoice' | 'inbound' | 'exchange' | 'supplier' | 'quote'

/**
 * v2.4.7（§4.1）：元数据 key 区域判读——所有结构化解析 key 的位置统一走此函数。
 * 判读规则：key 首段 ∈ {客户, 发票, 入库, 交换区, 供应商, 报价} 且该首段不是实存产品集目录 → 按对应区域解读；
 * 否则按产品集 key 解读（存量同名产品集兼容优先，§3.7 保留名使新数据无歧义）。
 * ws：工作区路径（未打开工作区时传入空串会返回 'productSet'，由调用方自行决定语义）。
 */
export async function interpretMetadataKeyRegion(ws: string, key: string): Promise<MetadataKeyRegion> {
  const first = key.replace(/\\/g, '/').split('/')[0] ?? ''
  if (
    first !== CUSTOMERS_DIR &&
    first !== INVOICES_DIR &&
    first !== INBOUND_DIR &&
    first !== EXCHANGE_DIR &&
    first !== SUPPLIERS_DIR &&
    first !== QUOTES_DIR
  ) {
    return 'productSet'
  }
  // 首段为保留名但存在同名产品集目录 → 产品集优先（存量兼容）
  try {
    await fsp.stat(path.join(path.resolve(ws), PRODUCT_SETS_DIR, first))
    return 'productSet'
  } catch {
    if (first === CUSTOMERS_DIR) return 'customer'
    if (first === INVOICES_DIR) return 'invoice'
    if (first === INBOUND_DIR) return 'inbound'
    if (first === SUPPLIERS_DIR) return 'supplier'
    if (first === QUOTES_DIR) return 'quote'
    return 'exchange'
  }
}

export class MetadataService {
  /**
   * 内存缓存：按工作区路径缓存 store，避免大 metadata.json 反复全量解析。
   * v2.4.2（批次二）：缓存条目记录 metadata.json 的 mtime——每次读取先 stat 一次，
   * mtime 变化（另一台机器同步覆盖）即重读磁盘，避免本机缓存整体覆盖新数据。
   * v2.2.1：LRU 上限 3 个工作区，防长期运行无界增长。
   */
  private cache = new Map<string, { mtime: number; store: MetadataStore }>()
  private readonly CACHE_MAX = 3

  /**
   * 测试注入点：持久化前钩子（抛错即模拟写盘失败，用于断言「保存失败后缓存不更新」）。
   * 生产恒为空；仅单测经 `(service as unknown as {...}).beforePersist` 设置。
   */
  private beforePersist?: (ws: string) => void | Promise<void>

  constructor(private workspace: WorkspaceService) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  private async statMtime(p: string): Promise<number> {
    try {
      return (await fsp.stat(p)).mtimeMs
    } catch {
      return 0
    }
  }

  /** 读取元数据存储；损坏时自动备份原文件并降级为空库（稳定性增强，原 Go 无备份） */
  async loadMetadataStore(ws?: string): Promise<MetadataStore> {
    const w = ws ?? this.requireWS()
    const mtime = await this.statMtime(metadataPath(w))
    const hit = this.cache.get(w)
    if (hit && hit.mtime === mtime) {
      // LRU 触摸：移到末尾
      this.cache.delete(w)
      this.cache.set(w, hit)
      return hit.store
    }
    const store = await this.readFromDisk(w)
    if (this.cache.size >= this.CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(w, { mtime, store })
    return store
  }

  /** 只读路径读盘：缺失视为空库；损坏经 readJsonDetailed 按 jsonStore 规范留证（.corrupt-*，上限 3 个）并降级为空库 */
  private async readFromDisk(w: string): Promise<MetadataStore> {
    const p = metadataPath(w)
    const result = await readJsonDetailed<MetadataStore>(p, {
      backupOnCorrupt: true,
      validate: validateMetadataStore,
    })
    if (result.ok) return result.value
    return { files: {} } // 缺失/损坏/IO 一律降级为空库（损坏已留证，不抛错）
  }

  /**
   * v2.5.3（T2）：元数据单文件事务——锁内严格读 + 修改 + 保存同事务（mutateJsonFile 按路径串行）。
   * - 回调内可以直接改 store.files，保存失败时磁盘与内存都不落笔（杜绝假成功）；
   * - 缓存只在保存成功后以深拷贝更新，读路径不再看到被锁外改写的共享引用。
   * 供内部各写方法及需要跨文件追加/迁移元数据条目的外部服务调用。
   */
  async mutateStore<R>(ws: string, mutate: (store: MetadataStore) => Promise<R> | R): Promise<R> {
    const p = metadataPath(ws)
    ensureWorkspaceDirs(ws)
    let savedStore: MetadataStore | undefined
    const result = await mutateJsonFile(p, {
      read: async () => ({ files: {} }), // 文件缺失按空库起步
      mutate: async (store) => {
        const r = await mutate(store)
        savedStore = store
        return r
      },
      save: async () => {
        if (this.beforePersist) await this.beforePersist(ws) // 测试注入：模拟持久化失败
        return true
      },
      validate: validateMetadataStore, // 结构非法即视为损坏，写入路径拒绝并留证
    })
    if (savedStore) {
      const mtime = await this.statMtime(p)
      this.cache.delete(ws)
      this.cache.set(ws, { mtime, store: structuredClone(savedStore) })
    }
    return result
  }

  /**
   * v2.5.3（找bug打磨轮 P1-3）：锁内基于磁盘最新值做批量 key 操作（key 迁移/前缀清理）。
   * 供 files/trash/tags 的引用源迁移使用——杜绝「锁外读旧快照 + 整档替换」的丢失更新窗口；
   * 缓存仅在保存成功后以深拷贝更新。语义与 mutateStore 相同（逐 JSON 顺序提交，不跨文件原子）。
   */
  async mutateKeys<R>(ws: string, mutate: (files: Record<string, FileMetadata>) => Promise<R> | R): Promise<R> {
    return this.mutateStore(ws, async (store) => mutate(store.files))
  }

  /** 整档替换式写入（兼容旧调用面，如 trash/tags/files 的 load→改→save）；锁内读回磁盘值后整体替换 */
  async saveMetadataStore(store: MetadataStore, ws?: string): Promise<void> {
    const w = ws ?? this.requireWS()
    ensureWorkspaceDirs(w)
    const p = metadataPath(w)
    await mutateJsonFile(p, {
      read: async () => ({ files: {} }),
      mutate: (current) => {
        // 用传入 store 整体替换当前值（写盘内容与传入一致）
        for (const k of Object.keys(current)) delete (current as Record<string, unknown>)[k]
        Object.assign(current, store)
        return undefined
      },
      save: async () => true,
      validate: validateMetadataStore,
    })
    const mtime = await this.statMtime(p)
    this.cache.delete(w)
    this.cache.set(w, { mtime, store: structuredClone(store) })
  }

  /**
   * v2.4.2（D3+D4）：元数据 key = 相对工作区「产品集」目录的路径，固定 `/` 分隔符。
   * 形如 `系列A/图包/主图/a.jpg`；文件不在产品集内返回空串。
   *
   * v2.4.7（§4.1）：key 泛化——工作区内任意文件都有 key：
   * - `产品集/` 内：相对产品集目录（格式不变，存量元数据/缩略图哈希/回收站逻辑零迁移）
   * - 工作区内其他位置：相对工作区根（如 `客户/张三/报价/a.pdf`、`发票/2026/f.pdf`）
   * - 工作区外：空串（调用方据此拒绝，如 update / setTagsBatch）
   */
  fileMetadataKey(filePath: string, ws?: string): string {
    const w = ws ?? this.requireWS()
    const resolved = path.resolve(filePath)
    const psBase = path.join(path.resolve(w), PRODUCT_SETS_DIR)
    const psRel = path.relative(psBase, resolved)
    if (!psRel) return '' // 产品集目录本身（与 v2.4.2 行为一致，目录无元数据 key）
    if (!psRel.startsWith('..') && !path.isAbsolute(psRel)) {
      return psRel.split(path.sep).join('/')
    }
    const wsRel = path.relative(path.resolve(w), resolved)
    if (!wsRel || wsRel.startsWith('..') || path.isAbsolute(wsRel)) return ''
    return wsRel.split(path.sep).join('/')
  }

  /** 读取候选 key（新格式 + 旧格式兼容回退）；第一个是目标 key，其余是旧数据位置 */
  private keyCandidates(filePath: string, ws?: string): string[] {
    const w = ws ?? this.requireWS()
    const key = this.fileMetadataKey(filePath, w)
    const ps = productSetFromFilePath(w, filePath)
    const base = path.basename(filePath)
    const legacy: string[] = []
    if (ps) legacy.push(`${ps}/${base}`, `${ps}\\${base}`)
    return [key, ...legacy.filter((k) => k !== key)]
  }

  async get(filePath: string): Promise<FileMetadata> {
    this.requireWS()
    const store = await this.loadMetadataStore()
    for (const k of this.keyCandidates(filePath)) {
      const meta = store.files[k]
      if (meta) return meta
    }
    return emptyMetadata()
  }

  async update(req: MetadataUpdateRequest): Promise<void> {
    const ws = this.requireWS()
    if (!req.file_path) throw new Error('缺少文件路径')
    await this.mutateStore(ws, (store) => {
      const keys = this.keyCandidates(req.file_path, ws)
      const key = keys[0]
      if (!key) throw new Error('文件不在工作区内，无法保存元数据')
      // 懒迁移：旧格式 key 存在则取走其数据并删除旧条目（写入即迁移，无需全量扫描）
      let existing = store.files[key]
      if (!existing) {
        for (const lk of keys.slice(1)) {
          if (store.files[lk]) {
            existing = store.files[lk]
            delete store.files[lk]
            break
          }
        }
      }
      const cur = existing ?? emptyMetadata()
      if (!cur.added_at) cur.added_at = currentTimeString()
      cur.cert_type = (req.cert_type ?? '').trim()
      const rawExpiry = (req.expiry_date ?? '').trim()
      cur.expiry_date = rawExpiry ? (normalizeExpiryDate(rawExpiry) ?? rawExpiry) : ''
      cur.tags = req.tags ?? []
      cur.notes = (req.notes ?? '').trim()
      store.files[key] = cur
    })
  }

  async setFileMetadata(filePath: string, meta: FileMetadata): Promise<void> {
    await this.setFileMetadataBatch([{ filePath, meta }])
  }

  /**
   * v2.4.4（T4）：批量打标——一次加载 + 一次落盘，逐文件 add/remove 合并去重。
   * 非产品集内文件/空路径进入失败清单，单文件失败不中断整体。
   * v2.5.3（T2）：合并与落盘统一在 mutateStore 事务内完成。
   */
  async setTagsBatch(req: BatchTagRequest): Promise<BatchTagResult> {
    if (!req.paths || req.paths.length === 0) throw new Error('没有选择文件')
    const ws = this.requireWS()
    const add = new Set(req.add ?? [])
    const remove = new Set(req.remove ?? [])
    return this.mutateStore(ws, (store) => {
      const failed: FailedItem[] = []
      for (const raw of req.paths) {
        const p = raw.trim()
        if (!p) {
          failed.push({ path: raw, error: '路径为空' })
          continue
        }
        const key = this.fileMetadataKey(p, ws)
        if (!key) {
          failed.push({ path: p, error: '文件不在工作区内' })
          continue
        }
        const cur = store.files[key] ?? emptyMetadata()
        if (!cur.added_at) cur.added_at = currentTimeString()
        const tags = (cur.tags ?? []).filter((t) => !remove.has(t))
        for (const a of add) {
          if (!tags.includes(a)) tags.push(a)
        }
        const same =
          (cur.tags ?? []).length === tags.length && (cur.tags ?? []).every((t, i) => t === tags[i])
        if (!same) {
          cur.tags = tags
          store.files[key] = cur
        }
      }
      return { updated: req.paths.length - failed.length, failed }
    })
  }

  /**
   * v2.4.2（I3）：批量写入——单次 IO 落盘，替代导入循环内逐文件全量重写 metadata.json。
   * 已存在元数据的 key（如删除进回收站后重新导入的同名文件）保留原标签/备注，只补 added_at。
   * v2.5.3（T2）：批量合并与落盘统一在 mutateStore 事务内完成。
   */
  async setFileMetadataBatch(entries: { filePath: string; meta: FileMetadata }[]): Promise<void> {
    if (entries.length === 0) return
    const ws = this.requireWS()
    await this.mutateStore(ws, (store) => {
      for (const { filePath, meta } of entries) {
        const key = this.fileMetadataKey(filePath, ws)
        if (!key) continue
        const existing = store.files[key]
        if (existing) {
          if (!existing.added_at) existing.added_at = meta.added_at || currentTimeString()
          continue
        }
        store.files[key] = meta
      }
    })
  }

  async removeFileMetadata(filePath: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store) => {
      for (const k of this.keyCandidates(filePath, ws)) {
        delete store.files[k]
      }
    })
  }

  async removeFileMetadataForProductSet(productSet: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store) => {
      const prefixes = [productSet + '/', productSet + '\\'] // 兼容旧 `\` key
      for (const key of Object.keys(store.files)) {
        if (prefixes.some((p) => key.startsWith(p))) {
          delete store.files[key]
        }
      }
    })
  }
}
