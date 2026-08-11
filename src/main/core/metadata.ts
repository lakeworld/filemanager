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
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  metadataPath,
  writeJsonAtomic,
  ensureWorkspaceDirs,
  PRODUCT_SETS_DIR,
  CUSTOMERS_DIR,
  INVOICES_DIR,
  INBOUND_DIR,
  EXCHANGE_DIR,
  productSetFromFilePath,
} from './paths'
import { WorkspaceService } from './workspace'
import type { FileMetadata, MetadataUpdateRequest, BatchTagRequest, BatchTagResult, FailedItem } from '../../shared/types'

export type { FileMetadata, MetadataUpdateRequest, BatchTagRequest, BatchTagResult } from '../../shared/types'

interface MetadataStore {
  files: Record<string, FileMetadata>
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
 * 再回退整串 ISO 解析（AI 抽取可能带时间）。解析失败返回 Invalid Date。
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

/** v2.4.7（§4.1）：元数据 key 首段所属区域（结构化解析 key 的统一判读出口） */
export type MetadataKeyRegion = 'productSet' | 'customer' | 'invoice' | 'inbound' | 'exchange'

/**
 * v2.4.7（§4.1）：元数据 key 区域判读——所有结构化解析 key 的位置统一走此函数。
 * 判读规则：key 首段 ∈ {客户, 发票, 入库, 交换区} 且该首段不是实存产品集目录 → 按对应区域解读；
 * 否则按产品集 key 解读（存量同名产品集兼容优先，§3.7 保留名使新数据无歧义）。
 * ws：工作区路径（未打开工作区时传入空串会返回 'productSet'，由调用方自行决定语义）。
 */
export async function interpretMetadataKeyRegion(ws: string, key: string): Promise<MetadataKeyRegion> {
  const first = key.replace(/\\/g, '/').split('/')[0] ?? ''
  if (first !== CUSTOMERS_DIR && first !== INVOICES_DIR && first !== INBOUND_DIR && first !== EXCHANGE_DIR) {
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

  private async readFromDisk(w: string): Promise<MetadataStore> {
    const p = metadataPath(w)
    let raw: string
    try {
      raw = await fsp.readFile(p, 'utf-8')
    } catch {
      return { files: {} } // 文件不存在视为空库
    }
    try {
      const parsed = JSON.parse(raw) as MetadataStore
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return parsed
      }
      throw new Error('结构非法')
    } catch {
      // 损坏：备份原文件（不丢数据），降级为空库
      try {
        await fsp.copyFile(p, `${p}.corrupt-${Date.now()}`)
      } catch {
        // 备份失败不阻断
      }
      return { files: {} }
    }
  }

  async saveMetadataStore(store: MetadataStore, ws?: string): Promise<void> {
    const w = ws ?? this.requireWS()
    // 写入时同步更新缓存（记录写入后的 mtime，保证下次 stat 命中缓存，保持读一致性）
    ensureWorkspaceDirs(w)
    await writeJsonAtomic(metadataPath(w), store)
    const mtime = await this.statMtime(metadataPath(w))
    this.cache.set(w, { mtime, store })
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
  fileMetadataKey(filePath: string): string {
    const ws = this.requireWS()
    const resolved = path.resolve(filePath)
    const psBase = path.join(path.resolve(ws), PRODUCT_SETS_DIR)
    const psRel = path.relative(psBase, resolved)
    if (!psRel) return '' // 产品集目录本身（与 v2.4.2 行为一致，目录无元数据 key）
    if (!psRel.startsWith('..') && !path.isAbsolute(psRel)) {
      return psRel.split(path.sep).join('/')
    }
    const wsRel = path.relative(path.resolve(ws), resolved)
    if (!wsRel || wsRel.startsWith('..') || path.isAbsolute(wsRel)) return ''
    return wsRel.split(path.sep).join('/')
  }

  /** 读取候选 key（新格式 + 旧格式兼容回退）；第一个是目标 key，其余是旧数据位置 */
  private keyCandidates(filePath: string): string[] {
    const ws = this.requireWS()
    const key = this.fileMetadataKey(filePath)
    const ps = productSetFromFilePath(ws, filePath)
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
    const keys = this.keyCandidates(req.file_path)
    const key = keys[0]
    if (!key) throw new Error('文件不在工作区内，无法保存元数据')
    const store = await this.loadMetadataStore()
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
    await this.saveMetadataStore(store, ws)
  }

  async setFileMetadata(filePath: string, meta: FileMetadata): Promise<void> {
    await this.setFileMetadataBatch([{ filePath, meta }])
  }

  /**
   * v2.4.4（T4）：批量打标——一次加载 + 一次落盘，逐文件 add/remove 合并去重。
   * 非产品集内文件/空路径进入失败清单，单文件失败不中断整体。
   */
  async setTagsBatch(req: BatchTagRequest): Promise<BatchTagResult> {
    if (!req.paths || req.paths.length === 0) throw new Error('没有选择文件')
    const ws = this.requireWS()
    const add = new Set(req.add ?? [])
    const remove = new Set(req.remove ?? [])
    const store = await this.loadMetadataStore()
    let changed = false
    const failed: FailedItem[] = []
    for (const raw of req.paths) {
      const p = raw.trim()
      if (!p) {
        failed.push({ path: raw, error: '路径为空' })
        continue
      }
      const key = this.fileMetadataKey(p)
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
        changed = true
      }
    }
    if (changed) await this.saveMetadataStore(store, ws)
    return { updated: req.paths.length - failed.length, failed }
  }

  /**
   * v2.4.2（I3）：批量写入——单次 IO 落盘，替代导入循环内逐文件全量重写 metadata.json。
   * 已存在元数据的 key（如删除进回收站后重新导入的同名文件）保留原标签/备注，只补 added_at。
   */
  async setFileMetadataBatch(entries: { filePath: string; meta: FileMetadata }[]): Promise<void> {
    if (entries.length === 0) return
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    for (const { filePath, meta } of entries) {
      const key = this.fileMetadataKey(filePath)
      if (!key) continue
      const existing = store.files[key]
      if (existing) {
        if (!existing.added_at) existing.added_at = meta.added_at || currentTimeString()
        continue
      }
      store.files[key] = meta
    }
    await this.saveMetadataStore(store, ws)
  }

  async removeFileMetadata(filePath: string): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    const keys = this.keyCandidates(filePath)
    let changed = false
    for (const k of keys) {
      if (store.files[k]) {
        delete store.files[k]
        changed = true
      }
    }
    if (!changed) return
    await this.saveMetadataStore(store, ws)
  }

  async removeFileMetadataForProductSet(productSet: string): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    const prefixes = [productSet + '/', productSet + '\\'] // 兼容旧 `\` key
    let changed = false
    for (const key of Object.keys(store.files)) {
      if (prefixes.some((p) => key.startsWith(p))) {
        delete store.files[key]
        changed = true
      }
    }
    if (!changed) return
    await this.saveMetadataStore(store, ws)
  }
}
