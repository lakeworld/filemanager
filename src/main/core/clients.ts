/**
 * 客户维度（v2.4.7 §5.1）：客户/ 目录 + customers.json 档案
 * - 目录扫描为实，JSON 为档案（与 product_sets.json 同哲学）：客户名 = 目录名 = JSON key；
 *   目录不存在 = 客户不存在；删除走回收站时 JSON 条目保留（恢复即复原）
 * - 子文件夹默认集来自 config.customer_subfolders（旧 config 缺省由 loadConfig 合并默认值）
 * - erp_ext 为 v2.7 erp-bridge 预留命名空间：本体只读不校验、API 面不含入参
 *   （CustomerUpdateRequest 无此字段 → 物理不可写；读写档案时原样保留）
 * - v2.5.1（A1，PLAN-v2.6-v2.7 §3.1）：customers 能力域实装——writeErpExt / syncProfile
 *   （resolveSyncProfile 纯函数，D6 记录级裁决 + D7 tags 归属 + D8 目录基准）
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  customersInfoPath,
  customerRootPath,
  CUSTOMERS_DIR,
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
import type { CustomerInfo, CustomerExtraInfo, CustomerCreateRequest, CustomerUpdateRequest } from '../../shared/types'

export type { CustomerInfo, CustomerExtraInfo, CustomerCreateRequest, CustomerUpdateRequest } from '../../shared/types'

// —— v2.5.1（A1，D6/D7）：syncProfile 记录级裁决纯函数 ——

/** syncProfile 可写白名单（本体对齐字段）：box 权威字段（alias/country/contact/source/related_product_sets/tags）拒绝 */
const SYNC_PROFILE_FIELDS = ['type', 'contact', 'phone', 'email', 'address', 'notes'] as const

export interface SyncProfileResult {
  applied: boolean
  /** 白名单外字段入参（或空白 phone）→ 拒绝，host 层据此抛 FIELD_DENIED */
  denied?: boolean
  /** applied 时的新档案（供 host 层写回） */
  next?: CustomerExtraInfo
}

/**
 * D6 记录级裁决纯函数：req.updated_at ≤ 档案 updated_at → STALE（不写）；
 * 较新 → 仅合并白名单差异字段 + erp_ext；白名单外字段入参 → denied。
 * Date.parse 归一化为毫秒（仓迹 PB 空格格式兼容）；非法时间 → STALE。
 */
export function resolveSyncProfile(
  local: CustomerExtraInfo,
  req: { fields?: Partial<Record<string, unknown>>; erp_ext?: Record<string, unknown>; updated_at: string },
): SyncProfileResult {
  const localMs = Date.parse(local.updated_at ?? '')
  const reqMs = Date.parse(req.updated_at)
  if (!Number.isFinite(localMs) || !Number.isFinite(reqMs) || reqMs <= localMs) {
    return { applied: false }
  }
  const fields = req.fields ?? {}
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) {
      if (!(SYNC_PROFILE_FIELDS as readonly string[]).includes(key as (typeof SYNC_PROFILE_FIELDS)[number])) {
        return { applied: false, denied: true }
      }
    }
  }
  const next: CustomerExtraInfo = { ...local }
  let changed = false
  if (fields && typeof fields === 'object') {
    for (const key of SYNC_PROFILE_FIELDS) {
      const raw = (fields as Record<string, unknown>)[key]
      if (raw === undefined) continue
      if (key === 'type') {
        if (raw !== '企业' && raw !== '个人') return { applied: false, denied: true }
        if (next.type !== raw) {
          next.type = raw
          changed = true
        }
        continue
      }
      const trimmed = String(raw).trim()
      if (key === 'phone' && !trimmed) return { applied: false, denied: true }
      if (next[key] !== trimmed) {
        ;(next as Record<string, unknown>)[key] = trimmed
        changed = true
      }
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

export class ClientsService {
  constructor(private workspace: WorkspaceService) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  // —— 客户档案（customers.json）读写 ——

  /** type 枚举校验：缺省合法；非「企业/个人」拒绝（create/update 两入口共用，v2.4.9 S1） */
  private assertCustomerType(type: '企业' | '个人' | undefined): void {
    if (type !== undefined && type !== '企业' && type !== '个人') {
      throw new Error('客户类型只能是「企业」或「个人」')
    }
  }

  /** 读取客户档案；文件缺失/损坏 → 空对象（与 loadProductSetsInfo 同法） */
  async loadCustomersInfo(ws?: string): Promise<Record<string, CustomerExtraInfo>> {
    const w = ws ?? this.requireWS()
    const store = await readJsonFile<Record<string, CustomerExtraInfo>>(customersInfoPath(w))
    return store ?? {}
  }

  async saveCustomersInfo(ws: string, store: Record<string, CustomerExtraInfo>): Promise<void> {
    ensureWorkspaceDirs(ws)
    await overwriteJson(customersInfoPath(ws), store)
  }

  /**
   * 锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容，杜绝并发丢更新与「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateStore<R>(
    ws: string,
    mutate: (store: Record<string, CustomerExtraInfo>, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = customersInfoPath(ws)
    let changed = false
    const result = await mutateJsonFile<Record<string, CustomerExtraInfo>, R>(p, {
      read: async () => ({}), // 文件缺失按空档案起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v) =>
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, CustomerExtraInfo>) : null,
    })
    return result
  }

  /**
   * 锁内增量读改写（v2.5.3 找bug打磨轮 P1-3）：供 index.ts 客户标签引用源等外部服务使用。
   * mutate 返回是否发生变更（true 才落盘、不刷 mtime）——杜绝「锁外读旧快照 + 整档替换」的丢失更新窗口。
   */
  async mutateCustomers(ws: string, mutate: (store: Record<string, CustomerExtraInfo>) => Promise<boolean> | boolean): Promise<void> {
    await this.mutateStore(ws, async (store, markChanged) => {
      if (await mutate(store)) markChanged()
    })
  }

  // —— 客户 API（对照 workspace.ts 产品集段）——

  /** 客户列表：目录扫描 客户/<名> × customers.json 合并（文件数递归计数；按名称排序） */
  async list(): Promise<CustomerInfo[]> {
    const ws = this.requireWS()
    const dir = path.join(ws, CUSTOMERS_DIR)
    const extra = await this.loadCustomersInfo()
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    const customers: CustomerInfo[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      const fileCount = await countFiles(path.join(dir, name))
      customers.push(await this.buildInfo(ws, name, fileCount, extra[name]))
    }
    customers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return customers
  }

  /** 增量列表（v2.5.1 A1，host.customer.list）：since = updated_at 严大于过滤（ISO 串，Date.parse 归一化），缺省全量 */
  async listSince(since?: string): Promise<CustomerInfo[]> {
    const all = await this.list()
    if (!since) return all
    const sinceMs = Date.parse(since)
    if (!Number.isFinite(sinceMs)) return all
    return all.filter((c) => {
      const ms = Date.parse(c.updated_at ?? '')
      return Number.isFinite(ms) && ms > sinceMs
    })
  }

  /** 单客户档案（v2.5.1 A1，host.customer.get）：目录不存在（D8 目录基准）→ null */
  async get(name: string): Promise<CustomerInfo | null> {
    const ws = this.requireWS()
    const n = name.trim()
    if (!n) return null
    const dir = customerRootPath(ws, n)
    const ok = await fsp.stat(dir).then(() => true).catch(() => false)
    if (!ok) return null
    const extra = await this.loadCustomersInfo()
    return this.buildInfo(ws, n, await countFiles(dir), extra[n])
  }

  /** 新建客户：名称校验 → 建目录 + 默认子文件夹（config.customer_subfolders）→ customers.json 条目 */
  async create(req: CustomerCreateRequest): Promise<CustomerInfo> {
    const ws = this.requireWS()
    const name = assertSafeFolderName(req.name, '客户名称')
    if (!name) throw new Error('名称不能为空')
    const dir = customerRootPath(ws, name)
    try {
      await fsp.stat(dir)
      throw new Error('客户已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '客户已存在') throw err
    }
    if (req.related_product_sets) {
      for (const ps of req.related_product_sets) await this.assertProductSetExists(ps)
    }
    this.assertCustomerType(req.type)
    const cfg = await this.workspace.loadConfig()
    await fsp.mkdir(dir, { recursive: true })
    for (const sub of cfg.customer_subfolders ?? []) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true })
    }
    // v2.4.x：写目录操作失效索引快照（新建目录查询时按需重建，遵循失效约定）
    globalWorkspaceIndex.invalidate(dir)
    const now = currentTimeString()
    const entry: CustomerExtraInfo = {
      alias: req.alias?.trim(),
      country: req.country?.trim(),
      contact: req.contact?.trim(),
      source: req.source?.trim(),
      type: req.type,
      phone: req.phone?.trim(),
      email: req.email?.trim(),
      address: req.address?.trim(),
      tags: req.tags ?? [],
      notes: (req.notes ?? '').trim(),
      related_product_sets: req.related_product_sets ?? [],
      created_at: now,
      updated_at: now,
    }
    // 档案写入走锁内事务：锁内再查重（防并发同建），写入基于最新磁盘内容
    return this.mutateStore(ws, async (store, markChanged) => {
      if (store[name]) throw new Error('客户已存在')
      store[name] = entry
      markChanged()
      return this.buildInfo(ws, name, 0, entry)
    })
  }

  /**
   * 更新档案：alias/country/contact/source + type/phone/email/address + tags/notes + related_product_sets
   * （未传字段保留原值；type 枚举校验，非「企业/个人」拒绝，v2.4.9 S1）。
   * API 面不含 erp_ext（本体物理不可写，v2.7 erp-bridge 才写回）；读写时原样保留；updated_at 刷新。
   */
  async update(req: CustomerUpdateRequest): Promise<CustomerInfo> {
    const ws = this.requireWS()
    const name = req.name.trim()
    if (!name) throw new Error('名称不能为空')
    const dir = customerRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('客户不存在')
    })
    this.assertCustomerType(req.type)
    const now = currentTimeString()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry = store[name] ?? {}
      if (req.alias !== undefined) entry.alias = req.alias.trim()
      if (req.country !== undefined) entry.country = req.country.trim()
      if (req.contact !== undefined) entry.contact = req.contact.trim()
      if (req.source !== undefined) entry.source = req.source.trim()
      if (req.type !== undefined) entry.type = req.type
      if (req.phone !== undefined) entry.phone = req.phone.trim()
      if (req.email !== undefined) entry.email = req.email.trim()
      if (req.address !== undefined) entry.address = req.address.trim()
      if (req.tags !== undefined) entry.tags = req.tags
      if (req.notes !== undefined) entry.notes = req.notes.trim()
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
   * 重命名客户：有文件不可重命名（同 renameProductSet 规则——metadata key 路径推导的代价，文案对齐）；
   * 目录迁移后 customers.json 条目键同步迁移。
   */
  async rename(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    oldName = oldName.trim()
    newName = assertSafeFolderName(newName, '客户名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return
    const oldDir = customerRootPath(ws, oldName)
    const newDir = customerRootPath(ws, newName)
    await fsp.stat(oldDir).catch(() => {
      throw new Error('客户不存在')
    })
    try {
      await fsp.stat(newDir)
      throw new Error('新客户已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '新客户已存在') throw err
    }
    const hasFiles = await this.dirContainsFile(oldDir)
    if (hasFiles) {
      throw new Error('该客户下已有文件，无法重命名。如需修改名称，请先删除文件或新建空客户。')
    }
    await fsp.rename(oldDir, newDir)
    globalWorkspaceIndex.invalidate(oldDir)
    globalWorkspaceIndex.invalidate(newDir)
    // 档案键迁移（tags/notes/关联/erp_ext 随条目整体移动；无条目时不写盘）
    await this.mutateStore(ws, async (store, markChanged) => {
      if (store[newName]) throw new Error('新客户已存在')
      if (store[oldName]) {
        store[newName] = store[oldName]
        delete store[oldName]
        markChanged()
      }
    })
  }

  /** 关联产品集（related_product_sets 增；校验产品集存在，去重）——客户侧是唯一写点，产品集侧只读反查 */
  async linkRelation(customer: string, productSet: string): Promise<CustomerInfo> {
    const ws = this.requireWS()
    const name = customer.trim()
    const dir = customerRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('客户不存在')
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

  /** 解除关联（related_product_sets 删；无档案条目/无关联时静默幂等） */
  async unlinkRelation(customer: string, productSet: string): Promise<CustomerInfo> {
    const ws = this.requireWS()
    const name = customer.trim()
    const dir = customerRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('客户不存在')
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

  /**
   * 彻底删除（purge）编排专用：移除 customers.json 条目。
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

  // —— v2.5.1（A1，PLAN-v2.6-v2.7 §3.1）：customers 能力域写路径（host.customer.* 的 core 委托）——

  /** 目录基准（D8）：目录不存在 → 抛「客户不存在」（NOT_FOUND 由 host 层映射） */
  private async assertCustomerDir(ws: string, name: string): Promise<string> {
    const dir = customerRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('客户不存在')
    })
    return dir
  }

  /**
   * writeErpExt：仅写 erp_ext 命名空间（整体替换）。
   * D8 目录基准：目录有而 JSON 无条目 → 补最小条目后写；目录亦无 → NOT_FOUND。
   */
  async writeErpExt(name: string, ext: Record<string, unknown>): Promise<void> {
    const ws = this.requireWS()
    const n = name.trim()
    await this.assertCustomerDir(ws, n)
    const now = currentTimeString()
    await this.mutateStore(ws, async (store, markChanged) => {
      const entry: CustomerExtraInfo = store[n] ?? { created_at: now }
      entry.erp_ext = ext ?? {}
      entry.updated_at = currentTimeString()
      store[n] = entry
      markChanged()
    })
  }

  /**
   * syncProfile：双向同步（D6 回显式乐观锁）。
   * req.updated_at ≤ 档案 updated_at → 返回 { applied:false }（host 层抛 STALE）；
   * 白名单外字段 → 返回 { applied:false, denied:true }（host 层抛 FIELD_DENIED）；
   * 较新 → 仅写白名单差异字段 + erp_ext，updated_at 回填。
   */
  async syncProfile(req: {
    name: string
    fields?: Partial<Record<string, unknown>>
    erp_ext?: Record<string, unknown>
    updated_at: string
  }): Promise<{ applied: boolean }> {
    const ws = this.requireWS()
    const name = req.name.trim()
    if (!name) throw new Error('客户名称不能为空')
    await this.assertCustomerDir(ws, name)
    const now = currentTimeString()
    return this.mutateStore(ws, async (store, markChanged) => {
      const entry: CustomerExtraInfo = store[name] ?? { created_at: now }
      const verdict = resolveSyncProfile(entry, req)
      if (!verdict.applied) {
        if (verdict.denied) throw new Error('syncProfile 含白名单外字段（box 权威字段不可由 ERP 写）')
        return { applied: false }
      }
      store[name] = verdict.next as CustomerExtraInfo
      markChanged()
      return { applied: true }
    })
  }

  /** 合并目录扫描与 JSON 档案，构造对外 CustomerInfo（created_at/updated_at 优先档案 ISO，缺省回退目录 mtime） */
  private async buildInfo(ws: string, name: string, fileCount: number, ex?: CustomerExtraInfo): Promise<CustomerInfo> {
    const info = ex ?? {}
    let fallback = ''
    try {
      fallback = new Date((await fsp.stat(customerRootPath(ws, name))).mtime).toISOString()
    } catch {
      fallback = currentTimeString()
    }
    return {
      name,
      file_count: fileCount,
      alias: info.alias,
      country: info.country,
      contact: info.contact,
      source: info.source,
      type: info.type,
      phone: info.phone,
      email: info.email,
      address: info.address,
      tags: info.tags ?? [],
      notes: info.notes ?? '',
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
