/**
 * 报价单台账（v2.4.9 S3，对齐启禾 OS 报价单 Quotation）：报价.json 台账 + 单号自动生成 + 三态状态机 + 金额计算 + 文件归档
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 数据：<ws>/.qihefilemanager/报价.json
 *   { "quotes": Record<报价单号, QuoteRecord> }——报价单号 = 查重主键 = key
 *
 * 参照发票台账（invoices.ts，v2.4.7）同构，差异点（PLAN §3.4）：
 * - 状态机：发票自由流转；报价按矩阵（草稿→已确认→修订中→草稿/已确认；已确认→草稿 拒绝）
 * - 单号：发票手输查重；报价自动生成 QT-YYYYMMDD-序号（同日自增 max+1，999 进位 4 位；手输覆盖查重）
 * - 金额：发票仅展示；报价 amount/total_amount 写入时 round2 统一计算，拒绝外部注入不一致
 * - 明细锁定：status='已确认' 时 update 拒绝改 lines（须先 setStatus 转修订中）
 * - file_path 可空（报价可不附原件；发票必填）
 *
 * 账物分离（同发票）：删除记录不删文件，文件留在 报价/<YYYY>/；文件被删/被回收时记录保留，
 * file_path 校验失效由 UI 灰显，不级联删记录。报价原件统一落 报价/<YYYY>/ 归档；
 * 供应商/<名>/ 目录只放合同/对账单/往来文件——两处物理归属不重叠（审查执行 P1-8）。
 * 内存纪律：台账量级（千内）页内内存过滤，不建索引、不引缓存、无常驻定时器。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  QUOTES_DIR,
  quotesPath,
  quoteRootPath,
  QUOTE_STATUSES,
  ensureWorkspaceDirs,
  readJsonFile,
  isPathInsideWorkspaceReal,
  classifyFileType,
} from './paths'
import type { DirBrowseEntry } from './dirBrowse'
import { mutateJsonFile } from './jsonStore'
import { WorkspaceService } from './workspace'
import { parseExpiryDate, currentTimeString } from './metadata'
import { sanitizeName, resolveConflictName, composeTargetName } from './naming'
import { globalWorkspaceIndex } from './indexCache'
import type { ImportContext } from './naming'
import type { Logger } from './logger'
import type { QuoteLine, QuoteRecord, QuoteCreateRequest, QuoteUpdateRequest } from '../../shared/types'

export type { QuoteRecord, QuoteCreateRequest, QuoteUpdateRequest } from '../../shared/types'

export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

/** 金额两位小数（写入时统一计算；单测断言用 round2 后相等，不用浮点直接相等） */
export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

export interface QuotesStore {
  quotes: Record<string, QuoteRecord>
}

/**
 * 状态机转移矩阵（与发票自由流转分叉，PLAN §3.4）：[from][to] 是否允许。
 * 草稿→已确认（写 confirmed_at）/已确认→修订中（回退纠错）/修订中→草稿（重新草稿）/修订中→已确认（重确认，刷新 confirmed_at）；
 * 已确认→草稿 拒绝（须先转修订中）；同状态流转不在矩阵内（拒绝）。
 */
const STATUS_TRANSITIONS: Record<QuoteStatus, Partial<Record<QuoteStatus, boolean>>> = {
  草稿: { 已确认: true },
  已确认: { 修订中: true },
  修订中: { 草稿: true, 已确认: true },
}

/**
 * 报价单号自动生成（纯函数，node 直测）：QT-YYYYMMDD-<序号>。
 * 序号按日期分组自增：读台账当日已有序号（数字后缀）取 max + 1；同日序号达 999 后进位 4 位继续
 * （1000 不截断不拒绝）；生成结果若仍被占用（手输覆盖残留/并发陈旧快照的防御）则继续 +1 直至可用（冲突 +1）。
 */
export function nextQuotationNo(store: QuotesStore, date: string): string {
  const yyyymmdd = date.replace(/-/g, '')
  const prefix = `QT-${yyyymmdd}-`
  let max = 0
  for (const key of Object.keys(store.quotes)) {
    if (key.startsWith(prefix)) {
      const n = Number(key.slice(prefix.length))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  let seq = max + 1
  let candidate = `${prefix}${String(seq).padStart(3, '0')}`
  while (store.quotes[candidate]) {
    seq += 1
    candidate = `${prefix}${String(seq).padStart(3, '0')}`
  }
  return candidate
}

export class QuotesService {
  constructor(
    private workspace: WorkspaceService,
    private logger?: Logger,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /** 读取台账（只读/宽容降级）；文件缺失/损坏（结构非法）视为空台账（同发票 loadStore） */
  async loadStore(ws?: string): Promise<QuotesStore> {
    const w = ws ?? this.requireWS()
    const data = await readJsonFile<QuotesStore>(quotesPath(w))
    return data && data.quotes && typeof data.quotes === 'object' ? data : { quotes: {} }
  }

  /**
   * 锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重（含单号自增）/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容（并发建单不撞号、不丢更新），杜绝「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateStore<R>(
    ws: string,
    mutate: (store: QuotesStore, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = quotesPath(ws)
    let changed = false
    const result = await mutateJsonFile<QuotesStore, R>(p, {
      read: async () => ({ quotes: {} }), // 文件缺失按空台账起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v): QuotesStore | null =>
        v && typeof v === 'object' && !Array.isArray(v) && (v as QuotesStore).quotes &&
        typeof (v as QuotesStore).quotes === 'object'
          ? (v as QuotesStore)
          : null,
    })
    return result
  }

  private assertStatus(status: unknown): asserts status is QuoteStatus {
    if (!QUOTE_STATUSES.includes(status as QuoteStatus)) {
      throw new Error('状态无效（应为 草稿 / 已确认 / 修订中）')
    }
  }

  /** 查重命中摘要（同发票 duplicateError 口径：提示已有记录概要） */
  private duplicateError(existing: QuoteRecord): Error {
    return new Error(
      `报价单号 ${existing.quotation_no} 已存在（状态：${existing.status}，日期：${existing.date}，文件：${existing.file_path}）`,
    )
  }

  /**
   * 查重（创建手输命中即拒绝，同发票 checkNumber 口径）：命中返回已有记录（供摘要提示），未命中返回 null。
   * excludeNo：防御性排除参数——报价单号生成后不可改（update 无换号字段），编辑不换号，
   * 保留与发票同签名仅供测试/未来换号场景复用（S3a 疑虑 3 定稿）。
   */
  async checkNumber(quotationNo: string, excludeNo?: string): Promise<QuoteRecord | null> {
    const n = (quotationNo ?? '').trim()
    if (!n) throw new Error('报价单号不能为空')
    if (excludeNo && n === (excludeNo ?? '').trim()) return null
    const store = await this.loadStore()
    return store.quotes[n] ?? null
  }

  /** 明细行校验：非空、品名非空、qty≥1、unit_price≥0、amount 与 round2(qty×unit_price) 一致（写入时计算，外部注入不一致拒绝） */
  private assertLines(lines: unknown): QuoteLine[] {
    if (!Array.isArray(lines) || lines.length === 0) throw new Error('报价明细不能为空')
    return lines.map((raw, i) => {
      const line = raw as QuoteLine
      if (!line || typeof line !== 'object') throw new Error(`明细第 ${i + 1} 行无效`)
      const product = String(line.product ?? '').trim()
      if (!product) throw new Error(`明细第 ${i + 1} 行缺少品名`)
      if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty < 1) {
        throw new Error(`明细第 ${i + 1} 行数量无效（应 ≥1）`)
      }
      if (typeof line.unit_price !== 'number' || !Number.isFinite(line.unit_price) || line.unit_price < 0) {
        throw new Error(`明细第 ${i + 1} 行单价无效（应 ≥0）`)
      }
      const expected = round2(line.qty * line.unit_price)
      if (typeof line.amount !== 'number' || !Number.isFinite(line.amount) || round2(line.amount) !== expected) {
        throw new Error(`明细第 ${i + 1} 行金额与计算值不一致（应为 ${expected}）`)
      }
      const out: QuoteLine = { product, qty: line.qty, unit_price: line.unit_price, amount: expected }
      if ((line.sku ?? '').trim()) out.sku = (line.sku ?? '').trim()
      return out
    })
  }

  /** 日期校验：严格 YYYY-MM-DD 格式 + 日历合法性（2026-02-30 拒绝；归档年份基准） */
  private assertDate(raw: string): string {
    const d = (raw ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('报价日期无效（应为 YYYY-MM-DD）')
    const t = parseExpiryDate(d)
    if (Number.isNaN(t.getTime())) throw new Error('报价日期无效（应为 YYYY-MM-DD）')
    return d
  }

  /** quote_ext 为 v2.7 keji 预留命名空间：本体只读不校验、API 面不含入参（类型层面保证），运行时传入拒绝 */
  private assertNoExtField(req: QuoteCreateRequest | QuoteUpdateRequest): void {
    const ext = (req as unknown as Record<string, unknown>).quote_ext
    if (ext !== undefined) throw new Error('quote_ext 为 v2.7 keji 预留命名空间，不接受外部写入')
  }

  /**
   * 归档文件解析（同发票 resolveArchivedFilePath）：接受工作区绝对路径或 报价/<YYYY>/ 相对路径（/ 分隔）。
   * 账物一致：台账 file_path 必须指向 报价/ 区且文件真实存在。返回规范化相对路径（/ 分隔）。
   */
  private async resolveArchivedFilePath(ws: string, filePath: string): Promise<string> {
    const normalized = filePath.replace(/\\/g, '/')
    if (!normalized) throw new Error('请选择报价文件')
    const abs = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.join(ws, ...normalized.split('/').filter(Boolean))
    if (!(await isPathInsideWorkspaceReal(ws, abs))) throw new Error('报价文件必须位于工作区内')
    const rel = path.relative(path.resolve(ws), path.resolve(abs))
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('报价文件必须位于工作区内')
    const norm = rel.split(path.sep).join('/')
    if (!norm.startsWith(`${QUOTES_DIR}/`)) throw new Error('报价文件必须归档在 报价/ 目录下')
    if (!(await fsp.stat(abs).then((s) => s.isFile()).catch(() => false))) throw new Error('报价文件不存在')
    return norm
  }

  /** 台账列表：按报价日期降序（同日按单号升序）；返回记录副本，防调用方污染 store */
  async list(): Promise<QuoteRecord[]> {
    const store = await this.loadStore()
    const out = Object.values(store.quotes).map((r) => ({ ...r, lines: (r.lines ?? []).map((l) => ({ ...l })) }))
    out.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.quotation_no < b.quotation_no ? -1 : a.quotation_no > b.quotation_no ? 1 : 0,
    )
    return out
  }

  /** 单条（不存在返回 undefined，由调用方处理；同发票 checkNumber 宽松形态） */
  async get(quotationNo: string): Promise<QuoteRecord | undefined> {
    const store = await this.loadStore()
    const rec = store.quotes[(quotationNo ?? '').trim()]
    return rec ? { ...rec, lines: (rec.lines ?? []).map((l) => ({ ...l })) } : undefined
  }

  /** 增量台账（v2.5.4 弹一 C-4，云桥 M3 quote 只读域）：since = updated_at 严大于 ms 过滤；无 since → 全量 */
  async listSince(since?: string): Promise<QuoteRecord[]> {
    const all = await this.list()
    if (!since) return all
    const sinceMs = Date.parse(since)
    if (!Number.isFinite(sinceMs)) return all
    return all.filter((r) => {
      const ms = Date.parse(r.updated_at ?? '')
      return Number.isFinite(ms) && ms > sinceMs
    })
  }

  /** 新建报价：明细/日期校验 + 金额写入时计算 + 单号（自动生成或手输查重）+ 可选归档文件校验；初始状态 草稿 */
  async create(req: QuoteCreateRequest): Promise<QuoteRecord> {
    const ws = this.requireWS()
    this.assertNoExtField(req)
    const lines = this.assertLines(req.lines)
    const date = this.assertDate(req.date)
    const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0))
    const manual = (req.quotation_no ?? '').trim()

    let filePath = ''
    if ((req.file_path ?? '').trim()) filePath = await this.resolveArchivedFilePath(ws, req.file_path ?? '')

    const now = currentTimeString()
    const base: Omit<QuoteRecord, 'quotation_no'> = {
      date,
      lines,
      total_amount: totalAmount,
      status: '草稿',
      file_path: filePath,
      created_at: now,
      updated_at: now,
    }
    // 单号生成/手输查重/写入同在锁内——并发建单基于锁内最新序号自增，不撞号不丢更新
    const rec = await this.mutateStore(ws, (store, markChanged) => {
      const quotationNo = manual ? manual : nextQuotationNo(store, date)
      if (manual) {
        const conflict = store.quotes[quotationNo]
        if (conflict) throw this.duplicateError(conflict)
      }
      const full: QuoteRecord = { ...base, quotation_no: quotationNo }
      if ((req.customer ?? '').trim()) full.customer = (req.customer ?? '').trim()
      if ((req.notes ?? '').trim()) full.notes = (req.notes ?? '').trim()
      store.quotes[quotationNo] = full
      markChanged()
      return full
    })
    this.logger?.info(`报价单创建: ${rec.quotation_no}`)
    // v2.5.5（打磨 2）：建单即建文档文件夹（报价/<YYYY>/<单号>/），详情页拖拽落地目录已就绪
    await this.ensureQuoteDocDir(rec.quotation_no, rec.date).catch(() => undefined)
    return { ...rec, lines: (rec.lines ?? []).map((l) => ({ ...l })) }
  }

  /**
   * 编辑：按 quotation_no 定位记录（须存在）。status='已确认' 时拒绝改 lines（明细锁定，须先 setStatus 转修订中）；
   * 金额重算；updated_at 刷新。报价单号生成后不可改（自动生成或建单时手输定稿，API 面无换号字段，查重同函数防御）。
   */
  async update(req: QuoteUpdateRequest): Promise<QuoteRecord> {
    const ws = this.requireWS()
    this.assertNoExtField(req)
    const no = (req.quotation_no ?? '').trim()
    if (!no) throw new Error('报价单号不能为空')
    // 换绑文件：fs 校验（工作区边界/存在性）锁外完成，store 无关
    let newFilePath: string | undefined
    if (req.file_path !== undefined && (req.file_path ?? '').trim()) {
      newFilePath = await this.resolveArchivedFilePath(ws, req.file_path ?? '')
    }
    const rec = await this.mutateStore(ws, (store, markChanged) => {
      const existing = store.quotes[no]
      if (!existing) throw new Error('报价单不存在')

      const out: QuoteRecord = { ...existing }
      if (req.date !== undefined) out.date = this.assertDate(req.date)
      if (req.lines !== undefined) {
        if (out.status === '已确认') throw new Error('报价单已确认，明细已锁定。如需修改请先转为修订中')
        out.lines = this.assertLines(req.lines)
        out.total_amount = round2(out.lines.reduce((s, l) => s + l.amount, 0))
      }
      if (req.customer !== undefined) {
        const v = (req.customer ?? '').trim()
        if (v) out.customer = v
        else delete out.customer
      }
      if (req.notes !== undefined) {
        const v = (req.notes ?? '').trim()
        if (v) out.notes = v
        else delete out.notes
      }
      if (newFilePath !== undefined) out.file_path = newFilePath
      out.updated_at = currentTimeString()

      store.quotes[no] = out
      markChanged()
      return out
    })
    return { ...rec, lines: (rec.lines ?? []).map((l) => ({ ...l })) }
  }

  /** 状态流转（矩阵单入口）：非法跳转拒绝；→已确认 写入/刷新 confirmed_at；updated_at 刷新 */
  async setStatus(quotationNo: string, status: QuoteStatus): Promise<QuoteRecord> {
    const ws = this.requireWS()
    this.assertStatus(status)
    const no = (quotationNo ?? '').trim()
    if (!no) throw new Error('报价单号不能为空')
    const rec = await this.mutateStore(ws, (store, markChanged) => {
      const r = store.quotes[no]
      if (!r) throw new Error('报价单不存在')
      if (!STATUS_TRANSITIONS[r.status]?.[status]) {
        throw new Error(`状态不允许从「${r.status}」流转到「${status}」`)
      }
      r.status = status
      if (status === '已确认') r.confirmed_at = currentTimeString()
      r.updated_at = currentTimeString()
      markChanged()
      return r
    })
    this.logger?.info(`报价单状态流转: ${no} → ${status}`)
    return { ...rec, lines: (rec.lines ?? []).map((l) => ({ ...l })) }
  }

  /**
   * 客户改名级联：扫描全部单据，customer === oldName → newName（幂等；不校验客户存在，
   * 名字引用语义同 inbound.renameSupplierId——客户被删后编辑旧单据放行；无命中不写盘、不刷 mtime）。
   */
  async renameCustomer(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store, markChanged) => {
      let changed = false
      for (const rec of Object.values(store.quotes)) {
        if (rec.customer === oldName) {
          rec.customer = newName
          changed = true
        }
      }
      if (changed) markChanged()
    })
  }

  /** 删除台账记录（账物分离同发票）：只删记录，文件留在 报价/<YYYY>/ */
  async removeEntry(quotationNo: string): Promise<void> {
    const ws = this.requireWS()
    const no = (quotationNo ?? '').trim()
    if (!no) throw new Error('报价单号不能为空')
    await this.mutateStore(ws, (store, markChanged) => {
      if (!store.quotes[no]) throw new Error('报价单不存在')
      delete store.quotes[no]
      markChanged()
    })
  }

  /**
   * 归档原件到 报价/<YYYY>/（YYYY = 报价日期年份；源文件可在工作区外，UI 对话框选本地文件）。
   * 命名：套用命名模板（报价无产品集/子文件夹槽位 → 均空，等价原文件名 + 用户配置 prefix/suffix），
   * 冲突按 conflict_suffix 加 _{n} 递增序号（resolveConflictName，同发票 archiveFile 实现）。
   * 返回归档后的工作区相对路径（/ 分隔），供 create/update 作为 file_path。
   */
  async archiveFile(sourcePath: string, date: string): Promise<string> {
    const ws = this.requireWS()
    if (!sourcePath || !sourcePath.trim()) throw new Error('请选择报价文件')
    const d = this.assertDate(date)
    const srcInfo = await fsp.stat(sourcePath).catch(() => null)
    if (!srcInfo || !srcInfo.isFile()) throw new Error('归档源文件不存在或不是文件')
    const year = d.slice(0, 4)
    const targetDir = path.join(quoteRootPath(ws), year)
    await fsp.mkdir(targetDir, { recursive: true })
    const ext = path.extname(sourcePath)
    const base = sanitizeName(path.basename(sourcePath, ext))
    const cfg = await this.workspace.loadConfig(ws)
    const ctx: ImportContext = { targetProductSet: '', subFolder: '' }
    // v2.4.9 S5：composeTargetName 收 NamingTemplate（sequence 缺省 → 槽位跳过，归档命名行为不变）
    const candidate = composeTargetName(cfg.naming_template, base, ext, ctx)
    const name = await resolveConflictName(targetDir, candidate, cfg.naming_template.conflict_suffix, ext)
    await fsp.copyFile(sourcePath, path.join(targetDir, name))
    // v2.4.x：归档改变 报价/ 区目录内容 → 失效该目录的索引快照（查询时重建）
    globalWorkspaceIndex.invalidate(targetDir)
    return path.join(QUOTES_DIR, year, name).split(path.sep).join('/')
  }

  // —— v2.5.5（打磨 2）：报价文档文件夹（对齐产品集「目录即真相」——多份文档拖拽复制进
  //    报价/<YYYY>/<单号>/，不建独立归档链；目录内文件即文档）——

  /** 文档文件夹相对路径：报价/<YYYY>/<单号>/（YYYY = 报价日期年份） */
  private quoteDocRel(no: string, date: string): string {
    const year = this.assertDate(date).slice(0, 4)
    return `${QUOTES_DIR}/${year}/${no}`
  }

  /** 文档文件夹绝对路径 */
  private quoteDocAbs(ws: string, no: string, date: string): string {
    return path.join(ws, ...this.quoteDocRel(no, date).split('/'))
  }

  /** 单号须可作目录名（拒绝路径分隔符/空字节） */
  private assertDocDirNo(no: string): string {
    const n = (no ?? '').trim()
    if (!n) throw new Error('报价单号不能为空')
    if (/[/\\\0]/.test(n)) throw new Error('报价单号不能包含路径分隔符')
    return n
  }

  /** 确保文档文件夹存在（创建/更新报价保存时调用）；返回相对路径 */
  async ensureQuoteDocDir(no: string, date: string): Promise<string> {
    const ws = this.requireWS()
    const n = this.assertDocDirNo(no)
    const rel = this.quoteDocRel(n, date)
    await fsp.mkdir(this.quoteDocAbs(ws, n, date), { recursive: true })
    return rel
  }

  /** 复制文件到文档文件夹（拖拽落地，账物同区）；返回复制后的工作区相对路径列表 */
  async copyIntoQuoteDoc(no: string, date: string, sourcePaths: string[]): Promise<string[]> {
    const ws = this.requireWS()
    const n = this.assertDocDirNo(no)
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw new Error('没有要复制的文件')
    const dirRel = await this.ensureQuoteDocDir(n, date)
    const dirAbs = this.quoteDocAbs(ws, n, date)
    const out: string[] = []
    for (const src of sourcePaths) {
      const st = await fsp.stat(src).catch(() => null)
      if (!st || !st.isFile()) continue
      const ext = path.extname(src)
      const base = sanitizeName(path.basename(src, ext))
      const name = await resolveConflictName(dirAbs, `${base}${ext}`, '_{n}', ext)
      await fsp.copyFile(src, path.join(dirAbs, name))
      out.push(`${dirRel}/${name}`)
    }
    if (out.length > 0) globalWorkspaceIndex.invalidate(dirAbs)
    return out
  }

  /** 文档文件夹内文件列表（详情页显示；目录不存在/空 → 空数组） */
  async listQuoteDocs(no: string, date: string): Promise<DirBrowseEntry[]> {
    const ws = this.requireWS()
    const dir = this.quoteDocAbs(ws, this.assertDocDirNo(no), date)
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: DirBrowseEntry[] = []
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      const st = await fsp.stat(full).catch(() => null)
      out.push({
        name: e.name,
        path: full,
        size: st?.size ?? 0,
        modified: st?.mtime.toISOString() ?? '',
        file_type: classifyFileType(e.name),
        thumbnail_path: null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  /** 文档文件数（列表行 📎 探活；目录不存在 → 0） */
  async quoteDocCount(no: string, date: string): Promise<number> {
    const ws = this.requireWS()
    const dir = this.quoteDocAbs(ws, this.assertDocDirNo(no), date)
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      return entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length
    } catch {
      return 0
    }
  }
}
