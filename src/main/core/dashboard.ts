/**
 * 仪表盘统计（对照原 Go dashboard.go）
 * 纯 TS 业务层。
 *
 * v2.4.7（§4.3）：
 * - DashboardStats.total_customers（客户/ 一级目录数）
 * - invoiceTodos()：30 天内 due_date 且状态 ≠ 已入账的发票（due_date 升序）→ 仪表盘「发票待办」区块
 * - checkExpiringCerts key 判读规则（§4.1）：客户区 key 按工作区相对路径校验存在性 → 合同到期可提醒；
 *   发票/入库/交换区 key 不走本通道（发票待办走 invoices.json，§6.4）
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  CUSTOMERS_DIR,
  SUPPLIERS_DIR,
  INVOICES_DIR,
  INBOUND_DIR,
  EXCHANGE_DIR,
  invoicesPath,
  quotesPath,
  readJsonFile,
} from './paths'
import { WorkspaceService, countFiles, formatTime } from './workspace'
import { MetadataService, parseExpiryDate } from './metadata'
import { FilesService, FileEntry } from './files'
import type { DashboardStats, InvoiceRecord, QuoteRecord } from '../../shared/types'

export type { DashboardStats } from '../../shared/types'

/** §4.1 判读规则：结构化 key 的区域首段（产品集存量同名时「产品集优先」，见 checkExpiringCerts） */
const REGION_DIR_NAMES = new Set([CUSTOMERS_DIR, INVOICES_DIR, INBOUND_DIR, EXCHANGE_DIR])

export class DashboardService {
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
    private files: FilesService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /**
   * 检查 30 天内到期证书（对照 checkExpiringCerts）。
   * v2.4.2：
   * - C1：日期宽松解析（parseExpiryDate 兼容 YYYY/M/D、ISO 带时间等），非法日期记 warn 并跳过、不误伤其他
   * - C2：校验文件真实存在——已删除（回收站内）/外部删除的证书不再提醒（孤儿元数据不骚扰）
   * - P2：过期超过 30 天的证书不再按「即将到期」提醒
   */
  async checkExpiringCerts(): Promise<[string, string, string][]> {
    const ws = this.requireWS()
    const store = await this.metadata.loadMetadataStore()
    const now = Date.now()
    const upper = now + 30 * 24 * 60 * 60 * 1000
    const lower = now - 30 * 24 * 60 * 60 * 1000
    interface Row {
      ps: string
      file: string
      expiry: string
      filePath: string | null
    }
    const rows: Row[] = []
    let badDates = 0
    // v2.4.7（§4.1 判读规则）：首段是实存产品集目录 → 按产品集 key 解读（存量兼容优先）；
    // 否则首段命中区域名（客户/发票/入库/交换区）→ 按区域 key（工作区相对路径）解读
    const realSetNames = new Set<string>()
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const setEntries = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const e of setEntries) {
      if (e.isDirectory()) realSetNames.add(e.name)
    }
    for (const [key, meta] of Object.entries(store.files)) {
      if (!meta.expiry_date || !meta.expiry_date.trim()) continue
      const t = parseExpiryDate(meta.expiry_date)
      if (Number.isNaN(t.getTime())) {
        badDates++
        continue
      }
      const ms = t.getTime()
      if (ms > upper || ms < lower) continue
      // 新 key：产品集/图包|证书/子文件夹/文件名 或 区域 key（跨平台已统一 / 分隔符；兼容旧 \ key）
      const parts = key.replace(/\\/g, '/').split('/')
      const first = parts[0] ?? ''
      let ps = ''
      let file = ''
      let filePath: string | null = null
      if (!realSetNames.has(first) && REGION_DIR_NAMES.has(first)) {
        // 区域 key：整条 key 即工作区相对路径 → 直接按真实路径校验存在性；
        // 客户区（客户/<名>/<子文件夹>/<文件>）参与提醒（ps 槽位 = 客户名，合同到期可提醒）；
        // 发票/入库/交换区 key 不参与证书到期提醒（发票待办走 invoices.json，§6.4）
        if (first === CUSTOMERS_DIR) {
          ps = parts[1] ?? ''
          file = parts[parts.length - 1] ?? ''
          filePath = path.join(ws, ...parts)
        }
      } else if (parts.length === 4 && (parts[1] === IMAGES_DIR || parts[1] === CERTS_DIR)) {
        ps = parts[0]
        file = parts[3]
        filePath = path.join(ws, PRODUCT_SETS_DIR, parts[0], parts[1], parts[2], parts[3])
      } else {
        // 旧 key：产品集/文件名 → 产品集内查找真实位置（找不到 = 已删除/已移走）
        ps = parts[0] ?? ''
        file = parts[parts.length - 1] ?? ''
        if (ps && file) filePath = await this.findFileInProductSet(ws, ps, file)
      }
      if (ps && file) rows.push({ ps, file, expiry: meta.expiry_date, filePath })
    }
    if (badDates > 0) {
      console.warn(`[cert] ${badDates} 条证书到期日期无法解析，已跳过（可在元数据中重新填写）`)
    }
    // C2：文件不存在的条目（回收站内 / 外部删除 / 迁移后未匹配）不提醒
    // v2.5.2：全量并发 stat → 8 并发 worker（PERF-SOP §四「Promise.all 批量即嫌疑」，照渲染层探活先例）
    const alive: boolean[] = new Array(rows.length).fill(false)
    const queue = rows.map((_, i) => i)
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        const i = queue.shift()!
        const r = rows[i]
        if (!r.filePath) continue
        try {
          await fsp.stat(r.filePath)
          alive[i] = true
        } catch {
          alive[i] = false
        }
      }
    })
    await Promise.all(workers)
    const result: [string, string, string][] = []
    rows.forEach((r, i) => {
      if (alive[i]) result.push([r.ps, r.file, r.expiry])
    })
    result.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
    return result
  }

  /** 旧 key（产品集/文件名）在产品集 图包/证书 各子文件夹中查找同名文件（返回存在的第一个） */
  private async findFileInProductSet(ws: string, ps: string, file: string): Promise<string | null> {
    const setDir = path.join(ws, PRODUCT_SETS_DIR, ps)
    const candidates: string[] = []
    for (const type of [IMAGES_DIR, CERTS_DIR]) {
      const subs = await fsp.readdir(path.join(setDir, type), { withFileTypes: true }).catch(() => [])
      for (const s of subs) {
        if (!s.isDirectory()) continue
        candidates.push(path.join(setDir, type, s.name, file))
      }
    }
    for (const c of candidates) {
      if (await fsp.stat(c).then(() => true).catch(() => false)) return c
    }
    return null
  }

  async dashboardStats(): Promise<DashboardStats> {
    const ws = this.requireWS()
    const stats: DashboardStats = {
      total_product_sets: 0,
      total_images: 0,
      total_certs: 0,
      expiring_certs: 0,
      recent_files: [],
      // v2.4.7：客户数（客户/ 一级目录数；目录扫描为实，customers.json 为档案）
      total_customers: 0,
    }
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const entries = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [])
    stats.total_product_sets = entries.filter((e) => e.isDirectory()).length

    // v2.4.7：客户/ 一级目录数
    const customersDir = path.join(ws, CUSTOMERS_DIR)
    const customerEntries = await fsp.readdir(customersDir, { withFileTypes: true }).catch(() => [])
    stats.total_customers = customerEntries.filter((e) => e.isDirectory()).length

    // v2.4.9 打磨 M5：供应商/ 一级目录数（目录扫描为实，同 total_customers 口径——
    // 删除进回收站时目录移出 供应商/，仅按 suppliers.json 计数会把已回收供应商计入、与列表页矛盾）
    const suppliersDir = path.join(ws, SUPPLIERS_DIR)
    const supplierEntries = await fsp.readdir(suppliersDir, { withFileTypes: true }).catch(() => [])
    stats.total_suppliers = supplierEntries.filter((e) => e.isDirectory()).length

    // v2.4.9 打磨 M5：报价数 + 草稿报价数（报价.json 台账条目数；台账缺失/损坏按 0，仿 invoiceTodos 容错）
    const quotesStore = await readJsonFile<{ quotes?: Record<string, QuoteRecord> }>(quotesPath(ws))
    let totalQuotes = 0
    let draftQuotes = 0
    if (quotesStore && quotesStore.quotes && typeof quotesStore.quotes === 'object') {
      for (const rec of Object.values(quotesStore.quotes)) {
        totalQuotes++
        if (rec.status === '草稿') draftQuotes++
      }
    }
    stats.total_quotes = totalQuotes
    stats.draft_quotes = draftQuotes

    // v2.5.3（P1-4）：集间 8 并发扫描（照本文件 checkExpiringCerts 8 worker 先例）；每集内 图包/证书 两路 Promise.all 保留。
    // resolveThumb:false——recent_files 渲染层只消费 name/modified/size/path/file_type，thumbnail_path 零消费
    // （缩略图由渲染层按 file.path 经 IPC 按需取），免每文件 ~5 stat。
    const allFiles: FileEntry[] = []
    const setDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(setsDir, e.name))
    const queue = [...setDirs]
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        const setDir = queue.shift()!
        const [imgFiles, certFiles] = await Promise.all([
          this.files.listDirFilesRecursive(path.join(setDir, IMAGES_DIR), { resolveThumb: false }),
          this.files.listDirFilesRecursive(path.join(setDir, CERTS_DIR), { resolveThumb: false }),
        ])
        stats.total_images += imgFiles.length
        stats.total_certs += certFiles.length
        allFiles.push(...imgFiles, ...certFiles)
      }
    })
    await Promise.all(workers)
    allFiles.sort((a, b) => (a.modified > b.modified ? -1 : a.modified < b.modified ? 1 : 0))
    // v2.4.9（打磨）：最近文件 10 → 5 条——用户反馈列表太长，仪表盘只保留近期热点，完整列表走「查看全部」
    stats.recent_files = allFiles.slice(0, 5)

    // v2.5.3（P1-4）：expiring_certs 渲染层零消费，到期检查由独立 IPC 通道（前端并行调用 checkExpiringCerts）承担；
    // 契约字段保留，恒 0（避免 dashboardStats 内嵌重跑同一份全量扫描）
    stats.expiring_certs = 0
    return stats
  }

  /**
   * v2.4.7（§4.3）：发票待办——30 天内 due_date 且状态 ≠ 已入账的发票，due_date 升序。
   * 窗口口径与 checkExpiringCerts 对称：due_date ∈ [now-30d, now+30d]（过期未处理仍提醒，
   * 未来超过 30 天不提醒）；已入账（无论是否到期）一律排除。非法日期跳过（台账写入端已归一化）。
   * 供仪表盘「发票待办」区块与系统通知合并（§6.4）使用。
   */
  async invoiceTodos(): Promise<InvoiceRecord[]> {
    const ws = this.requireWS()
    const store = await readJsonFile<{ invoices?: Record<string, InvoiceRecord> }>(invoicesPath(ws))
    if (!store || !store.invoices) return []
    const now = Date.now()
    const windowMs = 30 * 24 * 60 * 60 * 1000
    const out: InvoiceRecord[] = []
    for (const rec of Object.values(store.invoices)) {
      if (!rec.due_date || rec.status === '已入账') continue
      const t = parseExpiryDate(rec.due_date)
      if (Number.isNaN(t.getTime())) continue
      const ms = t.getTime()
      if (ms > now + windowMs || ms < now - windowMs) continue
      out.push(rec)
    }
    out.sort((a, b) => (a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : 0))
    return out
  }
}
