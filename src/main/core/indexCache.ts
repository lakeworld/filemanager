/**
 * 工作区文件索引（Everything 式精简索引，v2.4.x）
 * - 每个叶子目录一张快照：目录自身 mtimeMs 签名 + 紧凑条目（元组，避免对象属性名重复占内存）
 * - 查询命中 → 纯内存展开 FileEntry（零 readdir/逐文件 stat/缩略图 IO）；签名变化（仅一次 stat）→ 重建
 * - 写操作与 fs.watch 事件显式 invalidate（dirtyDirs），查询时重建，不即时扫描
 * - 快照 LRU 上限（默认 4096），防长期运行无界增长
 * - save/load：userData/index/<workspaceHash>/index.json 紧凑 JSON，二次启动免全量扫描
 * 纯 TS：可在 node 环境直接测试。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { formatTime } from './workspace'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR } from './paths'
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
const DEFAULT_MAX = 4096

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
   * 遍历 ws/产品集 下各产品集的 图包 与 证书 目录的全部子文件夹，逐个构建快照；
   * 不可读/不存在的目录静默跳过。返回成功构建的目录数。
   */
  async build(ws: string, listRaw: (dir: string) => Promise<CompactItem[]>): Promise<number> {
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    let sets: import('node:fs').Dirent[]
    try {
      sets = await fsp.readdir(setsDir, { withFileTypes: true })
    } catch {
      return 0 // 产品集目录不存在/不可读 → 无目录可构建
    }
    let built = 0
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
    this.dirtyDirs.add(dir)
  }

  /** 清空快照与脏标记（工作区切换 / 测试） */
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
