/**
 * 交换区投递服务（v2.4.7，PLAN §8）
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 职责：`工作区/交换区/` 投递的生命周期编排——
 * - 发现：fs.watch（交换区根，非递归，500ms 防抖）+ 启动补扫 sweep（覆盖离线投递与崩溃恢复）
 * - 处理：校验描述 → 文件归集（内置复制 + 命名模板 + 冲突序号）→ 台账写入（ledger sink）
 *   → 幂等簿记（exchange_state.json，滚动 500 条）→ 回执（已处理/<id>.receipt.json）→ 描述文件移入 已处理/
 * - 崩溃安全：处理顺序 = 校验 → 归集 → 台账 → 簿记 → 回执 → 移描述；任何中断 →
 *   重启 sweep 按「id 未簿记 + 描述文件仍在」重入；文件复制幂等（冲突加序号），台账查重兜底（不产生重复记录）
 * - 内存纪律：无常驻缓存；watch / 防抖定时器随 start()/stop() 生命周期成对管理；簿记有界（500 条滚动）
 * 发票/入库台账经注入的 ExchangeLedgerSinks 写入（由 InvoicesService / InboundService 提供，
 * 本服务不直接读写台账文件——查重等账务规则单点落在台账服务，PLAN §6.2「三入口同函数」）。
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  WorkspaceConfig,
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  CUSTOMERS_DIR,
  INVOICES_DIR,
  INBOUND_DIR,
  EXCHANGE_DONE_DIR,
  exchangeDir,
  exchangeStatePath,
  ensureWorkspaceDirs,
  writeJsonAtomic,
  readJsonFile,
  assertSafeFileName,
  assertSafePathSegment,
  isPathInsideWorkspaceReal,
} from './paths'
import { WorkspaceService } from './workspace'
import { currentTimeString } from './metadata'
import { sanitizeName, composeTargetName, resolveConflictName } from './naming'
import { globalWorkspaceIndex } from './indexCache'
import type { ExchangeReceipt } from '../../shared/types'

export type { ExchangeReceipt } from '../../shared/types'

export type ExchangeKind = 'invoice' | 'inbound' | 'customer' | 'productSet'

// —— 投递描述（PLAN §8.1 协议，字段与 JSON 一一对应；files 为交换区根下的文件名数组）——

export interface ExchangeInvoiceFields {
  number: string
  code?: string
  date: string
  amount: number
  seller: string
  buyer: string
  customer?: string
  due_date?: string
}

export interface ExchangeInboundFields {
  id: string
  date: string
  supplier: string
  product_set?: string
  amount?: number
  notes?: string
}

export interface ExchangeCustomerFields {
  name: string
  sub_folder: string
}

export interface ExchangeProductSetFields {
  name: string
  file_type: 'image' | 'cert'
  sub_folder: string
}

export interface ExchangeDescription {
  id: string
  kind: ExchangeKind
  files: string[]
  invoice?: ExchangeInvoiceFields
  inbound?: ExchangeInboundFields
  customer?: ExchangeCustomerFields
  productSet?: ExchangeProductSetFields
}

/** 台账写入 sink（发票/入库投递的账务动作；由台账服务实现，未注入则对应 kind 投递记为 error 回执） */
export interface ExchangeLedgerSinks {
  /** 发票：建台账记录；查重失败抛 Error → 上层记为 error 回执（不建记录）。archived = 已归档的工作区相对路径 */
  createInvoice(d: ExchangeInvoiceFields, archived: string[]): Promise<void>
  /** 入库单：建台账记录；单据编号查重失败抛 Error（同上） */
  createInbound(d: ExchangeInboundFields, archived: string[]): Promise<void>
}

/** 簿记滚动上限（§3.5：保留最近 500 条已处理投递 id） */
const PROCESSED_MAX = 500
/** watch 防抖窗口（§8.2：500ms，批量投递合并为一次补扫） */
const WATCH_DEBOUNCE_MS = 500

interface ExchangeState {
  processed: { id: string; at: string }[]
}

export class ExchangeService {
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  /** 补扫串行链：防抖/watch/手动调用并发时排队，防簿记读改写交错 */
  private sweepTail: Promise<number> = Promise.resolve(0)
  /** 单投递处理串行链：sweep 与外部直调 processFile 共用 */
  private processTail: Promise<unknown> = Promise.resolve()

  constructor(private workspace: WorkspaceService, private ledger?: ExchangeLedgerSinks) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  // —— 生命周期：start()/stop() 成对，watch 与防抖定时器随切换关闭重建（PLAN §8.2）——

  /**
   * 启动交换区监听（交换区根非递归 fs.watch，500ms 防抖）并立即补扫一次（覆盖离线投递与崩溃恢复）。
   * 返回本次补扫处理的投递数。监听不可用（平台限制等）→ 降级为仅补扫模式，功能不失效。
   */
  start(): Promise<number> {
    const ws = this.requireWS()
    ensureWorkspaceDirs(ws)
    try {
      this.watcher = fs.watch(exchangeDir(ws), { recursive: false }, () => this.scheduleSweep())
      this.watcher.on('error', () => {
        if (this.watcher) {
          try {
            this.watcher.close()
          } catch {
            // 忽略
          }
          this.watcher = null
        }
      })
    } catch {
      this.watcher = null
    }
    return this.sweep()
  }

  /** 关闭监听与防抖定时器（工作区切换 / 应用退出时调用；幂等） */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // 忽略
      }
      this.watcher = null
    }
  }

  private scheduleSweep(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.sweep()
    }, WATCH_DEBOUNCE_MS)
  }

  /**
   * 补扫：扫描交换区根目录下所有 *.json 描述文件（跳过目录与 已处理/），逐文件处理。
   * 串行化执行（并发调用排队）；单投递意外失败不中断整体；返回处理数。
   */
  sweep(): Promise<number> {
    const run = this.sweepTail.then(async () => {
      const ws = this.requireWS()
      const dir = exchangeDir(ws)
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return 0 // 交换区不可读 → 无投递可处理
      }
      let count = 0
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue
        await this.processFile(path.join(dir, e.name)).catch((err) => {
          // 进程级异常（描述文件路径校验失败等）：记录但不中断补扫
          console.warn('[exchange] 投递处理异常:', err)
        })
        count++
      }
      return count
    })
    this.sweepTail = run.catch(() => 0)
    return run
  }

  /**
   * 处理单个投递（watch 与 sweep 共用入口；业务失败一律转为 error 回执，不抛出）。
   * 崩溃重入语义见类注释；幂等判定 = exchange_state.json 簿记含 id。
   */
  processFile(descPath: string): Promise<ExchangeReceipt> {
    const run = this.processTail.then(() => this.processFileInner(descPath))
    this.processTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async processFileInner(descPath: string): Promise<ExchangeReceipt> {
    const ws = this.requireWS()
    const dir = exchangeDir(ws)
    // 描述文件必须在交换区根目录内（realpath 边界校验 + 词法校验，防符号链接/穿越）
    if (!(await isPathInsideWorkspaceReal(ws, descPath))) throw new Error('描述文件不在交换区内')
    if (path.dirname(path.resolve(descPath)) !== path.resolve(dir)) throw new Error('描述文件不在交换区根目录')

    // 权威 id = 描述文件名（<id>.json，文件系统事实）；非法文件名 sanitize 兜底（防回执/簿记路径穿越）
    const base = path.basename(descPath, '.json')
    let id = base
    try {
      assertSafeFileName(id)
    } catch {
      id = sanitizeName(base)
    }

    // 1. 读描述 JSON（坏 JSON → error 回执并消费描述文件，防反复报警）
    let desc: unknown
    try {
      desc = JSON.parse(await fsp.readFile(descPath, 'utf-8'))
    } catch {
      return this.finishError(ws, id, '描述 JSON 解析失败', descPath)
    }
    const d = desc as Record<string, unknown>
    if (!d || typeof d !== 'object') return this.finishError(ws, id, '描述 JSON 结构非法', descPath)
    if (d.id !== base) return this.finishError(ws, id, `投递 id 与文件名不一致（${String(d.id)} ≠ ${base}）`, descPath)
    const kind = d.kind
    if (kind !== 'invoice' && kind !== 'inbound' && kind !== 'customer' && kind !== 'productSet') {
      return this.finishError(ws, id, `未知投递类型: ${String(kind)}`, descPath)
    }
    if (!Array.isArray(d.files) || d.files.length === 0) {
      return this.finishError(ws, id, 'files 必须为非空数组', descPath)
    }

    // 2. 幂等检查：id 已簿记 → duplicate 回执，不重复归集（§8.2）
    if (await this.isProcessed(ws, id)) {
      const receipt: ExchangeReceipt = { id, status: 'duplicate', target_paths: [], processed_at: currentTimeString() }
      await this.writeReceipt(ws, id, receipt)
      await this.moveToDone(ws, id, descPath)
      return receipt
    }

    // 3. 投递文件校验：须为交换区根下存在的普通文件（段校验 + realpath 边界）
    const sourceFiles: string[] = []
    for (const raw of d.files) {
      if (typeof raw !== 'string') return this.finishError(ws, id, 'files 包含非字符串项', descPath)
      let name: string
      try {
        name = assertSafePathSegment(raw, '投递文件名')
      } catch (err) {
        return this.finishError(ws, id, err instanceof Error ? err.message : '投递文件名非法', descPath)
      }
      const full = path.join(dir, name)
      if (!(await isPathInsideWorkspaceReal(ws, full))) {
        return this.finishError(ws, id, `投递文件越界: ${name}`, descPath)
      }
      const st = await fsp.stat(full).catch(() => null)
      if (!st || !st.isFile()) return this.finishError(ws, id, `投递文件不存在: ${name}`, descPath)
      sourceFiles.push(full)
    }

    // 4. 按 kind 归集（内置复制 + 命名模板 + 冲突序号 + 索引失效）与台账写入
    const cfg = await this.workspace.loadConfig(ws)
    try {
      switch (kind) {
        case 'invoice':
          return await this.handleInvoice(ws, id, descPath, sourceFiles, cfg, d)
        case 'inbound':
          return await this.handleInbound(ws, id, descPath, sourceFiles, cfg, d)
        case 'customer':
          return await this.handleCustomer(ws, id, descPath, sourceFiles, cfg, d)
        case 'productSet':
          return await this.handleProductSet(ws, id, descPath, sourceFiles, cfg, d)
      }
    } catch (err) {
      // 业务失败（必填缺失 / 目标不存在 / 台账查重拒绝等）→ error 回执并消费描述文件
      return this.finishError(ws, id, err instanceof Error ? err.message : String(err), descPath)
    }
    return this.finishError(ws, id, `未知投递类型: ${String(kind)}`, descPath)
  }

  // —— 各 kind 处理（字段校验 → 目标目录解析 → 归集 → 台账）——

  private async handleInvoice(
    ws: string,
    id: string,
    descPath: string,
    sourceFiles: string[],
    cfg: WorkspaceConfig,
    d: Record<string, unknown>,
  ): Promise<ExchangeReceipt> {
    const f = d.invoice as ExchangeInvoiceFields | undefined
    if (!f || typeof f !== 'object') throw new Error('缺少 invoice 字段段')
    if (typeof f.number !== 'string' || !f.number.trim()) throw new Error('发票号码不能为空')
    if (typeof f.date !== 'string' || !/^\d{4}/.test(f.date)) throw new Error('开票日期非法')
    if (typeof f.amount !== 'number' || Number.isNaN(f.amount)) throw new Error('金额非法')
    if (typeof f.seller !== 'string' || !f.seller.trim()) throw new Error('开票方不能为空')
    if (typeof f.buyer !== 'string' || !f.buyer.trim()) throw new Error('购买方不能为空')
    // 台账未接入则拒绝（不归档文件，避免孤儿文件）
    if (!this.ledger?.createInvoice) throw new Error('发票台账服务未接入，无法处理 invoice 投递')
    // 归档到 发票/<YYYY>/（年份取开票日期前 4 位；归档区自动建年份目录）
    const year = f.date.slice(0, 4)
    const targetDir = path.join(ws, INVOICES_DIR, year)
    const archived = await this.copyFiles(sourceFiles, targetDir, cfg, sanitizeName(f.number), year)
    // 查重失败抛错 → error 回执（不建记录；已归档文件保留，账物分离原则下无害）
    await this.ledger.createInvoice(f, archived)
    return this.finishOk(ws, id, archived, descPath, sourceFiles)
  }

  private async handleInbound(
    ws: string,
    id: string,
    descPath: string,
    sourceFiles: string[],
    cfg: WorkspaceConfig,
    d: Record<string, unknown>,
  ): Promise<ExchangeReceipt> {
    const f = d.inbound as ExchangeInboundFields | undefined
    if (!f || typeof f !== 'object') throw new Error('缺少 inbound 字段段')
    if (typeof f.id !== 'string' || !f.id.trim()) throw new Error('单据编号不能为空')
    if (typeof f.date !== 'string' || !/^\d{4}/.test(f.date)) throw new Error('入库日期非法')
    if (typeof f.supplier !== 'string' || !f.supplier.trim()) throw new Error('供应商不能为空')
    if (!this.ledger?.createInbound) throw new Error('入库台账服务未接入，无法处理 inbound 投递')
    const year = f.date.slice(0, 4)
    const targetDir = path.join(ws, INBOUND_DIR, year)
    const archived = await this.copyFiles(sourceFiles, targetDir, cfg, sanitizeName(f.id), year)
    await this.ledger.createInbound(f, archived)
    return this.finishOk(ws, id, archived, descPath, sourceFiles)
  }

  private async handleCustomer(
    ws: string,
    id: string,
    descPath: string,
    sourceFiles: string[],
    cfg: WorkspaceConfig,
    d: Record<string, unknown>,
  ): Promise<ExchangeReceipt> {
    const f = d.customer as ExchangeCustomerFields | undefined
    if (!f || typeof f !== 'object') throw new Error('缺少 customer 字段段')
    if (typeof f.name !== 'string' || !f.name.trim()) throw new Error('客户名不能为空')
    if (typeof f.sub_folder !== 'string' || !f.sub_folder.trim()) throw new Error('子文件夹不能为空')
    const name = assertSafePathSegment(f.name, '客户名')
    const sub = assertSafePathSegment(f.sub_folder, '子文件夹')
    const targetDir = path.join(ws, CUSTOMERS_DIR, name, sub)
    // 客户/子文件夹不存在 → error 回执，不自动建客户（PLAN §8.1）
    const ok = await fsp.stat(targetDir).then((s) => s.isDirectory()).catch(() => false)
    if (!ok) throw new Error(`客户或子文件夹不存在: ${name}/${sub}`)
    const archived = await this.copyFiles(sourceFiles, targetDir, cfg, sanitizeName(name), sanitizeName(sub))
    return this.finishOk(ws, id, archived, descPath, sourceFiles)
  }

  private async handleProductSet(
    ws: string,
    id: string,
    descPath: string,
    sourceFiles: string[],
    cfg: WorkspaceConfig,
    d: Record<string, unknown>,
  ): Promise<ExchangeReceipt> {
    const f = d.productSet as ExchangeProductSetFields | undefined
    if (!f || typeof f !== 'object') throw new Error('缺少 productSet 字段段')
    if (typeof f.name !== 'string' || !f.name.trim()) throw new Error('产品集名不能为空')
    if (typeof f.sub_folder !== 'string' || !f.sub_folder.trim()) throw new Error('子文件夹不能为空')
    if (f.file_type !== 'image' && f.file_type !== 'cert') throw new Error('file_type 必须为 image 或 cert')
    const name = assertSafePathSegment(f.name, '产品集名')
    const sub = assertSafePathSegment(f.sub_folder, '子文件夹')
    const typeDir = f.file_type === 'image' ? IMAGES_DIR : CERTS_DIR
    const targetDir = path.join(ws, PRODUCT_SETS_DIR, name, typeDir, sub)
    const ok = await fsp.stat(targetDir).then((s) => s.isDirectory()).catch(() => false)
    if (!ok) throw new Error(`产品集或子文件夹不存在: ${name}/${sub}`)
    const archived = await this.copyFiles(sourceFiles, targetDir, cfg, sanitizeName(name), sanitizeName(sub))
    return this.finishOk(ws, id, archived, descPath, sourceFiles)
  }

  // —— 归集与收尾（簿记 → 回执 → 移描述 → 投递区归零）——

  /**
   * 文件归集：逐文件复制到目标目录（命名模板 + 冲突序号，COPYFILE_EXCL 防并发同名覆盖），
   * 复制成功后失效目标目录索引快照。返回工作区相对路径（`/` 分隔，跨平台一致）。
   */
  private async copyFiles(
    sources: string[],
    targetDir: string,
    cfg: WorkspaceConfig,
    psSlot: string,
    subSlot: string,
  ): Promise<string[]> {
    const ws = this.requireWS()
    await fsp.mkdir(targetDir, { recursive: true })
    const archived: string[] = []
    for (const src of sources) {
      const ext = path.extname(src).toLowerCase()
      const base = sanitizeName(path.basename(src, ext))
      const candidate = composeTargetName(cfg.naming_template, base, ext, { targetProductSet: psSlot, subFolder: subSlot })
      const finalName = await resolveConflictName(targetDir, candidate, cfg.naming_template.conflict_suffix, ext)
      await fsp.copyFile(src, path.join(targetDir, finalName), fs.constants.COPYFILE_EXCL)
      archived.push(path.relative(ws, path.join(targetDir, finalName)).split(path.sep).join('/'))
    }
    globalWorkspaceIndex.invalidate(targetDir)
    return archived
  }

  private async finishOk(
    ws: string,
    id: string,
    targetPaths: string[],
    descPath: string,
    sourceFiles: string[],
  ): Promise<ExchangeReceipt> {
    const receipt: ExchangeReceipt = { id, status: 'ok', target_paths: targetPaths, processed_at: currentTimeString() }
    await this.recordProcessed(ws, id)
    // 投递区归零：删除本投递的源文件（复制已归集，删除幂等；PLAN §8.1）
    await this.removeSourceFiles(ws, sourceFiles)
    await this.writeReceipt(ws, id, receipt)
    await this.moveToDone(ws, id, descPath)
    return receipt
  }

  private async finishError(ws: string, id: string, message: string, descPath: string): Promise<ExchangeReceipt> {
    const receipt: ExchangeReceipt = { id, status: 'error', target_paths: [], error: message, processed_at: currentTimeString() }
    await this.recordProcessed(ws, id)
    await this.writeReceipt(ws, id, receipt)
    await this.moveToDone(ws, id, descPath)
    return receipt
  }

  /** 投递区归零：删除本投递的源文件（sourceFiles 已在入口经段校验 + realpath 边界校验；不存在则跳过） */
  private async removeSourceFiles(ws: string, sourceFiles: string[]): Promise<void> {
    for (const full of sourceFiles) {
      if (!(await isPathInsideWorkspaceReal(ws, full))) continue
      await fsp.rm(full, { force: true })
    }
    globalWorkspaceIndex.invalidate(exchangeDir(ws))
  }

  private async writeReceipt(ws: string, id: string, receipt: ExchangeReceipt): Promise<void> {
    const doneDir = path.join(exchangeDir(ws), EXCHANGE_DONE_DIR)
    await fsp.mkdir(doneDir, { recursive: true })
    await writeJsonAtomic(path.join(doneDir, `${id}.receipt.json`), receipt)
  }

  /** 描述文件移入 已处理/<id>.json（rename；跨设备失败回退复制 + 删源） */
  private async moveToDone(ws: string, id: string, descPath: string): Promise<void> {
    const doneDir = path.join(exchangeDir(ws), EXCHANGE_DONE_DIR)
    await fsp.mkdir(doneDir, { recursive: true })
    const dest = path.join(doneDir, `${id}.json`)
    if (path.resolve(dest) === path.resolve(descPath)) return
    try {
      await fsp.rename(descPath, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await fsp.copyFile(descPath, dest)
        await fsp.rm(descPath, { force: true })
      } else {
        throw err
      }
    }
  }

  // —— 幂等簿记（exchange_state.json，滚动保留最近 500 条，有界；每次读写落盘，无内存缓存）——

  private async loadState(ws: string): Promise<ExchangeState> {
    const data = await readJsonFile<ExchangeState>(exchangeStatePath(ws))
    if (data && Array.isArray(data.processed)) return { processed: data.processed }
    return { processed: [] }
  }

  private async isProcessed(ws: string, id: string): Promise<boolean> {
    const state = await this.loadState(ws)
    return state.processed.some((p) => p.id === id)
  }

  private async recordProcessed(ws: string, id: string): Promise<void> {
    const state = await this.loadState(ws)
    state.processed = state.processed.filter((p) => p.id !== id)
    state.processed.push({ id, at: currentTimeString() })
    if (state.processed.length > PROCESSED_MAX) {
      state.processed = state.processed.slice(state.processed.length - PROCESSED_MAX)
    }
    ensureWorkspaceDirs(ws)
    await writeJsonAtomic(exchangeStatePath(ws), state)
  }
}
