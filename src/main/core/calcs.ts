/**
 * 计算台账（v2.5.9/A7「计算」）：`calcs.json` + 暂存/转正两态。
 * 权威 = `docs/INTERNAL/PLAN-v2.6-计算.md` §三 对象模型与存储。纯 TS 业务层：不 import electron，node 直测。
 *
 * 数据：<ws>/.qihefilemanager/calcs.json —— Record<id, CalcRecord>（key = id，新文件无迁移问题）
 * - 写入一律走 jsonStore 的 mutateJsonFile（按路径串行锁 + 损坏隔离 + 原子写）；
 *   读取走 readJsonFile 宽容降级（缺失/结构非法 → 空台账；同 quotes 口径）。
 * - 暂存（saved:false）也持久化——「临时」指身份还不是资料，不是「还没落盘」（§三）。
 * - 解析与格式化**不在这里做**：渲染层用 `shared/calc.ts`（双端同一份实现）先算好，
 *   台账只存展示态（expression/result/resultKind）；服务端不重新求值，避免两份真相。
 * - 删除 = 直接删记录（条目无盘上文件实体，不进回收站；按报价/发票账物分离先例，
 *   确认弹窗在 UI 层，见 §三 与 §八⑤ 拍板）。
 */
import { randomUUID } from 'node:crypto'
import { calcsPath, readJsonFile } from './paths'
import { mutateJsonFile } from './jsonStore'
import { WorkspaceService } from './workspace'
import type { Logger } from './logger'
import type { CalcRecord, CalcCreateRequest, CalcUpdateRequest } from '../../shared/types'

export type { CalcRecord, CalcCreateRequest, CalcUpdateRequest } from '../../shared/types'

export interface CalcsStore {
  [id: string]: CalcRecord
}

function isCalcsStore(v: unknown): v is CalcsStore {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 可选文本字段：trim 后为空 = 不保留（写入侧）——「清空」与「从未填过」落盘形态一致 */
function putOptionalText(rec: CalcRecord, key: 'title' | 'note', raw: string): void {
  const v = raw.trim()
  if (v) rec[key] = v
  else delete rec[key]
}

export class CalcsService {
  constructor(
    private workspace: WorkspaceService,
    private logger?: Logger,
  ) {}

  private resolveWs(ws?: string): string {
    const w = ws ?? this.workspace.currentWorkspacePath()
    if (!w) throw new Error('未打开工作区')
    return w
  }

  /** 读取台账（只读/宽容降级）；文件缺失/结构非法视为空台账（同 quotes.loadStore） */
  async loadStore(ws?: string): Promise<CalcsStore> {
    const w = this.resolveWs(ws)
    const data = await readJsonFile<CalcsStore>(calcsPath(w))
    return isCalcsStore(data) ? data : {}
  }

  private async mutateStore<R>(ws: string | undefined, mutate: (store: CalcsStore, markChanged: () => void) => R): Promise<R> {
    const w = this.resolveWs(ws)
    let changed = false
    return mutateJsonFile<CalcsStore, R>(calcsPath(w), {
      read: async () => ({}), // 文件缺失按空台账起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed, // 无变化不写盘（不刷 mtime）
      validate: (v): CalcsStore | null => (isCalcsStore(v) ? v : null),
    })
  }

  /** 历史流：按录入顺序（calcs.json 的插入序；时间流渲染由 UI 定） */
  async list(ws?: string): Promise<CalcRecord[]> {
    const store = await this.loadStore(ws)
    return Object.values(store)
  }

  /** 记一条（渲染层已用 shared/calc 算好展示态）；返回新记录 */
  async add(req: CalcCreateRequest, ws?: string): Promise<CalcRecord> {
    const expression = (req.expression ?? '').trim()
    if (!expression) throw new Error('算式不能为空')
    const result = (req.result ?? '').trim()
    if (!result) throw new Error('结果不能为空')
    if (req.resultKind !== 'number' && req.resultKind !== 'date') {
      throw new Error('resultKind 非法（只认 number / date）')
    }
    const now = new Date().toISOString()
    const rec: CalcRecord = {
      id: randomUUID(),
      expression,
      result,
      resultKind: req.resultKind,
      saved: false,
      created: now,
      updated: now,
    }
    if (req.title !== undefined) putOptionalText(rec, 'title', req.title)
    if (req.note !== undefined) putOptionalText(rec, 'note', req.note)

    await this.mutateStore(ws, (store, markChanged) => {
      store[rec.id] = rec
      markChanged()
    })
    this.logger?.info(`计算记一条: ${rec.expression} = ${rec.result}`)
    return rec
  }

  /**
   * 补丁式更新（§七：update(标题·备注·saved)）：只有出现的字段被改动；
   * title/note 传 ''（或纯空格）清空；saved 双向可切（true=存为资料，false=取消转正）。
   * 三个字段都没出现 = no-op（不改盘、不刷 updated）。
   */
  async update(req: CalcUpdateRequest, ws?: string): Promise<CalcRecord> {
    if (!req || typeof req.id !== 'string' || req.id.trim() === '') throw new Error('缺少记录 id')
    const hasTitle = req.title !== undefined
    const hasNote = req.note !== undefined
    const hasSaved = req.saved !== undefined
    // 类型校验放在动盘之前：`saved: 'true'`（字符串）旧写法会被 `=== true` 静默当 false —— 等于悄悄取消转正
    if (hasTitle && typeof req.title !== 'string') throw new Error('标题必须是文本')
    if (hasNote && typeof req.note !== 'string') throw new Error('备注必须是文本')
    if (hasSaved && typeof req.saved !== 'boolean') throw new Error('saved 必须是布尔值')
    const next = await this.mutateStore(ws, (store, markChanged) => {
      // 存在性必须按**自有键**判：`store[id]` 是原型链查找，`__proto__` 会取到 Object.prototype
      // （当作记录写脏 = 污主进程全局），`toString` 会取到一个函数（过 IPC 报 could not be cloned）
      if (!Object.hasOwn(store, req.id)) throw new Error('计算记录不存在')
      const rec = store[req.id]
      if (!hasTitle && !hasNote && !hasSaved) return rec
      if (hasTitle) putOptionalText(rec, 'title', req.title as string)
      if (hasNote) putOptionalText(rec, 'note', req.note as string)
      if (hasSaved) rec.saved = req.saved === true
      rec.updated = new Date().toISOString()
      markChanged()
      return rec
    })
    this.logger?.info(`计算更新: ${req.id}${hasSaved ? `（saved=${next.saved}）` : ''}`)
    return next
  }

  /** 删除记录（账物分离：无文件实体，直接删；确认弹窗在 UI 层） */
  async remove(id: string, ws?: string): Promise<void> {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('缺少记录 id')
    await this.mutateStore(ws, (store, markChanged) => {
      // 同 update：先按自有键确认存在再删——`delete store['toString']` 会假成功（什么都没删）并写盘
      if (!Object.hasOwn(store, id)) throw new Error('计算记录不存在')
      delete store[id]
      markChanged()
    })
    this.logger?.info(`计算删除: ${id}`)
  }
}