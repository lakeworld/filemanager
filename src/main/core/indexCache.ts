/**
 * 工作区文件索引（Everything 式精简索引，v2.4.x）
 * - 每个叶子目录一张快照：目录自身 mtimeMs 签名 + 紧凑条目（元组，避免对象属性名重复占内存）
 * - 查询命中 → 纯内存展开 FileEntry（零 readdir/逐文件 stat/缩略图 IO）；签名变化（仅一次 stat）→ 重建
 * - 写操作与 fs.watch 事件显式 invalidate（dirtyDirs），查询时重建，不即时扫描
 * - 快照 LRU 上限（v2.4.6 起默认 512），防长期运行无界增长
 * - save/load：userData/index/<workspaceHash>/index.json 紧凑 JSON，二次启动免全量扫描
 * - v2.4.7（§4.5）：build() 增补 客户/<名>/<各子文件夹>、发票/<YYYY>/、入库/<YYYY>/ 三区扫描
 *   （与产品集同法逐目录快照；fs.watch 工作区根 recursive 天然覆盖，失效事件零改动）
 * 纯 TS：可在 node 环境直接测试。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { formatTime } from './workspace'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR, CUSTOMERS_DIR, INVOICES_DIR, INBOUND_DIR } from './paths'
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
  private readonly max: number
  private resolveThumb: (filePath: string) => string

  constructor(opts: { resolveThumb?: (filePath: string) => string; max?: number } = {}) {
    this.max = opts.max ?? DEFAULT_MAX
    this.resolveThumb = opts.resolveThumb ?? (() => '')
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
   * - 发票/入库区：{发票|入库}/{YYYY}（文件直接归档在年份目录下）
   * 不可读/不存在的目录静默跳过。返回成功构建的目录数。
   */
  async build(ws: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    let built = 0
    // —— 产品集区（现有）——
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const sets = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const s of sets) {
      if (!s.isDirectory()) continue
      for (const typeDir of [IMAGES_DIR, CERTS_DIR]) {
        const typePath = path.join(setsDir, s.name, typeDir)
        const subs = await fsp.readdir(typePath, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
        for (const sub of subs) {
          if (!sub.isDirectory()) continue
          const d = path.join(typePath, sub.name)
          const snap = await this.buildSnapshot(d, listRaw).catch(() => null)
          if (snap) {
            this.put(d, snap)
            this.dirtyDirs.delete(d) // 已重建 → 失效标记视为处理完毕
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
    return built
  }

  /** v2.4.7：逐目录快照 root 下的一级子目录（客户/<名>/<子文件夹>、发票/<YYYY>/、入库/<YYYY>/） */
  private async buildLeafSnapshots(root: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    let built = 0
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const d = path.join(root, e.name)
      const snap = await this.buildSnapshot(d, listRaw).catch(() => null)
      if (snap) {
        this.put(d, snap)
        this.dirtyDirs.delete(d) // 已重建 → 失效标记视为处理完毕
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
    if (this.dirtyDirs.delete(dir)) {
      const snap = await this.buildSnapshot(dir, listRaw)
      if (snap) this.put(dir, snap)
      else this.snapshots.delete(dir)
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
    if (this.dirtyDirs.size >= DIRTY_DIRS_MAX) this.dirtyDirs.clear()
    this.dirtyDirs.add(dir)
  }

  /** 脏目录标记数（v2.4.6 测试断言用，参照 ThumbQueue.pendingCount 先例） */
  get dirtyCount(): number {
    return this.dirtyDirs.size
  }

  /** 清空快照与脏标记（工作区切换 / 测试）。v2.4.6 核实：必须同时清空 dirtyDirs，否则脏标记滞留 */
  clear(): void {
    this.snapshots.clear()
    this.dirtyDirs.clear()
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
    this.clear()
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
      const rebuilt = await this.buildSnapshot(dir, listRaw).catch(() => null)
      if (rebuilt) {
        this.put(dir, rebuilt)
        this.dirtyDirs.delete(dir) // 已重建 → 失效标记视为处理完毕
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
