/**
 * 发票台账（v2.4.7，PLAN §6）：invoices.json 台账 + 查重 + 状态流转 + 文件归档 + Excel 导出
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 数据：<ws>/.qihefilemanager/invoices.json
 *   { "invoices": Record<发票号码, InvoiceRecord> }；发票号码 = 查重主键 = key
 *
 * 账物分离（PLAN §3.3）：台账记录是归档文件的索引——删除记录不删文件（可勾选同时删除，
 * 文件走回收站 file 单条目）；文件被删/被回收时记录保留，file_path 校验失效由 UI 灰显，不级联删记录。
 * 台账区域（发票/）只经 archiveFile（台账归档）与交换区受控写入，账物一致；应用 UI 不提供通用导入。
 * 查重口径（PLAN §6.2）：创建/编辑/交换区三入口同走 checkNumber，命中即拒绝并提示已有记录摘要，
 * 不提供「强制继续」——重复报销拦截正是功能价值。
 * 内存纪律：台账量级（千内）页内内存过滤，不建索引、不引缓存、无常驻定时器。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  INVOICES_DIR,
  invoiceRootPath,
  invoicesPath,
  ensureWorkspaceDirs,
  readJsonFile,
  isPathInsideWorkspaceReal,
} from './paths'
import { mutateJsonFile } from './jsonStore'
import { WorkspaceService } from './workspace'
import { normalizeExpiryDate, parseExpiryDate, currentTimeString } from './metadata'
import { TrashService } from './trash'
import { XlsxService } from './xlsx'
import { resolveConflictName, composeTargetName, sanitizeName } from './naming'
import type { ImportContext } from './naming'
import { globalWorkspaceIndex } from './indexCache'
import type { InvoiceRecord } from '../../shared/types'

export type { InvoiceRecord } from '../../shared/types'

/** 状态枚举（自由流转，允许纠正误操作；无审批流、无规则引擎，红线 §一） */
export const INVOICE_STATUSES = ['待报销', '已报销', '已入账'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/** 新建请求（API 面不含 ocr_ext——本体物理不可写，v2.7 OCR 插件才写回） */
export interface InvoiceCreateRequest {
  number: string
  code?: string
  date: string
  amount: number
  seller: string
  buyer: string
  status: InvoiceStatus
  customer?: string
  due_date?: string
  /** 归档文件：工作区绝对路径或 发票/<YYYY>/ 相对路径（/ 分隔），须位于 发票/ 区且真实存在 */
  file_path: string
  tags?: string[]
  notes?: string
}

/** 编辑请求：number = 原号码（记录标识，必须存在）；newNumber 省略 = 号码不变 */
export interface InvoiceUpdateRequest {
  number: string
  newNumber?: string
  code?: string
  date?: string
  amount?: number
  seller?: string
  buyer?: string
  status?: InvoiceStatus
  customer?: string
  due_date?: string
  file_path?: string
  tags?: string[]
  notes?: string
}

/** 台账列表过滤（页内内存过滤，台账量级千内不建索引） */
export interface InvoiceListFilter {
  status?: InvoiceStatus
  customer?: string
  /** 仅待办：due_date 落在 30 天窗口内（含已过期 30 天内）且状态 ≠ 已入账 */
  dueSoonOnly?: boolean
  /** 号码 / 开票方 / 购买方 子串搜索 */
  query?: string
}

interface InvoicesStore {
  invoices: Record<string, InvoiceRecord>
}

/** 待办窗口 = 距今 30 天（含已过期 30 天内），与证书到期提醒窗口同法（dashboard.checkExpiringCerts） */
const DUE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** 记录是否落在待办窗口（due_date 可解析且状态 ≠ 已入账；解析失败不提醒，宽容处理） */
function isDueSoon(rec: InvoiceRecord, now = Date.now()): boolean {
  if (rec.status === '已入账' || !rec.due_date) return false
  const t = parseExpiryDate(rec.due_date)
  if (Number.isNaN(t.getTime())) return false
  const ms = t.getTime()
  return ms >= now - DUE_WINDOW_MS && ms <= now + DUE_WINDOW_MS
}

export class InvoicesService {
  constructor(
    private workspace: WorkspaceService,
    private trash: TrashService,
    private xlsx: XlsxService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /** 读取台账（只读/宽容降级）；文件缺失/损坏（结构非法）视为空台账 */
  private async loadStore(ws?: string): Promise<InvoicesStore> {
    const w = ws ?? this.requireWS()
    const data = await readJsonFile<InvoicesStore>(invoicesPath(w))
    return data && data.invoices && typeof data.invoices === 'object' ? data : { invoices: {} }
  }

  /**
   * 锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容，杜绝并发丢更新与「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateStore<R>(
    ws: string,
    mutate: (store: InvoicesStore, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = invoicesPath(ws)
    let changed = false
    const result = await mutateJsonFile<InvoicesStore, R>(p, {
      read: async () => ({ invoices: {} }), // 文件缺失按空台账起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v): InvoicesStore | null =>
        v && typeof v === 'object' && !Array.isArray(v) && (v as InvoicesStore).invoices &&
        typeof (v as InvoicesStore).invoices === 'object'
          ? (v as InvoicesStore)
          : null,
    })
    return result
  }

  private assertStatus(status: unknown): asserts status is InvoiceStatus {
    if (!INVOICE_STATUSES.includes(status as InvoiceStatus)) {
      throw new Error('状态无效（应为 待报销 / 已报销 / 已入账）')
    }
  }

  /** 查重命中摘要（PLAN §6.2：提示已有记录概要，不提供「强制继续」） */
  private duplicateError(existing: InvoiceRecord): Error {
    return new Error(
      `发票号码 ${existing.number} 已存在（状态：${existing.status}，日期：${existing.date}，文件：${existing.file_path}）`,
    )
  }

  /**
   * 查重（创建 / 编辑 / 交换区三入口共用口径；创建/编辑事务内部以锁内 store 直接查重，本函数供
   * UI 预检与交换区等场景显式按工作区查询）：命中返回已有记录（供摘要提示），未命中返回 null。
   * excludeNumber：编辑换号时排除自身号码。ws 可选注入——传入时按捕获工作区查，不回读 current workspace。
   */
  async checkNumber(number: string, excludeNumber?: string, ws?: string): Promise<InvoiceRecord | null> {
    const n = (number ?? '').trim()
    if (!n) throw new Error('发票号码不能为空')
    if (excludeNumber && n === (excludeNumber ?? '').trim()) return null
    const store = await this.loadStore(ws)
    return store.invoices[n] ?? null
  }

  /**
   * 归档文件解析：接受工作区绝对路径或 发票/<YYYY>/ 相对路径（/ 分隔）。
   * 账物一致：台账 file_path 必须指向 发票/ 区（只经台账归档与交换区写入）且文件真实存在。
   * 返回规范化相对路径（/ 分隔）。
   */
  private async resolveArchivedFilePath(ws: string, filePath: string): Promise<string> {
    const normalized = filePath.replace(/\\/g, '/')
    if (!normalized) throw new Error('请选择发票文件')
    const abs = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.join(ws, ...normalized.split('/').filter(Boolean))
    if (!(await isPathInsideWorkspaceReal(ws, abs))) throw new Error('发票文件必须位于工作区内')
    const rel = path.relative(path.resolve(ws), path.resolve(abs))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('发票文件必须位于工作区内')
    const norm = rel.split(path.sep).join('/')
    if (!norm.startsWith(`${INVOICES_DIR}/`)) throw new Error('发票文件必须归档在 发票/ 目录下')
    if (!(await fsp.stat(abs).then((s) => s.isFile()).catch(() => false))) throw new Error('发票文件不存在')
    return norm
  }

  /**
   * 台账列表：内存过滤（状态 / 客户 / 待办窗口 / 号码·开票方·购买方子串搜索），
   * 按开票日期降序（同日按号码升序）。返回记录副本，防调用方污染 store。
   */
  async list(filter?: InvoiceListFilter): Promise<InvoiceRecord[]> {
    const store = await this.loadStore()
    let out = Object.values(store.invoices).map((r) => ({ ...r }))
    if (filter) {
      if (filter.status) out = out.filter((r) => r.status === filter.status)
      if (filter.customer) out = out.filter((r) => r.customer === filter.customer)
      if (filter.dueSoonOnly) out = out.filter((r) => isDueSoon(r))
      const q = (filter.query ?? '').trim().toLowerCase()
      if (q) out = out.filter((r) => [r.number, r.seller, r.buyer].some((v) => v.toLowerCase().includes(q)))
    }
    out.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.number < b.number ? -1 : a.number > b.number ? 1 : 0,
    )
    return out
  }

  /**
   * 新建台账记录：必填校验 + 查重 + 日期归一化。
   * v2.5.3（T6）：ws 可选注入——传入捕获工作区时，全程只写该工作区（查重/写入均在锁内基于该 ws
   * 的磁盘内容完成，绝不在中途回读 current workspace）。缺省走当前工作区。
   */
  async create(req: InvoiceCreateRequest, ws?: string): Promise<InvoiceRecord> {
    const w = ws ?? this.requireWS()
    const number = (req.number ?? '').trim()
    if (!number) throw new Error('发票号码不能为空')
    if (!req.file_path || !req.file_path.trim()) throw new Error('请选择发票文件')
    const date = normalizeExpiryDate((req.date ?? '').trim())
    if (!date) throw new Error('开票日期无效（应为 YYYY-MM-DD 或可解析的日期）')
    if (typeof req.amount !== 'number' || !Number.isFinite(req.amount)) throw new Error('金额无效')
    const seller = (req.seller ?? '').trim()
    if (!seller) throw new Error('开票方不能为空')
    const buyer = (req.buyer ?? '').trim()
    if (!buyer) throw new Error('购买方不能为空')
    this.assertStatus(req.status)
    const filePath = await this.resolveArchivedFilePath(w, req.file_path)

    const now = currentTimeString()
    const rec: InvoiceRecord = {
      number,
      date,
      amount: req.amount,
      seller,
      buyer,
      status: req.status,
      file_path: filePath,
      created_at: now,
      updated_at: now,
    }
    if ((req.code ?? '').trim()) rec.code = (req.code ?? '').trim()
    if ((req.customer ?? '').trim()) rec.customer = (req.customer ?? '').trim()
    if ((req.due_date ?? '').trim()) rec.due_date = (req.due_date ?? '').trim()
    if (req.tags && req.tags.length > 0) rec.tags = [...new Set(req.tags)]
    if ((req.notes ?? '').trim()) rec.notes = (req.notes ?? '').trim()

    // 查重 + 写入同在锁内（基于 w 的磁盘最新内容；显式 ws 时与 current workspace 无关）
    return this.mutateStore(w, (store, markChanged) => {
      const existing = store.invoices[number]
      if (existing) throw this.duplicateError(existing)
      store.invoices[number] = rec
      markChanged()
      return { ...rec }
    })
  }

  /** 编辑台账记录：同查重（换号时排除自身号码）；换绑文件经 resolveArchivedFilePath 校验 */
  async update(req: InvoiceUpdateRequest): Promise<InvoiceRecord> {
    const ws = this.requireWS()
    const number = (req.number ?? '').trim()
    if (!number) throw new Error('发票号码不能为空')
    const targetNumber = req.newNumber === undefined ? number : (req.newNumber ?? '').trim()
    if (!targetNumber) throw new Error('发票号码不能为空')
    // 换绑文件：fs 校验（工作区边界/存在性）锁外完成，store 无关
    let newFilePath: string | undefined
    if (req.file_path !== undefined && (req.file_path ?? '').trim()) {
      newFilePath = await this.resolveArchivedFilePath(ws, req.file_path)
    }

    return this.mutateStore(ws, (store, markChanged) => {
      const existing = store.invoices[number]
      if (!existing) throw new Error('发票不存在')
      if (targetNumber !== number) {
        const conflict = store.invoices[targetNumber]
        if (conflict) throw this.duplicateError(conflict)
      }

      const rec: InvoiceRecord = { ...existing, number: targetNumber }
      if (req.date !== undefined) {
        const d = normalizeExpiryDate((req.date ?? '').trim())
        if (!d) throw new Error('开票日期无效（应为 YYYY-MM-DD 或可解析的日期）')
        rec.date = d
      }
      if (req.amount !== undefined) {
        if (typeof req.amount !== 'number' || !Number.isFinite(req.amount)) throw new Error('金额无效')
        rec.amount = req.amount
      }
      if (req.seller !== undefined) {
        const v = (req.seller ?? '').trim()
        if (!v) throw new Error('开票方不能为空')
        rec.seller = v
      }
      if (req.buyer !== undefined) {
        const v = (req.buyer ?? '').trim()
        if (!v) throw new Error('购买方不能为空')
        rec.buyer = v
      }
      if (req.status !== undefined) {
        this.assertStatus(req.status)
        rec.status = req.status
      }
      if (req.code !== undefined) {
        const v = (req.code ?? '').trim()
        if (v) rec.code = v
        else delete rec.code
      }
      if (req.customer !== undefined) {
        const v = (req.customer ?? '').trim()
        if (v) rec.customer = v
        else delete rec.customer
      }
      if (req.due_date !== undefined) {
        const v = (req.due_date ?? '').trim()
        if (v) rec.due_date = v
        else delete rec.due_date
      }
      if (newFilePath !== undefined) rec.file_path = newFilePath
      if (req.tags !== undefined) {
        if (req.tags.length > 0) rec.tags = [...new Set(req.tags)]
        else delete rec.tags
      }
      if (req.notes !== undefined) {
        const v = (req.notes ?? '').trim()
        if (v) rec.notes = v
        else delete rec.notes
      }
      rec.updated_at = currentTimeString()

      if (targetNumber !== number) delete store.invoices[number]
      store.invoices[targetNumber] = rec
      markChanged()
      return { ...rec }
    })
  }

  /** 状态流转（UI 行内流转与回退均走此单入口）：枚举校验 + updated_at 刷新 */
  async setStatus(number: string, status: InvoiceStatus): Promise<InvoiceRecord> {
    const ws = this.requireWS()
    this.assertStatus(status)
    const n = (number ?? '').trim()
    if (!n) throw new Error('发票号码不能为空')
    return this.mutateStore(ws, (store, markChanged) => {
      const rec = store.invoices[n]
      if (!rec) throw new Error('发票不存在')
      rec.status = status
      rec.updated_at = currentTimeString()
      markChanged()
      return { ...rec }
    })
  }

  /**
   * 删除台账记录（账物分离）：默认不删文件；deleteFile 时文件走回收站（file 单条目），
   * 文件缺失/越界则静默跳过文件部分——记录删除是主操作，不因文件状态受阻。
   */
  async remove(number: string, opts?: { deleteFile?: boolean }): Promise<void> {
    const ws = this.requireWS()
    const n = (number ?? '').trim()
    if (!n) throw new Error('发票号码不能为空')
    await this.mutateStore(ws, async (store, markChanged) => {
      const rec = store.invoices[n]
      if (!rec) throw new Error('发票不存在')
      delete store.invoices[n]
      markChanged()

      if (opts?.deleteFile) {
        const abs = path.isAbsolute(rec.file_path)
          ? rec.file_path
          : path.join(ws, ...rec.file_path.replace(/\\/g, '/').split('/').filter(Boolean))
        if (await isPathInsideWorkspaceReal(ws, abs)) {
          if (await fsp.stat(abs).then((s) => s.isFile()).catch(() => false)) {
            await this.trash.trashItem(ws, abs, 'file')
          }
        }
      }
    })
  }

  /**
   * v2.5（审查 P1-C2）：客户重命名级联——扫描全部发票，customer === 旧名 的更新为新名。
   * 名字引用语义（对齐 inbound.renameSupplierId / quotes.renameCustomer）：不校验客户存在，
   * 无命中或台账缺失时幂等不报错（此时不写盘、不刷 mtime）。
   */
  async renameCustomer(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store, markChanged) => {
      let changed = false
      for (const rec of Object.values(store.invoices)) {
        if (rec.customer === oldName) {
          rec.customer = newName
          changed = true
        }
      }
      if (changed) markChanged()
    })
  }

  /**
   * 复制归档到 发票/<YYYY>/（YYYY = 开票日期年份；源文件可以是工作区外，UI 对话框选本地文件）。
   * 命名：套用命名模板（发票无产品集/子文件夹槽位 → 均为空，仅 original_name 生效等价原文件名；
   * 用户配置的 prefix/suffix 照常套用），冲突时按 conflict_suffix 加 _{n} 递增序号（resolveConflictName）。
   * 返回归档后的工作区相对路径（/ 分隔），供 create/update 作为 file_path。
   */
  async archiveFile(sourcePath: string, date: string): Promise<string> {
    const ws = this.requireWS()
    if (!sourcePath || !sourcePath.trim()) throw new Error('请选择发票文件')
    const d = normalizeExpiryDate((date ?? '').trim())
    if (!d) throw new Error('开票日期无效（应为 YYYY-MM-DD 或可解析的日期）')
    const srcInfo = await fsp.stat(sourcePath).catch(() => null)
    if (!srcInfo || !srcInfo.isFile()) throw new Error('归档源文件不存在或不是文件')
    const year = d.slice(0, 4)
    const targetDir = path.join(invoiceRootPath(ws), year)
    await fsp.mkdir(targetDir, { recursive: true })
    const ext = path.extname(sourcePath)
    const base = sanitizeName(path.basename(sourcePath, ext))
    const cfg = await this.workspace.loadConfig(ws)
    const ctx: ImportContext = { targetProductSet: '', subFolder: '' }
    // v2.4.9 S5：composeTargetName 收 NamingTemplate（sequence 缺省 → 槽位跳过，归档命名行为不变）
    const candidate = composeTargetName(cfg.naming_template, base, ext, ctx)
    const name = await resolveConflictName(targetDir, candidate, cfg.naming_template.conflict_suffix, ext)
    await fsp.copyFile(sourcePath, path.join(targetDir, name))
    // v2.4.x：归档改变发票区目录内容 → 失效该目录的索引快照（查询时重建）
    globalWorkspaceIndex.invalidate(targetDir)
    return path.join(INVOICES_DIR, year, name).split(path.sep).join('/')
  }

  /** 导出台账为 xlsx（exceljs 懒加载，首次导出才加载；PLAN §6.1 复用 xlsx.ts 通用 exportRows） */
  async exportXlsx(filePath: string, records: InvoiceRecord[]): Promise<void> {
    await this.xlsx.exportRows(filePath, {
      sheetName: '发票台账',
      headers: ['发票号码', '发票代码', '开票日期', '金额（元）', '开票方', '购买方', '状态', '客户', '待办日期', '备注'],
      widths: [16, 14, 12, 12, 24, 24, 10, 16, 12, 30],
      rows: records.map((r) => [
        r.number,
        r.code ?? '',
        r.date,
        r.amount,
        r.seller,
        r.buyer,
        r.status,
        r.customer ?? '',
        r.due_date ?? '',
        r.notes ?? '',
      ]),
    })
  }

  // —— 标签引用源（TagService.registerSource('invoices') 用；PLAN §5.1，T7 机制兑现）——

  /** 全量「发票号码 → tags」快照（list 必须返回 tags 副本，防调用方污染共享引用） */
  async listTagEntries(): Promise<{ name: string; tags: string[] }[]> {
    const store = await this.loadStore()
    return Object.values(store.invoices).map((r) => ({ name: r.number, tags: [...(r.tags ?? [])] }))
  }

  /** 按 发票号码 → tags 整体回写（tags rename/delete 引用传播用；空数组删除 tags 字段；无差异不写盘） */
  async saveTagEntries(entries: { name: string; tags: string[] }[]): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store, markChanged) => {
      let changed = false
      for (const { name, tags } of entries) {
        const rec = store.invoices[name]
        if (!rec) continue
        const cur = rec.tags ?? []
        if (JSON.stringify(cur) !== JSON.stringify(tags)) {
          if (tags.length > 0) rec.tags = [...new Set(tags)]
          else delete rec.tags
          changed = true
        }
      }
      if (changed) markChanged()
    })
  }
}
