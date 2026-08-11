/**
 * 客户维度（v2.4.7 §5.1）：客户/ 目录 + customers.json 档案
 * - 目录扫描为实，JSON 为档案（与 product_sets.json 同哲学）：客户名 = 目录名 = JSON key；
 *   目录不存在 = 客户不存在；删除走回收站时 JSON 条目保留（恢复即复原）
 * - 子文件夹默认集来自 config.customer_subfolders（旧 config 缺省由 loadConfig 合并默认值）
 * - erp_ext 为 v2.7 erp-bridge 预留命名空间：本体只读不校验、API 面不含入参
 *   （CustomerUpdateRequest 无此字段 → 物理不可写；读写档案时原样保留）
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
  writeJsonAtomic,
  readJsonFile,
  assertSafeFolderName,
  productSetRootPath,
} from './paths'
import { WorkspaceService, countFiles } from './workspace'
import { currentTimeString } from './metadata'
import { globalWorkspaceIndex } from './indexCache'
import type { CustomerInfo, CustomerExtraInfo, CustomerCreateRequest, CustomerUpdateRequest } from '../../shared/types'

export type { CustomerInfo, CustomerExtraInfo, CustomerCreateRequest, CustomerUpdateRequest } from '../../shared/types'

export class ClientsService {
  constructor(private workspace: WorkspaceService) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  // —— 客户档案（customers.json）读写 ——

  /** 读取客户档案；文件缺失/损坏 → 空对象（与 loadProductSetsInfo 同法） */
  async loadCustomersInfo(ws?: string): Promise<Record<string, CustomerExtraInfo>> {
    const w = ws ?? this.requireWS()
    const store = await readJsonFile<Record<string, CustomerExtraInfo>>(customersInfoPath(w))
    return store ?? {}
  }

  async saveCustomersInfo(ws: string, store: Record<string, CustomerExtraInfo>): Promise<void> {
    ensureWorkspaceDirs(ws)
    await writeJsonAtomic(customersInfoPath(ws), store)
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
      tags: req.tags ?? [],
      notes: (req.notes ?? '').trim(),
      related_product_sets: req.related_product_sets ?? [],
      created_at: now,
      updated_at: now,
    }
    const store = await this.loadCustomersInfo()
    store[name] = entry
    await this.saveCustomersInfo(ws, store)
    return this.buildInfo(ws, name, 0, entry)
  }

  /**
   * 更新档案：alias/country/contact/source + tags/notes + related_product_sets（未传字段保留原值）。
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
    const store = await this.loadCustomersInfo()
    const entry = store[name] ?? {}
    const now = currentTimeString()
    if (req.alias !== undefined) entry.alias = req.alias.trim()
    if (req.country !== undefined) entry.country = req.country.trim()
    if (req.contact !== undefined) entry.contact = req.contact.trim()
    if (req.source !== undefined) entry.source = req.source.trim()
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
    await this.saveCustomersInfo(ws, store)
    return this.buildInfo(ws, name, await countFiles(dir), entry)
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
    // 档案键迁移（tags/notes/关联/erp_ext 随条目整体移动）
    const store = await this.loadCustomersInfo()
    if (store[oldName]) {
      store[newName] = store[oldName]
      delete store[oldName]
      await this.saveCustomersInfo(ws, store)
    }
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
    const store = await this.loadCustomersInfo()
    const entry = store[name] ?? {}
    const ps = productSet.trim()
    const list = [...new Set([...(entry.related_product_sets ?? []), ps])]
    entry.related_product_sets = list
    entry.created_at = entry.created_at ?? currentTimeString()
    entry.updated_at = currentTimeString()
    store[name] = entry
    await this.saveCustomersInfo(ws, store)
    return this.buildInfo(ws, name, await countFiles(dir), entry)
  }

  /** 解除关联（related_product_sets 删；无档案条目/无关联时静默幂等） */
  async unlinkRelation(customer: string, productSet: string): Promise<CustomerInfo> {
    const ws = this.requireWS()
    const name = customer.trim()
    const dir = customerRootPath(ws, name)
    await fsp.stat(dir).catch(() => {
      throw new Error('客户不存在')
    })
    const store = await this.loadCustomersInfo()
    const entry = store[name]
    if (entry) {
      entry.related_product_sets = (entry.related_product_sets ?? []).filter((ps) => ps !== productSet.trim())
      entry.updated_at = currentTimeString()
      store[name] = entry
      await this.saveCustomersInfo(ws, store)
    }
    return this.buildInfo(ws, name, await countFiles(dir), entry)
  }

  /**
   * 彻底删除（purge）编排专用：移除 customers.json 条目。
   * 删除进回收站 / 恢复流程**不**调用——条目保留是「恢复即复原」的前提（目录扫描为实，JSON 为档案）。
   */
  async removeEntry(name: string): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadCustomersInfo()
    if (!store[name]) return
    delete store[name]
    await this.saveCustomersInfo(ws, store)
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
