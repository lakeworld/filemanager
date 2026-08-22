/**
 * 供应商维度（v2.4.9 S2）：供应商/ 目录 + suppliers.json 档案
 * - 完整参照客户（v2.4.7 §5.1）范式：目录扫描为实，JSON 为档案（与 product_sets.json 同哲学）；
 *   供应商名 = 目录名 = JSON key；目录不存在 = 供应商不存在；删除走回收站时 JSON 条目保留（恢复即复原）
 * - 子文件夹固定集 SUPPLIER_SUBFOLDERS（决策 1：r3 拍板不做 config 键，最小改动；create/restore 建齐）
 * - related_product_sets 关联产品集（v2.4.9 打磨 M8，镜像客户）：linkRelation/unlinkRelation 唯一写点，
 *   create/update 校验产品集存在 + 去重，拒绝孤儿关联；产品集侧只读反查本版不做（留 v2.7）
 * - erp_ext 为 v2.7 启禾 OS同步预留命名空间：本体只读不校验、API 面不含入参
 *   （SupplierCreateRequest/SupplierUpdateRequest 无此字段 → 物理不可写；读写档案时原样保留）
 * - Logger（S6 core 接口）构造注入：create/rename 写 info 日志；未注入（可选）时静默跳过
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  suppliersInfoPath,
  supplierRootPath,
  SUPPLIERS_DIR,
  SUPPLIER_SUBFOLDERS,
  ensureWorkspaceDirs,
  overwriteJson,
  readJsonFile,
  assertSafeFolderName,
  productSetRootPath,
} from './paths'
import { mutateJsonFile } from './jsonStore'
import { WorkspaceService, countFiles } from './workspace'
import { currentTimeString } from './metadata'
import { globalWorkspaceIndex } from './indexCache'
import type { Logger } from './logger'
import type { SupplierInfo, SupplierExtraInfo, SupplierCreateRequest, SupplierUpdateRequest } from '../../shared/types'

export type { SupplierInfo, SupplierExtraInfo, SupplierCreateRequest, SupplierUpdateRequest } from '../../shared/types'

// —— v2.5.4（弹一 C-1，云桥 M3）：supplier 能力域 syncProfile 记录级裁决纯函数（镜像客户 resolveSyncProfile）——

/** syncProfile 可写白名单（本体对齐字段）：box 权威字段（tags/related_product_sets）拒绝；供应商无 type */
const SUPPLIER_SYNC_PROFILE_FIELDS = ['contact', 'phone', 'email', 'address', 'notes'] as const

export interface SupplierSyncProfileResult {
  applied: boolean
  /** 白名单外字段入参（或空白 phone）→ 拒绝，host 层据此抛 FIELD_DENIED */
  denied?: boolean
  /** applied 时的新档案（供 host 层写回） */
  next?: SupplierExtraInfo
}

/**
 * 记录级裁决纯函数（D6 语义，镜像 resolveSyncProfile）：req.updated_at ≤ 档案 updated_at → STALE（不写）；
 * 较新 → 仅合并白名单差异字段 + erp_ext；白名单外字段入参 → denied。
 */
export function resolveSupplierSyncProfile(
  local: SupplierExtraInfo,
  req: { fields?: Partial<Record<string, unknown>>; erp_ext?: Record<string, unknown>; updated_at: string },
): SupplierSyncProfileResult {
  const localMs = Date.parse(local.updated_at ?? '')
  const reqMs = Date.parse(req.updated_at)
  if (!Number.isFinite(localMs) || !Number.isFinite(reqMs) || reqMs <= localMs) {
    return { applied: false }
  }
  const fields = req.fields ?? {}
  for (const key of Object.keys(fields)) {
    if (!(SUPPLIER_SYNC_PROFILE_FIELDS as readonly string[]).includes(key as (typeof SUPPLIER_SYNC_PROFILE_FIELDS)[number])) {
      return { applied: false, denied: true }
    }
  }
  const next: SupplierExtraInfo = { ...local }
  let changed = false
  for (const key of SUPPLIER_SYNC_PROFILE_FIELDS) {
    const raw = (fields as Record<string, unknown>)[key]
    if (raw === undefined) continue
    const trimmed = String(raw).trim()
    if (key === 'phone' && !trimmed) return { applied: false, denied: true }
    if (next[key] !== trimmed) {
      ;(next as Record<string, unknown>)[key] = trimmed
      changed = true
    }
  }
  if (req.erp_ext !== undefined) {
    next.erp_ext = req.erp_ext
    changed = true
  }
  if (!changed) return { applied: false }
  next.updated_at = new Date(reqMs).toISOString()
  return { applied: true, next }
}

export class SuppliersService {
  constructor(
    private workspace: WorkspaceService,
    private logger?: Logger,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  // —— 供应商档案（suppliers.json）读写 ——

  /** 读取供应商档案；文件缺失/损坏 → 空对象（与 loadCustomersInfo 同法） */
  async loadSuppliersInfo(ws?: string): Promise<Record<string, SupplierExtraInfo>> {
    const w = ws ?? this.requireWS()
    const store = await readJsonFile<Record<string, SupplierExtraInfo>>(suppliersInfoPath(w))
    return store ?? {}
  }

  async saveSuppliersInfo(ws: string, store: Record<string, SupplierExtraInfo>): Promise<void> {
    ensureWorkspaceDirs(ws)
    await overwriteJson(suppliersInfoPath(ws), store)
  }

  /**
   * 锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容，杜绝并发丢更新与「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateStore<R>(
    ws: string,
    mutate: (store: Record<string, SupplierExtraInfo>, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = suppliersInfoPath(ws)
    let changed = false
    const result = await mutateJsonFile<Record<string, SupplierExtraInfo>, R>(p, {
      read: async () => ({}), // 文件缺失按空档案起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v) =>
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SupplierExtraInfo>) : null,
    })
    return result
  }

  // —— 供应商 API（镜像 ClientsService，对照 workspace.ts 产品集段）——

  /** 供应商列表：目录扫描 供应商/<名> × suppliers.json 合并（文件数递归计数；按名称排序） */
  async list(): Promise<SupplierInfo[]> {
    const ws = this.requireWS()
    const dir = path.join(ws, SUPPLIERS_DIR)
    const extra = await this.loadSuppliersInfo()
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    const suppliers: SupplierInfo[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      const fileCount = await countFiles(path.join(dir, name))
      suppliers.push(await this.buildInfo(ws, name, fileCount, extra[name]))
    }
    suppliers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return suppliers
  }

  /** 新建供应商：名称校验 → 同名查重（既有目录或既有档案均拒绝）→ 建目录 + 固定子文件夹集 → suppliers.json 条目 */
  async create(req: SupplierCreateRequest): Promise<SupplierInfo> {
    const ws = this.requireWS()
    const name = assertSafeFolderName(req.name, '供应商名称')
    if (!name) throw new Error('名称不能为空')
    const dir = supplierRootPath(ws, name)
    try {
      await fsp.stat(dir)
      throw new Error('供应商已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '供应商已存在') throw err
    }
    // 关联产品集校验（镜像客户 create：拒绝不存在的产品集孤儿关联，v2.4.9 打磨 M8）
    if (req.related_product_sets) {
      for (const ps of req.related_product_sets) await this.assertProductSetExists(ps)
    }
    await fsp.mkdir(dir, { recursive: true })
    for (const sub of SUPPLIER_SUBFOLDERS) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true })
    }
    // v2.4.x：写目录操作失效索引快照（新建目录查询时按需重建，遵循失效约定）
    globalWorkspaceIndex.invalidate(dir)
    const now = currentTimeString()
    const entry: SupplierExtraInfo = {
      contact: req.contact?.trim(),
      phone: req.phone?.trim(),
      email: req.email?.trim(),
      address: req.address?.trim(),
      notes: (req.notes ?? '').trim(),
      tags: req.tags ?? [],
      related_product_sets: req.related_product_sets ?? [],
      created_at: now,
      updated_at: now,
    }
    // 档案写入走锁内事务：锁内再查重（既有档案重名/并发同建防御，目录被删但档案残留的冲突），写入基于最新磁盘内容
    const created = await this.mutateStore(ws, async (store, markChanged) => {
      if (store[name]) throw new Error('供应商已存在')
      store[name] = entry
      markChanged()
      return this.buildInfo(ws, name, 0, entry)
    })
    this.logger?.info(`供应商创建: ${name}`)
    return created
  }

  /**
   * 更新档案：contact/phone/email/address/notes/tags（未传字段保留原值）；updated_at 刷新。
   * API 面不含 erp_ext（本体物理不可写，v2.7 启禾 OS才写回）；读写时原样保留。
   */
  async update(req: SupplierUpdateRequest): Promise<SupplierInfo> {
    const ws = this.requireWS()
    const name = req.name.trim()
    if (!name) throw new Error('名称不能为空')
    const dir = supplierRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('供应商不存在')
    })
    const now = currentTimeString()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry = store[name] ?? {}
      if (req.contact !== undefined) entry.contact = req.contact.trim()
      if (req.phone !== undefined) entry.phone = req.phone.trim()
      if (req.email !== undefined) entry.email = req.email.trim()
      if (req.address !== undefined) entry.address = req.address.trim()
      if (req.notes !== undefined) entry.notes = req.notes.trim()
      if (req.tags !== undefined) entry.tags = req.tags
      // 关联产品集：去重 + 校验产品集存在（镜像客户 update，拒绝孤儿关联，v2.4.9 打磨 M8）
      if (req.related_product_sets !== undefined) {
        const list = [...new Set(req.related_product_sets)]
        for (const ps of list) await this.assertProductSetExists(ps)
        entry.related_product_sets = list
      }
      entry.created_at = entry.created_at ?? now
      entry.updated_at = now
      store[name] = entry
      markChanged()
      return this.buildInfo(ws, name, await countFiles(dir), entry)
    })
  }

  /**
   * 重命名供应商：目录迁移后 suppliers.json 条目键同步迁移（同客户 rename 先例 clients.ts:167）。
   * 有文件不可重命名（同 renameProductSet/renameCustomer 规则——metadata key 路径推导的代价，文案对齐）；
   * 新名与既有档案/目录冲突 → 拒绝。inbound.supplier_id 级联由 BoxService.renameSupplier 编排（本类不依赖 inbound）。
   */
  async rename(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    oldName = oldName.trim()
    newName = assertSafeFolderName(newName, '供应商名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return
    const oldDir = supplierRootPath(ws, oldName)
    const newDir = supplierRootPath(ws, newName)
    await fsp.stat(oldDir).catch(() => {
      throw new Error('供应商不存在')
    })
    try {
      await fsp.stat(newDir)
      throw new Error('新供应商已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '新供应商已存在') throw err
    }
    const hasFiles = await this.dirContainsFile(oldDir)
    if (hasFiles) {
      throw new Error('该供应商下已有文件，无法重命名。如需修改名称，请先删除文件或新建空供应商。')
    }
    await fsp.rename(oldDir, newDir)
    globalWorkspaceIndex.invalidate(oldDir)
    globalWorkspaceIndex.invalidate(newDir)
    // 档案键迁移（tags/notes/erp_ext 随条目整体移动；无条目时不写盘）；锁内档案残留重名防御
    await this.mutateStore(ws, async (store, markChanged) => {
      if (store[newName]) throw new Error('新供应商已存在')
      if (store[oldName]) {
        store[newName] = store[oldName]
        delete store[oldName]
        markChanged()
      }
    })
    this.logger?.info(`供应商重命名: ${oldName} → ${newName}`)
  }

  /** 关联产品集（related_product_sets 增；校验产品集存在，去重）——供应商侧是唯一写点，产品集侧只读反查留 v2.7（镜像客户 clients.ts:201） */
  async linkRelation(supplier: string, productSet: string): Promise<SupplierInfo> {
    const ws = this.requireWS()
    const name = supplier.trim()
    const dir = supplierRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('供应商不存在')
    })
    await this.assertProductSetExists(productSet)
    const ps = productSet.trim()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry = store[name] ?? {}
      const list = [...new Set([...(entry.related_product_sets ?? []), ps])]
      if (list.length === (entry.related_product_sets ?? []).length) {
        // 已关联（无变化）→ 不写盘、不刷 mtime
        return this.buildInfo(ws, name, await countFiles(dir), entry)
      }
      entry.related_product_sets = list
      entry.created_at = entry.created_at ?? currentTimeString()
      entry.updated_at = currentTimeString()
      store[name] = entry
      markChanged()
      return this.buildInfo(ws, name, await countFiles(dir), entry)
    })
  }

  /** 解除关联（related_product_sets 删；无档案条目/无关联时静默幂等，镜像客户 clients.ts:222） */
  async unlinkRelation(supplier: string, productSet: string): Promise<SupplierInfo> {
    const ws = this.requireWS()
    const name = supplier.trim()
    const dir = supplierRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('供应商不存在')
    })
    const ps = productSet.trim()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry = store[name]
      if (entry) {
        const next = (entry.related_product_sets ?? []).filter((x) => x !== ps)
        if (next.length !== (entry.related_product_sets ?? []).length) {
          entry.related_product_sets = next
          entry.updated_at = currentTimeString()
          store[name] = entry
          markChanged()
        }
      }
      return this.buildInfo(ws, name, await countFiles(dir), entry)
    })
  }

  // —— v2.5.4（弹一 C-1，云桥 M3）：supplier 能力域（镜像客户 customer 域）——

  /** 增量列表（since = updated_at 严大于 ms 过滤）；无 since → 全量 */
  async listSince(since?: string): Promise<SupplierInfo[]> {
    const all = await this.list()
    if (!since) return all
    const sinceMs = Date.parse(since)
    if (!Number.isFinite(sinceMs)) return all
    return all.filter((s) => {
      const ms = Date.parse(s.updated_at ?? '')
      return Number.isFinite(ms) && ms > sinceMs
    })
  }

  /** 单供应商档案（目录基准同客户 D8）：目录不存在 → null */
  async get(name: string): Promise<SupplierInfo | null> {
    const ws = this.requireWS()
    const n = name.trim()
    if (!n) return null
    const dir = supplierRootPath(ws, n)
    const ok = await fsp.stat(dir).then(() => true).catch(() => false)
    if (!ok) return null
    const extra = await this.loadSuppliersInfo()
    return this.buildInfo(ws, n, await countFiles(dir), extra[n])
  }

  /** 仅写 erp_ext 命名空间（整体替换，镜像客户 clients.writeErpExt）；目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → 供应商不存在 */
  async writeErpExt(name: string, ext: Record<string, unknown>): Promise<void> {
    const ws = this.requireWS()
    const n = name.trim()
    await this.assertSupplierDir(ws, n)
    const now = currentTimeString()
    await this.mutateStore(ws, async (store, markChanged) => {
      const entry: SupplierExtraInfo = store[n] ?? { created_at: now }
      entry.erp_ext = ext ?? {}
      entry.updated_at = currentTimeString()
      store[n] = entry
      markChanged()
    })
  }

  /**
   * 双向同步（D6 回显式乐观锁，镜像客户 syncProfile）：
   * req.updated_at ≤ 档案 updated_at → { applied:false }（host 层抛 STALE）；
   * 白名单外字段 → denied（host 层抛 FIELD_DENIED）；较新 → 仅写白名单差异字段 + erp_ext。
   */
  async syncProfile(req: {
    name: string
    fields?: Partial<Record<string, unknown>>
    erp_ext?: Record<string, unknown>
    updated_at: string
  }): Promise<{ applied: boolean }> {
    const ws = this.requireWS()
    const name = req.name.trim()
    if (!name) throw new Error('供应商名称不能为空')
    await this.assertSupplierDir(ws, name)
    const now = currentTimeString()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry: SupplierExtraInfo = store[name] ?? { created_at: now }
      const verdict = resolveSupplierSyncProfile(entry, req)
      if (!verdict.applied) {
        if (verdict.denied) throw new Error('syncProfile 含白名单外字段（box 权威字段不可由 ERP 写）')
        return { applied: false }
      }
      store[name] = verdict.next as SupplierExtraInfo
      markChanged()
      return { applied: true }
    })
  }

  private async assertSupplierDir(ws: string, name: string): Promise<void> {
    const ok = await fsp.stat(supplierRootPath(ws, name)).then(() => true).catch(() => false)
    if (!ok) throw new Error('供应商不存在')
  }

  /**
   * 彻底删除（purge）编排专用：移除 suppliers.json 条目。
   * 删除进回收站 / 恢复流程**不**调用——条目保留是「恢复即复原」的前提（目录扫描为实，JSON 为档案）。
   */
  async removeEntry(name: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, async (store, markChanged) => {
      if (!store[name]) return
      delete store[name]
      markChanged()
    })
  }

  /** 合并目录扫描与 JSON 档案，构造对外 SupplierInfo（created_at/updated_at 优先档案 ISO，缺省回退目录 mtime） */
  private async buildInfo(ws: string, name: string, fileCount: number, ex?: SupplierExtraInfo): Promise<SupplierInfo> {
    const info = ex ?? {}
    let fallback = ''
    try {
      fallback = new Date((await fsp.stat(supplierRootPath(ws, name))).mtime).toISOString()
    } catch {
      fallback = currentTimeString()
    }
    return {
      name,
      file_count: fileCount,
      contact: info.contact,
      phone: info.phone,
      email: info.email,
      address: info.address,
      notes: info.notes ?? '',
      tags: info.tags ?? [],
      related_product_sets: info.related_product_sets ?? [],
      erp_ext: info.erp_ext,
      created_at: info.created_at ?? fallback,
      updated_at: info.updated_at ?? fallback,
    }
  }

  private async assertProductSetExists(productSet: string): Promise<void> {
    const ws = this.requireWS()
    const ps = productSet.trim()
    if (!ps) throw new Error('产品集不能为空')
    const ok = await fsp.stat(productSetRootPath(ws, ps)).then(() => true).catch(() => false)
    if (!ok) throw new Error(`产品集「${ps}」不存在`)
  }

  private async dirContainsFile(dir: string): Promise<boolean> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (await this.dirContainsFile(path.join(dir, e.name))) return true
        } else {
          return true
        }
      }
    } catch {
      // 忽略
    }
    return false
  }
}
