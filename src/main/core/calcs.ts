/**
 * 计算台账（v2.5.9/A7「计算」；v2.6.1 B15 容器化）：`calcs.json` + 暂存/已标记两态 + 容器一层。
 * 权威 = `内部计算设计文档（不进公开仓）` §三 对象模型与存储 与 §四「容器化修订」。纯 TS 业务层：不 import electron，node 直测。
 *
 * 数据：
 * - <ws>/.qihefilemanager/calcs.json —— Record<id, CalcRecord>（key = id）
 * - <ws>/.qihefilemanager/calc-containers.json —— Record<id, CalcContainer>（v2.6.1 容器化新增；
 *   左栏 = 容器列表，右栏 = 该容器下的计算历史）
 * - 写入一律走 jsonStore 的 mutateJsonFile（按路径串行锁 + 损坏隔离 + 原子写）；
 *   读取走 readJsonFile 宽容降级（缺失/结构非法 → 空台账；同 quotes 口径）。
 * - 暂存（saved:false）也持久化——「未标记」指还没打标记，不是「还没落盘」（§三）。
 * - 解析与格式化**不在这里做**：渲染层用 `shared/calc.ts`（双端同一份实现）先算好，
 *   台账只存展示态（expression/result/resultKind）；服务端不重新求值，避免两份真相。
 * - 删除 = 直接删记录（条目无盘上文件实体，不进回收站；按报价/发票账物分离先例，
 *   确认弹窗在 UI 层，见 §三 与 §八⑤ 拍板）；删除容器 = **连其中记录一起删**（§四 细则 #1，
 *   确认文案由 UI 层点明条数）。
 *
 * 老工作区迁移（§四 对象模型）：首次打开时，无 container_id（或指向不存在容器）的记录
 * 统一归入自动创建的默认容器（建议名「默认」，本实现取「默认」）；**幂等、只写一次**——
 * 无变化不写盘（mutateJsonFile 的 `save` 返回 false），第二次起的任意次访问字节与 mtime 都不动。
 */
import { randomUUID } from 'node:crypto'
import { calcsPath, calcContainersPath, readJsonFile } from './paths'
import { mutateJsonFile } from './jsonStore'
import { WorkspaceService } from './workspace'
import type { Logger } from './logger'
import type {
  CalcRecord,
  CalcCreateRequest,
  CalcUpdateRequest,
  CalcContainer,
  CalcContainerCreateRequest,
  CalcContainerRenameRequest,
} from '../../shared/types'

export type {
  CalcRecord,
  CalcCreateRequest,
  CalcUpdateRequest,
  CalcContainer,
  CalcContainerCreateRequest,
  CalcContainerRenameRequest,
} from '../../shared/types'

export interface CalcsStore {
  [id: string]: CalcRecord
}

export interface CalcContainersStore {
  [id: string]: CalcContainer
}

/** 默认容器名（仅「一本容器都没有」时自动创建；用户可重命名） */
const DEFAULT_CONTAINER_NAME = '默认'

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCalcsStore(v: unknown): v is CalcsStore {
  return isJsonObject(v)
}

function isContainersStore(v: unknown): v is CalcContainersStore {
  return isJsonObject(v)
}

/** 单条容器宽容降级：id / name 非空字符串才留下（坏条目静默丢弃，不让一份手改文件毁掉整页） */
function normalizeContainer(raw: unknown): CalcContainer | null {
  if (!isJsonObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : null
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : null
  if (!id || !name) return null
  return { id, name, created: typeof raw.created === 'string' ? raw.created : '' }
}

/** 可选文本字段：trim 后为空 = 不保留（写入侧）——「清空」与「从未填过」落盘形态一致 */
function putOptionalText(rec: CalcRecord, key: 'title' | 'note', raw: string): void {
  const v = raw.trim()
  if (v) rec[key] = v
  else delete rec[key]
}

/** 容器名校验（新建 / 重命名同口径）：trim 后非空 */
function requireContainerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('容器名字不能为空')
  return name
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

  /** 读取容器台账（只读/宽容降级）；文件缺失/结构非法视为空 */
  async loadContainerStore(ws?: string): Promise<CalcContainersStore> {
    const w = this.resolveWs(ws)
    const data = await readJsonFile<CalcContainersStore>(calcContainersPath(w))
    return isContainersStore(data) ? data : {}
  }

  private async mutateContainerStore<R>(
    ws: string | undefined,
    mutate: (store: CalcContainersStore, markChanged: () => void) => R,
  ): Promise<R> {
    const w = this.resolveWs(ws)
    let changed = false
    return mutateJsonFile<CalcContainersStore, R>(calcContainersPath(w), {
      read: async () => ({}), // 文件缺失按空容器台账起步
      mutate: async (store) => mutate(store, () => (changed = true)),
      save: async () => changed,
      validate: (v): CalcContainersStore | null => (isContainersStore(v) ? v : null),
    })
  }

  /** 容器列表（插入序 = 创建序）：保证至少有一个默认容器；老记录迁移在此完成（幂等） */
  async listContainers(ws?: string): Promise<CalcContainer[]> {
    const w = this.resolveWs(ws)
    const store = await this.ensureInitialized(w)
    return Object.keys(store)
      .map((key) => normalizeContainer(store[key]))
      .filter((c): c is CalcContainer => c !== null)
  }

  /**
   * 首次打开的姿态修正（幂等；无变化不写盘）：
   * 1) 一本容器都没有 → 建「默认」（保证右栏永远有可归属的容器，UI 不会进无容器死锁）；
   * 2) 记录无 container_id（老工作区）或指向不存在的容器（孤儿）→ 归入最老容器。
   * 「只写一次」由 mutateJsonFile 的 `save: () => changed` 兜底，第二次起连 mtime 都不动。
   */
  private async ensureInitialized(w: string): Promise<CalcContainersStore> {
    const store = await this.mutateContainerStore(w, (s, markChanged) => {
      if (Object.keys(s).length === 0) {
        const id = randomUUID()
        s[id] = { id, name: DEFAULT_CONTAINER_NAME, created: new Date().toISOString() }
        markChanged()
      }
      return s
    })

    // 最老容器 = 插入序里第一条结构合法的条目（容器只增不挪，插入序即创建序）
    let oldestId: string | null = null
    for (const key of Object.keys(store)) {
      const c = normalizeContainer(store[key])
      if (c) {
        oldestId = c.id
        break
      }
    }
    if (!oldestId) return store // 理论上到不了（上面刚保证非空且条目自产合法）

    await this.mutateStore(w, (calcs, markChanged) => {
      for (const key of Object.keys(calcs)) {
        const rec = calcs[key]
        if (!isJsonObject(rec)) continue
        const cid = typeof rec.container_id === 'string' ? rec.container_id : ''
        // 已归属且容器还在 → 不动（迁移只补不改：saved 两态与其它字段一字不动）
        if (cid && Object.hasOwn(store, cid)) continue
        rec.container_id = oldestId
        markChanged()
      }
    })
    return store
  }

  /**
   * 历史流：按录入顺序（calcs.json 的插入序；时间流渲染由 UI 定）。
   * 传 containerId = 只要该容器下的记录（右栏 = 当前容器）；不传 = 全量（诊断/测试面）。
   */
  async list(containerId?: string, ws?: string): Promise<CalcRecord[]> {
    const w = this.resolveWs(ws)
    await this.ensureInitialized(w)
    const store = await this.loadStore(w)
    const all = Object.values(store)
    if (containerId === undefined) return all
    const cid = typeof containerId === 'string' ? containerId.trim() : ''
    if (!cid) throw new Error('缺少容器 id')
    // 未知容器 = 空集（不抛：删容器与 UI 切回之间有个窗口，报错不如空态）
    return all.filter((r) => r.container_id === cid)
  }

  /** 记一条（渲染层已用 shared/calc 算好展示态）；返回新记录。归属容器必须真实存在 */
  async add(req: CalcCreateRequest, ws?: string): Promise<CalcRecord> {
    const expression = (req.expression ?? '').trim()
    if (!expression) throw new Error('算式不能为空')
    const result = (req.result ?? '').trim()
    if (!result) throw new Error('结果不能为空')
    if (req.resultKind !== 'number' && req.resultKind !== 'date') {
      throw new Error('resultKind 非法（只认 number / date）')
    }
    const containerId = typeof req.container_id === 'string' ? req.container_id.trim() : ''
    if (!containerId) throw new Error('缺少容器 id（每条计算都要归属一个容器）')
    const w = this.resolveWs(ws)
    // 存在性按**自有键**判：`store[id]` 是原型链查找（同 update/remove 口径）
    const containers = await this.loadContainerStore(w)
    if (!Object.hasOwn(containers, containerId)) throw new Error('容器不存在')

    const now = new Date().toISOString()
    const rec: CalcRecord = {
      id: randomUUID(),
      expression,
      result,
      resultKind: req.resultKind,
      container_id: containerId,
      saved: false,
      created: now,
      updated: now,
    }
    if (req.title !== undefined) putOptionalText(rec, 'title', req.title)
    if (req.note !== undefined) putOptionalText(rec, 'note', req.note)

    await this.mutateStore(w, (store, markChanged) => {
      store[rec.id] = rec
      markChanged()
    })
    this.logger?.info(`计算记一条: ${rec.expression} = ${rec.result}`)
    return rec
  }

  /**
   * 补丁式更新（§七：update(标题·备注·saved)）：只有出现的字段被改动；
   * title/note 传 ''（或纯空格）清空；saved 双向可切（true=标记，false=取消标记）。
   * 三个字段都没出现 = no-op（不改盘、不刷 updated）。容器归属不在此改（记录不做跨容器搬家）。
   */
  async update(req: CalcUpdateRequest, ws?: string): Promise<CalcRecord> {
    if (!req || typeof req.id !== 'string' || req.id.trim() === '') throw new Error('缺少记录 id')
    const hasTitle = req.title !== undefined
    const hasNote = req.note !== undefined
    const hasSaved = req.saved !== undefined
    // 类型校验放在动盘之前：`saved: 'true'`（字符串）旧写法会被 `=== true` 静默当 false —— 等于悄悄取消标记
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

  /** 新建容器（名字 trim 后落盘；空名拒绝） */
  async createContainer(req: CalcContainerCreateRequest, ws?: string): Promise<CalcContainer> {
    const name = requireContainerName(req?.name)
    const rec: CalcContainer = { id: randomUUID(), name, created: new Date().toISOString() }
    await this.mutateContainerStore(ws, (store, markChanged) => {
      store[rec.id] = rec
      markChanged()
    })
    this.logger?.info(`计算容器新建: ${name}`)
    return rec
  }

  /** 容器重命名（只动 name；记录按 id 归属，不受影响）；同名 = no-op（不改盘、不刷 mtime） */
  async renameContainer(req: CalcContainerRenameRequest, ws?: string): Promise<CalcContainer> {
    if (!req || typeof req.id !== 'string' || req.id.trim() === '') throw new Error('缺少容器 id')
    const name = requireContainerName(req.name)
    const next = await this.mutateContainerStore(ws, (store, markChanged) => {
      if (!Object.hasOwn(store, req.id)) throw new Error('容器不存在')
      const c = store[req.id]
      const normalized = normalizeContainer(c)
      if (!normalized) throw new Error('容器结构非法')
      if (c.name !== name) {
        c.name = name
        markChanged()
      }
      return { ...normalized, name }
    })
    this.logger?.info(`计算容器重命名: ${req.id} → ${name}`)
    return next
  }

  /**
   * 删除容器 = **连其中记录一起删**（§四 细则 #1 拍板；确认文案在 UI 层点明条数）。
   * 返回连带删除的记录条数。先校验容器存在（拒绝空喊），再删记录、最后删容器：
   * 中途任一步失败都不会出现「容器没了、记录却留着」的假成功。
   */
  async removeContainer(id: string, ws?: string): Promise<number> {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('缺少容器 id')
    const w = this.resolveWs(ws)
    const containers = await this.loadContainerStore(w)
    if (!Object.hasOwn(containers, id)) throw new Error('容器不存在')

    const removed = await this.mutateStore(w, (store, markChanged) => {
      let n = 0
      for (const key of Object.keys(store)) {
        if (store[key]?.container_id === id) {
          delete store[key]
          n++
        }
      }
      if (n > 0) markChanged()
      return n
    })
    await this.mutateContainerStore(w, (store, markChanged) => {
      if (Object.hasOwn(store, id)) {
        delete store[id]
        markChanged()
      }
    })
    this.logger?.info(`计算容器删除: ${id}（连带记录 ${removed} 条）`)
    return removed
  }
}