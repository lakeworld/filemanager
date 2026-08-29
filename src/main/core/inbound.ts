/**
 * 入库单服务（v2.4.7 §7）
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 *
 * 数据：<ws>/.qihefilemanager/inbound.json
 *   { "records": Record<单据编号, InboundRecord> }——单据编号 = 查重主键 = key（§3.4）
 * - 归档主体永远是文件：每条记录必有 file_path 指向 入库/<YYYY>/ 下原件（账是物之索引）
 * - 账物分离（§3.3 原则）：删除台账记录不删文件（可选 deleteFile 时文件走回收站单条目）；
 *   文件被删/被回收时记录保留，file_path 校验失效由 UI 灰显，不级联删记录
 * - 查重口径（§6.2）：创建/编辑/交换区三入口同函数 checkId，命中即拒绝并提示已有记录摘要
 * - 明细行 / 金额计算不做（红线：进销存语义属启禾 OS，本体仅展示）
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { WorkspaceService } from './workspace'
import {
  inboundPath,
  inboundRootPath,
  ensureWorkspaceDirs,
  isPathInsideWorkspaceReal,
} from './paths'
import { mutateJsonFile } from './jsonStore'
import { sanitizeName, resolveConflictName } from './naming'
import { normalizeExpiryDate, currentTimeString } from './metadata'
import { globalWorkspaceIndex } from './indexCache'
import type { TrashService } from './trash'
import type { InboundRecord, WorkspaceConfig } from '../../shared/types'

export type { InboundRecord } from '../../shared/types'

/**
 * 入库单创建/更新请求（core 层自建；shared/types.ts 仅承载 InboundRecord 持久形态，对齐 PLAN §九 类型清单）。
 * update 时 id 可改（查重排除原编号），原 key 记录删除、新 key 写入。
 */
export interface InboundCreateRequest {
  /** 单据编号（= key） */
  id: string
  /** 入库日期（写入归一化 YYYY-MM-DD） */
  date: string
  /** 供应商（自由文本，不建供应商表） */
  supplier: string
  /** 关联供应商名（名字引用；不校验存在性——供应商删除后编辑旧入库单放行；rename 由 BoxService.renameSupplierId 级联） */
  supplier_id?: string
  /** 关联产品集名（chip 跳转，打通「产品 → 入库凭证」下钻） */
  product_set?: string
  /** 归档主体：已归档文件的绝对路径或工作区相对路径（统一存相对路径，/ 分隔） */
  file_path: string
  /** 金额合计（仅展示与页内合计，不进任何计算） */
  amount?: number
  notes?: string
}

export type InboundUpdateRequest = InboundCreateRequest

interface InboundStore {
  records: Record<string, InboundRecord>
}

export class InboundService {
  constructor(
    private workspace: WorkspaceService,
    private trash?: TrashService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  private async loadConfig(ws: string): Promise<WorkspaceConfig> {
    return this.workspace.loadConfig(ws)
  }

  /**
   * 读取台账；损坏时备份原文件并降级为空库（与 metadata.ts readFromDisk 同法：直读区分
   * 「文件不存在」与「JSON 损坏」，语法/结构非法都备份 .corrupt-<ts>，稳定性增强）
   */
  private async loadStore(ws: string): Promise<InboundStore> {
    const p = inboundPath(ws)
    let raw: string
    try {
      raw = await fsp.readFile(p, 'utf-8')
    } catch {
      return { records: {} } // 文件不存在视为空台账
    }
    try {
      const parsed = JSON.parse(raw) as InboundStore
      if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') {
        return parsed
      }
      throw new Error('结构非法')
    } catch {
      // 损坏（语法或结构非法）：备份原文件（不丢数据），降级为空库
      try {
        await fsp.copyFile(p, `${p}.corrupt-${Date.now()}`)
      } catch {
        // 备份失败不阻断
      }
      return { records: {} }
    }
  }

  /**
   * 锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容，杜绝并发丢更新与「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateStore<R>(
    ws: string,
    mutate: (store: InboundStore, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = inboundPath(ws)
    let changed = false
    const result = await mutateJsonFile<InboundStore, R>(p, {
      read: async () => ({ records: {} }), // 文件缺失按空台账起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v): InboundStore | null =>
        v && typeof v === 'object' && !Array.isArray(v) && (v as InboundStore).records &&
        typeof (v as InboundStore).records === 'object'
          ? (v as InboundStore)
          : null,
    })
    return result
  }

  /**
   * 把 file_path 入参归一化为工作区相对路径（/ 分隔）。
   * 只做非空 + 工作区边界校验，不要求文件存在——账物分离（§3.3）：文件被删/被回收时记录保留，
   * 缺失文件的记录仍可编辑修正/换绑，不被缺失文件卡死；「file_path 校验失效 → UI 灰显」是读取侧语义。
   * 越界路径（工作区外）拒绝。
   */
  private async normalizeFilePath(ws: string, raw: string): Promise<string> {
    const p = raw.trim()
    if (!p) throw new Error('缺少归档文件路径')
    let abs: string
    if (path.isAbsolute(p)) {
      abs = path.normalize(p)
    } else {
      // 相对路径按工作区相对路径解读（允许 / 或 \ 分隔，跨平台容错）
      abs = path.join(ws, ...p.split(/[\\/]/))
    }
    if (!(await isPathInsideWorkspaceReal(ws, abs))) throw new Error('归档文件必须位于工作区内')
    return path.relative(ws, abs).split(path.sep).join('/')
  }

  /**
   * 单据编号查重（创建/编辑/交换区三入口共用口径，§6.2；创建/编辑事务内部以锁内 store 直接查重，
   * 本函数供 UI 预检与交换区等场景显式按工作区查询）：命中返回已有记录，未命中返回 null。
   * excludeId：更新时排除自身原编号（其余记录撞号仍拒绝）。ws 可选注入——传入时按捕获工作区查，
   * 不回读 current workspace。
   */
  async checkId(id: string, excludeId?: string, ws?: string): Promise<InboundRecord | null> {
    const w = ws ?? this.requireWS()
    const key = id.trim()
    if (!key) return null
    const store = await this.loadStore(w)
    const rec = store.records[key]
    if (rec && rec.id !== excludeId) return rec
    return null
  }

  /**
   * v2.5.7（协议增量 E2）：只读域投影——全量/增量列表（since = updated_at 严大于过滤，
   * ISO 串 Date.parse 归一化，缺省/非法 → 全量）。照 quote.listSince 语义。
   */
  async listSince(since?: string): Promise<InboundRecord[]> {
    const all = await this.list()
    if (!since) return all
    const sinceMs = Date.parse(since)
    if (!Number.isFinite(sinceMs)) return all
    return all.filter((r) => {
      const ms = Date.parse(r.updated_at ?? '')
      return Number.isFinite(ms) && ms > sinceMs
    })
  }

  /** v2.5.7（协议增量 E2）：单张入库单投影（单据编号=查重主键）；不存在 → null */
  async get(id: string): Promise<InboundRecord | null> {
    return this.checkId(id)
  }

  /** 查重拒绝文案（含已有记录摘要：供应商/日期/文件，§6.2 口径） */
  private duplicateError(key: string, dup: InboundRecord): Error {
    return new Error(`单据编号「${key}」已存在（供应商：${dup.supplier}，日期：${dup.date}，文件：${dup.file_path}）`)
  }

  /** 必填校验 + 日期归一化（复用 metadata.ts normalizeExpiryDate，写入 YYYY-MM-DD） */
  private async validateFields(ws: string, req: InboundCreateRequest): Promise<{ id: string; date: string; supplier: string; filePath: string }> {
    const id = req.id.trim()
    if (!id) throw new Error('单据编号不能为空')
    const supplier = req.supplier.trim()
    if (!supplier) throw new Error('供应商不能为空')
    const date = normalizeExpiryDate(req.date)
    if (!date) throw new Error('入库日期格式无效')
    const filePath = await this.normalizeFilePath(ws, req.file_path)
    return { id, date, supplier, filePath }
  }

  /** 台账列表（页内筛选/搜索是渲染层职责，台账量级千内内存过滤，core 不建索引）。返回记录副本，防调用方污染 store */
  async list(): Promise<InboundRecord[]> {
    const ws = this.requireWS()
    const store = await this.loadStore(ws)
    const records = Object.values(store.records).map((r) => ({ ...r }))
    records.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1 // 入库日期新 → 旧
      return a.created_at < b.created_at ? 1 : -1
    })
    return records
  }

  /**
   * v2.5.3（T6）：新建台账记录——ws 可选注入，传入捕获工作区时全程只写该工作区
   * （查重/写入均在锁内基于该 ws 的磁盘内容完成，绝不在中途回读 current workspace）。缺省走当前工作区。
   */
  async create(req: InboundCreateRequest, ws?: string): Promise<InboundRecord> {
    const w = ws ?? this.requireWS()
    const { id, date, supplier, filePath } = await this.validateFields(w, req)
    const now = currentTimeString()
    const rec: InboundRecord = {
      id,
      date,
      supplier,
      supplier_id: req.supplier_id?.trim() || undefined,
      product_set: req.product_set?.trim() || undefined,
      file_path: filePath,
      amount: req.amount,
      notes: req.notes?.trim() || undefined,
      created_at: now,
      updated_at: now,
    }
    // 查重 + 写入同在锁内（基于 w 的磁盘最新内容；显式 ws 时与 current workspace 无关）
    return this.mutateStore(w, (store, markChanged) => {
      const dup = store.records[id]
      if (dup) throw this.duplicateError(id, dup)
      store.records[id] = rec
      markChanged()
      return { ...rec }
    })
  }

  /** 更新（id 可改：查重排除原编号，原 key 删除、新 key 写入）；file_path 换绑时旧文件不动（账物分离） */
  async update(id: string, req: InboundUpdateRequest): Promise<InboundRecord> {
    const ws = this.requireWS()
    const oldId = id.trim()
    if (!oldId) throw new Error('单据编号不能为空')
    const { id: newId, date, supplier, filePath } = await this.validateFields(ws, req)
    return this.mutateStore(ws, (store, markChanged) => {
      const prev = store.records[oldId]
      if (!prev) throw new Error(`入库单「${oldId}」不存在`)
      const dup = store.records[newId]
      if (dup && dup.id !== oldId) throw this.duplicateError(newId, dup)
      const rec: InboundRecord = {
        ...prev,
        id: newId,
        date,
        supplier,
        supplier_id: req.supplier_id?.trim() || undefined,
        product_set: req.product_set?.trim() || undefined,
        file_path: filePath,
        amount: req.amount,
        notes: req.notes?.trim() || undefined,
        updated_at: currentTimeString(),
      }
      delete store.records[oldId]
      store.records[newId] = rec
      markChanged()
      return { ...rec }
    })
  }

  /**
   * 删除台账记录（账物分离：默认只删记录；deleteFile 时归档文件走回收站 file 单条目）。
   * 文件缺失/越界时跳过回收站、只删记录——文件删除是尽力而为，记录删除总是成功。
   */
  async remove(id: string, opts?: { deleteFile?: boolean }): Promise<void> {
    const ws = this.requireWS()
    const key = id.trim()
    if (!key) throw new Error('单据编号不能为空')
    await this.mutateStore(ws, async (store, markChanged) => {
      const rec = store.records[key]
      if (!rec) throw new Error(`入库单「${key}」不存在`)
      if (opts?.deleteFile && this.trash) {
        const abs = path.join(ws, ...rec.file_path.split('/'))
        try {
          if (await isPathInsideWorkspaceReal(ws, abs)) {
            const st = await fsp.stat(abs).catch(() => null)
            if (st && st.isFile()) {
              await this.trash.trashItem(ws, abs, 'file')
              // v2.4.x：文件移入回收站 → 失效所在目录的索引快照
              globalWorkspaceIndex.invalidate(path.dirname(abs))
            }
          }
        } catch (err) {
          // 文件回收失败不阻断记录删除（账物分离）
          console.warn('[inbound] 归档文件回收失败:', err)
        }
      }
      delete store.records[key]
      markChanged()
    })
  }

  /**
   * v2.4.9（S2）：供应商重命名级联——扫描全部单据，supplier_id === 旧名 的更新为新名。
   * 名字引用语义：不校验供应商存在；无命中或台账缺失时幂等不报错（此时不写盘、不刷 mtime；
   * 账物分离，同发票 customer 字段保留字面值）。
   */
  async renameSupplierId(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    await this.mutateStore(ws, (store, markChanged) => {
      let changed = false
      for (const rec of Object.values(store.records)) {
        if (rec.supplier_id === oldName) {
          rec.supplier_id = newName
          changed = true
        }
      }
      if (changed) markChanged()
    })
  }

  /**
   * 归档文件：复制源文件到 入库/<YYYY>/（按入库日期年份分目录，命名 sanitize + 冲突序号），
   * 返回工作区相对路径（/ 分隔）。源文件可来自工作区外（UI 选本地文件 / 交换区投递）。
   */
  async archiveFile(sourcePath: string, date: string): Promise<string> {
    const ws = this.requireWS()
    const src = sourcePath.trim()
    if (!src) throw new Error('源文件路径不能为空')
    const srcStat = await fsp.stat(src).catch(() => null)
    if (!srcStat || !srcStat.isFile()) throw new Error('归档源文件不存在')
    const d = normalizeExpiryDate(date)
    if (!d) throw new Error('入库日期格式无效')
    const destDir = path.join(inboundRootPath(ws), d.slice(0, 4))
    await fsp.mkdir(destDir, { recursive: true })
    const cfg = await this.loadConfig(ws)
    const ext = path.extname(src).toLowerCase()
    const base = sanitizeName(path.basename(src, ext))
    const candidate = base + ext
    let finalName = candidate
    if (await fsp.stat(path.join(destDir, finalName)).then(() => true).catch(() => false)) {
      finalName = await resolveConflictName(destDir, candidate, cfg.naming_template.conflict_suffix, ext)
    }
    const dest = path.join(destDir, finalName)
    // COPYFILE_EXCL 兜底并发同名冲突（与导入同防线）
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL)
    // v2.4.x：归档复制改变 入库/ 与 入库/<YYYY>/ 目录内容 → 索引快照失效
    globalWorkspaceIndex.invalidate(inboundRootPath(ws))
    globalWorkspaceIndex.invalidate(destDir)
    return path.relative(ws, dest).split(path.sep).join('/')
  }
}
