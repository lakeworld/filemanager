/**
 * 工作区文件索引（Everything 式精简索引，v2.4.x）
 * - 每个叶子目录一张快照：目录自身 mtimeMs 签名 + 紧凑条目（元组，避免对象属性名重复占内存）
 * - 查询命中 → 纯内存展开 FileEntry（零 readdir/逐文件 stat/缩略图 IO）；签名变化（仅一次 stat）→ 重建
 * - 写操作与 fs.watch 事件显式 invalidate（dirtyDirs），查询时重建，不即时扫描
 * - 快照 LRU 上限（v2.4.6 起默认 512），防长期运行无界增长
 * - save/load：userData/index/<workspaceHash>/index.json 紧凑 JSON，二次启动免全量扫描
 * - v2.4.7（§4.5）：build() 增补 客户/<名>/<各子文件夹>、发票/<YYYY>/、入库/<YYYY>/ 三区扫描
 *   （与产品集同法逐目录快照；fs.watch 工作区根 recursive 天然覆盖，失效事件零改动）
 * - v2.4.9（§6.2）：build() 再增补 供应商/<名>/<各子文件夹>（两级，同客户）与 报价/<YYYY>/（一级，同发票/入库）
 * - v2.5.1（F1）：build() 产品集区扫描增补 文档/ 目录（与图包/证书并列）
 * 纯 TS：可在 node 环境直接测试。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { formatTime } from './workspace'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR, DOCS_DIR, CUSTOMERS_DIR, INVOICES_DIR, INBOUND_DIR, SUPPLIERS_DIR, QUOTES_DIR } from './paths'
import type { FileEntry } from '../../shared/types'

/** 紧凑条目：元组，避免对象属性名重复占用内存 */
export type CompactItem = [name: string, size: number, mtimeMs: number, type: string, thumb: 0 | 1]

interface DirSnapshot {
  sig: number
  items: CompactItem[]
}

/** 落盘文件名（root/index.json） */
const INDEX_FILE = 'index.json'
const INDEX_VERSION = 1
// v2.4.6：4096 → 512。单工作区工具 4096 目录快照过大（理论上限 60-120MB）；
// 512 足够覆盖单工作区目录规模，理论上限降到 ~8-15MB
const DEFAULT_MAX = 512
// 收尾轮（候选 3）：脏目录标记上限——fs.watch 事件洪水时防 Set 无界增长（见 invalidate）
const DIRTY_DIRS_MAX = 1024

export class WorkspaceIndex {
  private snapshots = new Map<string, DirSnapshot>()
  private dirtyDirs = new Set<string>()
  /**
   * 每目录失效代数（v2.5.3 T5-S2）：invalidate 递增；build/validate/query 重建目录后
   * 仅当「epoch 未再增长」（重建期间没有新的失效事件）才清除脏标记——
   * 重建期间到达的失效事件必须保留到提交后，不能被清理/load 抹掉。
   */
  private dirtyEpochs = new Map<string, number>()
  private readonly max: number
  private resolveThumb: (filePath: string) => string

  constructor(opts: { resolveThumb?: (filePath: string) => string; max?: number } = {}) {
    this.max = opts.max ?? DEFAULT_MAX
    this.resolveThumb = opts.resolveThumb ?? (() => '')
  }

  /**
   * 创建仅继承配置（max/resolveThumb）、快照与脏标记为空的候选索引（v2.5.3 T5）。
   * 重建全程只在 candidate 上写入；提交时才整体替换 target。
   */
  forkForRebuild(): WorkspaceIndex {
    return new WorkspaceIndex({ max: this.max, resolveThumb: this.resolveThumb })
  }

  /**
   * 整体接管 other 的快照与脏标记（v2.5.3 T5）。
   * 复制容器（新 Map/Set）——提交后 target 与过期 candidate 不得再共享可变状态；
   * 一次替换，禁止清空后慢慢填充（避免中间空窗）。
   * v2.5.3（T5-S2）：脏标记合并且集——候选保留的标记（重建期间经 session 失效）与
   * 重建期间直写本索引（globalWorkspaceIndex.invalidate，如 files/交换区）产生的标记
   * 都不得被提交抹掉；本索引侧仅保留 epoch 高于重建基线者（即本次重建期间新增的失效）。
   */
  replaceFrom(other: WorkspaceIndex, baselineEpochs?: ReadonlyMap<string, number>): void {
    this.snapshots = new Map(other.snapshots)
    const otherEpochs = other.epochSnapshot()
    const merged = new Set<string>(other.dirtyDirs)
    for (const d of this.dirtyDirs) {
      const base = baselineEpochs?.get(d) ?? 0
      // 仅保留「重建开始后新增」的直写失效（epoch 比基线高）；重建前的旧标记随旧快照一起丢弃
      if ((this.dirtyEpochs.get(d) ?? 0) > base) merged.add(d)
    }
    this.dirtyDirs = merged
    // epoch 修剪到仍为脏的目录（逐目录取双方最大值，保持计数单调）：
    // 防跨工作区切换后 epoch 表随候选并集无限累积（缺失条目等价于 0，不影响后续判定）
    const epochs = new Map<string, number>()
    for (const d of merged) {
      epochs.set(d, Math.max(this.dirtyEpochs.get(d) ?? 0, otherEpochs.get(d) ?? 0))
    }
    this.dirtyEpochs = epochs
  }

  /** 各目录失效代数快照（v2.5.3 T5-S2：beginRebuild 重建基线 / replaceFrom 合并且集用） */
  epochSnapshot(): Map<string, number> {
    return new Map(this.dirtyEpochs)
  }

  /**
   * v2.5.3（T5-S2）：重建成功后的脏标记清理——仅当该目录 epoch 未再增长
   * （重建期间没有新的失效事件）才清除标记；期间新增的失效必须保留，查询时再重建，
   * 避免「重建覆盖了重建后发生的变化」。清除时顺带删除 epoch 条目（标记已消费，
   * 计数不再需要；缺失条目等价于 0）。
   */
  private clearDirtyIfUnchanged(dir: string, epochAtStart: number): void {
    if ((this.dirtyEpochs.get(dir) ?? 0) === epochAtStart) {
      this.dirtyDirs.delete(dir)
      this.dirtyEpochs.delete(dir)
    }
  }

  /** 设置展开时的缩略图路径推导（files.ts 接线时注入；纯路径计算，无 IO） */
  setResolveThumb(fn: (filePath: string) => string): void {
    this.resolveThumb = fn
  }

  /** 目录签名：目录自身 mtimeMs；stat 失败（目录不存在）返回 null */
  private async dirSig(dir: string): Promise<number | null> {
    try {
      const st = await fsp.stat(dir)
      return st.mtimeMs
    } catch {
      return null
    }
  }

  /** 构建单个目录快照（listRaw 取紧凑条目 + stat 取签名）；stat 失败返回 null（不缓存） */
  private async buildSnapshot(dir: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<DirSnapshot | null> {
    const sig = await this.dirSig(dir)
    if (sig === null) return null
    const items = await listRaw(dir)
    return { sig, items }
  }

  /** LRU 插入：超限淘汰最久未用（Map 按插入序迭代，最旧的即首个 key） */
  private put(dir: string, snap: DirSnapshot): void {
    if (this.snapshots.size >= this.max) {
      const oldest = this.snapshots.keys().next().value
      if (oldest !== undefined) this.snapshots.delete(oldest)
    }
    this.snapshots.set(dir, snap)
  }

  /** LRU 触摸：删除后重插，移到末尾（最近使用） */
  private touch(dir: string, snap: DirSnapshot): void {
    this.snapshots.delete(dir)
    this.snapshots.set(dir, snap)
  }

  /** 紧凑条目 → FileEntry（纯内存展开；缩略图路径由 resolveThumb 纯函数推导，无 IO） */
  private expand(dir: string, items: CompactItem[]): FileEntry[] {
    const out: FileEntry[] = new Array(items.length)
    for (let i = 0; i < items.length; i++) {
      const [name, size, mtimeMs, type, thumb] = items[i]
      const full = path.join(dir, name)
      out[i] = {
        name,
        path: full,
        size,
        modified: formatTime(new Date(mtimeMs)),
        file_type: type,
        thumbnail_path: thumb ? this.resolveThumb(full) : '',
      }
    }
    return out
  }

  /**
   * 遍历工作区各区域的叶子目录，逐个构建快照：
   * - 产品集区：{产品集}/{图包|证书}/{子文件夹}（现有逻辑）
   * - 客户区：{客户}/{客户名}/{子文件夹}
   * - 供应商区：{供应商}/{供应商名}/{子文件夹}（v2.4.9 S2 同构客户）
   * - 发票/入库区：{发票|入库}/{YYYY}（文件直接归档在年份目录下）
   * - 报价区：{报价}/{YYYY}（v2.4.9 S3 同构发票/入库）
   * 不可读/不存在的目录静默跳过。返回成功构建的目录数。
   */
  async build(ws: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    let built = 0
    // —— 产品集区（现有）——
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const sets = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const s of sets) {
      if (!s.isDirectory()) continue
      for (const typeDir of [IMAGES_DIR, CERTS_DIR, DOCS_DIR]) {
        const typePath = path.join(setsDir, s.name, typeDir)
        const subs = await fsp.readdir(typePath, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
        for (const sub of subs) {
          if (!sub.isDirectory()) continue
          const d = path.join(typePath, sub.name)
          // v2.5.3（T5-S2）：记录构建前 epoch——重建期间新失效的目录保留脏标记
          const epochAtStart = this.dirtyEpochs.get(d) ?? 0
          const snap = await this.buildSnapshot(d, listRaw).catch(() => null)
          if (snap) {
            this.put(d, snap)
            this.clearDirtyIfUnchanged(d, epochAtStart) // 已重建且期间无新失效 → 清除标记
            built++
          }
        }
      }
    }
    // —— v2.4.7（§4.5）：客户 / 发票 / 入库 三区（产品集区缺失也继续扫区域，目录不存在时 readdir 为空）——
    const customersDir = path.join(ws, CUSTOMERS_DIR)
    const customers = await fsp.readdir(customersDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const c of customers) {
      if (!c.isDirectory()) continue
      built += await this.buildLeafSnapshots(path.join(customersDir, c.name), listRaw)
    }
    built += await this.buildLeafSnapshots(path.join(ws, INVOICES_DIR), listRaw)
    built += await this.buildLeafSnapshots(path.join(ws, INBOUND_DIR), listRaw)
    // —— v2.4.9（§6.2）：供应商（两级，同客户）/ 报价（一级，同发票/入库）——
    const suppliersDir = path.join(ws, SUPPLIERS_DIR)
    const suppliers = await fsp.readdir(suppliersDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const s of suppliers) {
      if (!s.isDirectory()) continue
      built += await this.buildLeafSnapshots(path.join(suppliersDir, s.name), listRaw)
    }
    built += await this.buildLeafSnapshots(path.join(ws, QUOTES_DIR), listRaw)
    return built
  }

  /** v2.4.7：逐目录快照 root 下的一级子目录（客户/<名>/<子文件夹>、发票/<YYYY>/、入库/<YYYY>/） */
  private async buildLeafSnapshots(root: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    let built = 0
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const d = path.join(root, e.name)
      // v2.5.3（T5-S2）：同 build()——重建期间新失效的目录保留脏标记
      const epochAtStart = this.dirtyEpochs.get(d) ?? 0
      const snap = await this.buildSnapshot(d, listRaw).catch(() => null)
      if (snap) {
        this.put(d, snap)
        this.clearDirtyIfUnchanged(d, epochAtStart)
        built++
      }
    }
    return built
  }

  /**
   * 查询目录文件列表：
   * 1. dirtyDirs 含 dir → 直接重建（listRaw + stat 签名）后返回
   * 2. stat(dir) 失败 → [] 不缓存（目录不存在，顺带清掉可能残留的旧快照）
   * 3. 快照命中且签名一致 → 纯内存展开（零 readdir/逐文件 stat/缩略图 IO），LRU 触摸
   * 4. 否则 listRaw 重建并缓存
   */
  async query(dir: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<FileEntry[]> {
    if (this.dirtyDirs.has(dir)) {
      // v2.5.3（T5-S2）：重建期间新失效的目录保留标记——重建 snapshot 后 epoch 未再增长才清除
      const epochAtStart = this.dirtyEpochs.get(dir) ?? 0
      const snap = await this.buildSnapshot(dir, listRaw)
      if (snap) {
        this.put(dir, snap)
        this.clearDirtyIfUnchanged(dir, epochAtStart)
      } else {
        // 目录不存在：缓存与脏标记一并清掉（无快照可失效；下次存在时走签名路径重建）
        this.snapshots.delete(dir)
        this.dirtyDirs.delete(dir)
        this.dirtyEpochs.delete(dir)
      }
      return snap ? this.expand(dir, snap.items) : []
    }
    const sig = await this.dirSig(dir)
    if (sig === null) {
      // 目录不存在 → 空列表，不缓存（目录恢复后重新 stat 即重建）
      this.snapshots.delete(dir)
      return []
    }
    const hit = this.snapshots.get(dir)
    if (hit && hit.sig === sig) {
      this.touch(dir, hit)
      return this.expand(dir, hit.items)
    }
    const snap = await this.buildSnapshot(dir, listRaw)
    if (snap) this.put(dir, snap)
    else this.snapshots.delete(dir)
    return snap ? this.expand(dir, snap.items) : []
  }

  /**
   * 标记目录为脏：写操作 / fs.watch 事件调用，查询时重建（不即时扫描）。
   * 覆盖签名盲区——同目录 mtime 下的文件内容覆盖等变化。
   */
  invalidate(dir: string): void {
    // 收尾轮（候选 3）：脏标记有界——fs.watch 事件洪水（大目录批量操作）时防 Set 无界增长；
    // 超限清空旧标（洪水时旧标已无增量意义），query 按快照返回、全量 build 兜底
    // v2.5.3（P2-1）：洪水清空时同步修剪 epoch 表（只保留仍为脏的目录条目）——
    // 此前仅清 dirtyDirs，epoch 随洪水无限累积（唯一无界容器）；缺失条目等价 0，不破坏 T5-S2
    // 「重建期间新失效保留」的代数语义（照 replaceFrom 合并且集的修剪先例）
    if (this.dirtyDirs.size >= DIRTY_DIRS_MAX) {
      this.dirtyDirs.clear()
      this.dirtyEpochs.clear()
    }
    this.dirtyDirs.add(dir)
    // v2.5.3（T5-S2）：每目录失效代数单调递增——build/validate/query 清理标记时据此
    // 区分「重建期间的新失效」（必须保留）与「重建前的旧标记」（可清除）
    this.dirtyEpochs.set(dir, (this.dirtyEpochs.get(dir) ?? 0) + 1)
  }

  /** 脏目录标记数（v2.4.6 测试断言用，参照 ThumbQueue.pendingCount 先例） */
  get dirtyCount(): number {
    return this.dirtyDirs.size
  }

  /** 失效代数表条目数（v2.5.3 P2-1：洪泛后 epoch 表有界性断言用；正常应 ≤ dirtyCount） */
  get dirtyEpochCount(): number {
    return this.dirtyEpochs.size
  }

  /** 清空快照与脏标记（工作区切换 / 测试）。v2.4.6 核实：必须同时清空 dirtyDirs，否则脏标记滞留；T5-S2 起 epoch 一并清空 */
  clear(): void {
    this.snapshots.clear()
    this.dirtyDirs.clear()
    this.dirtyEpochs.clear()
  }

  /** 落盘快照：root/index.json（{ v, dirs: { dir: [sig, items] } }，紧凑 JSON 原子写） */
  async save(root: string): Promise<void> {
    const dirs: Record<string, [number, CompactItem[]]> = {}
    for (const [dir, snap] of this.snapshots) dirs[dir] = [snap.sig, snap.items]
    await fsp.mkdir(root, { recursive: true })
    const filePath = path.join(root, INDEX_FILE)
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmpPath, JSON.stringify({ v: INDEX_VERSION, dirs }), { encoding: 'utf-8', mode: 0o644 })
    await fsp.rename(tmpPath, filePath)
  }

  /** 加载快照：成功返回 true；文件缺失/损坏返回 false（不校验签名，由调用方后台 validate 校验） */
  async load(root: string): Promise<boolean> {
    let raw: string
    try {
      raw = await fsp.readFile(path.join(root, INDEX_FILE), 'utf-8')
    } catch {
      return false // 文件缺失
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return false // 损坏 JSON
    }
    if (!data || typeof data !== 'object') return false
    const obj = data as { v?: unknown; dirs?: unknown }
    if (obj.v !== INDEX_VERSION || !obj.dirs || typeof obj.dirs !== 'object') return false
    // v2.5.3（T5-S2）：load 前的脏标记必须保留——重建期间到达的失效事件不得被
    // 「读盘清空」抹掉（epoch 计数同步保留，单调性不中断）；epoch 与标记随 load 合入
    const prevDirty = Array.from(this.dirtyDirs)
    this.snapshots.clear()
    this.dirtyDirs.clear()
    for (const [dir, val] of Object.entries(obj.dirs)) {
      if (!Array.isArray(val) || val.length !== 2) continue
      const sig = val[0]
      const items = val[1]
      if (typeof sig !== 'number' || !Array.isArray(items)) continue
      // 防部分损坏：只收合法 5 元紧凑条目
      const valid = items.filter(
        (it): it is CompactItem =>
          Array.isArray(it) &&
          it.length === 5 &&
          typeof it[0] === 'string' &&
          typeof it[1] === 'number' &&
          typeof it[2] === 'number' &&
          typeof it[3] === 'string' &&
          (it[4] === 0 || it[4] === 1),
      )
      this.snapshots.set(dir, { sig, items: valid })
    }
    // 候选合入后保留仍有效的脏标记（load 读盘快照对脏目录不可信，查询时需重建）
    for (const d of prevDirty) this.dirtyDirs.add(d)
    return true
  }

  /**
   * 启动校验（load 成功后调用）：逐目录 stat 比对签名，
   * 变化目录用 listRaw 重建、消失目录移除快照。返回发生变化的目录数。
   */
  async validate(listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    let changed = 0
    for (const dir of [...this.snapshots.keys()]) {
      const sig = await this.dirSig(dir)
      if (sig === null) {
        this.snapshots.delete(dir)
        changed++
        continue
      }
      const snap = this.snapshots.get(dir)
      if (snap && snap.sig === sig) continue
      // v2.5.3（T5-S2）：重建期间新失效的目录保留脏标记（同 build()）
      const epochAtStart = this.dirtyEpochs.get(dir) ?? 0
      const rebuilt = await this.buildSnapshot(dir, listRaw).catch(() => null)
      if (rebuilt) {
        this.put(dir, rebuilt)
        this.clearDirtyIfUnchanged(dir, epochAtStart)
      } else {
        this.snapshots.delete(dir)
      }
      changed++
    }
    return changed
  }
}

/** 全局单例（resolveThumb 由 files.ts 接线时注入） */
export const globalWorkspaceIndex = new WorkspaceIndex()

/**
 * 工作区索引重建会话（v2.5.3 T5）：
 * 重建期间失效事件进入 candidate；仅在 isCurrent() 时 commit 才替换 target。
 */
export interface WorkspaceIndexRebuildSession {
  readonly generation: number
  readonly candidate: WorkspaceIndex
  isCurrent(): boolean
  invalidate(dir: string): void
  commit(): boolean
}

/**
 * 候选索引代数协调器（v2.5.3 T5）：
 * 隔离「切换工作区时旧索引 build/load 污染当前全局索引」的竞态——旧 session 绝不触碰 target。
 */
export class WorkspaceIndexCoordinator {
  private generation = 0

  constructor(private readonly target: WorkspaceIndex) {}

  /** 递增代数并创建候选；每次调用返回独立 session 对象 */
  beginRebuild(): WorkspaceIndexRebuildSession {
    this.generation += 1
    const generation = this.generation
    // v2.5.3（T5-S2）：重建基线 = 各目录失效代数快照——提交时仅保留
    // epoch 高于基线（本次重建期间新增）的 target 直写失效标记，防把旧标记带入新索引
    const baseline = this.target.epochSnapshot()
    const candidate = this.target.forkForRebuild()
    return {
      generation,
      candidate,
      isCurrent: () => this.generation === generation,
      invalidate: (dir) => {
        if (this.generation === generation) candidate.invalidate(dir)
      },
      commit: () => {
        if (this.generation !== generation) return false
        this.target.replaceFrom(candidate, baseline)
        return true
      },
    }
  }
}
