/**
 * 目录扫描缓存：基于目录树 mtime 签名，避免重复递归统计。
 * - sig = 目录及其全部后代目录的 mtime 集合哈希（目录内文件增删会更新对应目录 mtime）
 * - 缓存命中直接返回计数，避免完整递归
 * 纯 TS：可在 node 环境测试。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'

interface CacheEntry {
  sig: string
  count: number
}

export class CountCache {
  private cache = new Map<string, CacheEntry>()
  private inflight = new Map<string, Promise<number>>()
  /** v2.2.1：缓存条目上限（LRU 淘汰最久未用），防长期运行无界增长 */
  private readonly MAX_ENTRIES = 2048

  /** 目录树签名：收集本目录及所有后代目录 mtime，排序后哈希 */
  private async dirTreeSig(dir: string): Promise<string> {
    const mtimes: number[] = []
    const walk = async (d: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        const st = await fsp.stat(d)
        mtimes.push(st.mtimeMs)
        entries = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(d, e.name))
      }
    }
    await walk(dir)
    mtimes.sort((a, b) => a - b)
    const h = createHash('sha1')
    for (const m of mtimes) h.update(String(m))
    return h.digest('hex')
  }

  /** 递归统计目录内非隐藏文件数（带缓存） */
  async countFiles(dir: string): Promise<number> {
    const pending = this.inflight.get(dir)
    if (pending) return pending
    const task = this.doCount(dir)
    this.inflight.set(dir, task)
    try {
      return await task
    } finally {
      this.inflight.delete(dir)
    }
  }

  private async doCount(dir: string): Promise<number> {
    let sig: string
    try {
      sig = await this.dirTreeSig(dir)
    } catch {
      return 0
    }
    const hit = this.cache.get(dir)
    if (hit && hit.sig === sig) {
      // LRU 触摸：移到末尾
      this.cache.delete(dir)
      this.cache.set(dir, hit)
      return hit.count
    }

    const count = await this.countFilesRaw(dir)
    // LRU 淘汰：Map 按插入序迭代，超限删除最旧的
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(dir, { sig, count })
    return count
  }

  private async countFilesRaw(dir: string): Promise<number> {
    let count = 0
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          count += await this.countFilesRaw(path.join(dir, e.name))
        } else {
          count++
        }
      }
    } catch {
      // 目录不存在视为 0
    }
    return count
  }

  /** 清空缓存（测试用 / 工作区切换时） */
  clear(): void {
    this.cache.clear()
  }
}

/** 全局单例（供 workspace/search/dashboard 复用） */
export const globalCountCache = new CountCache()

// —— 文件列表缓存（v2.4.x）——

interface FileListCacheEntry<T> {
  sig: number
  entries: T[]
}

/**
 * 文件列表缓存：基于目录自身 mtime 签名，避免重复全量扫描（readdir + 逐文件 stat + 缩略图）。
 * - sig = 目录自身 mtimeMs（文件增删/改名会更新目录 mtime；文件内容修改不更新 → 由写操作显式 invalidate 兜底）
 * - 缓存命中直接返回条目数组：条目是不可变纯数据，直接引用不复制
 * - 目录不存在时返回空数组且不缓存（每次 stat 失败即返回空，目录重建后自动重新构建）
 * - 条目类型泛型 <T>，使用方（files.ts）以 FileEntry 实例化
 * 纯 TS：可在 node 环境测试。
 */
export class FileListCache<T> {
  private cache = new Map<string, FileListCacheEntry<T>>()
  private inflight = new Map<string, Promise<T[]>>()
  /** 缓存条目上限（LRU 淘汰最久未用），防长期运行无界增长 */
  private readonly MAX_ENTRIES = 512

  /** 目录签名：目录自身 mtimeMs；stat 失败（目录不存在）返回 null */
  private async dirSig(dir: string): Promise<number | null> {
    try {
      const st = await fsp.stat(dir)
      return st.mtimeMs
    } catch {
      return null
    }
  }

  /** 获取目录文件列表：命中且签名一致返回缓存；否则 build() 重建并缓存 */
  async get(dir: string, build: () => Promise<T[]>): Promise<T[]> {
    const pending = this.inflight.get(dir)
    if (pending) return pending
    const task = this.doGet(dir, build)
    this.inflight.set(dir, task)
    try {
      return await task
    } finally {
      this.inflight.delete(dir)
    }
  }

  private async doGet(dir: string, build: () => Promise<T[]>): Promise<T[]> {
    const sig = await this.dirSig(dir)
    if (sig === null) return [] // 目录不存在 → 空列表，不缓存（目录恢复后重新 stat 即重建）
    const hit = this.cache.get(dir)
    if (hit && hit.sig === sig) {
      // LRU 触摸：移到末尾
      this.cache.delete(dir)
      this.cache.set(dir, hit)
      return hit.entries
    }

    const entries = await build()
    // LRU 淘汰：Map 按插入序迭代，超限删除最旧的
    if (this.cache.size >= this.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(dir, { sig, entries })
    return entries
  }

  /** 删除指定目录缓存（写操作改变目录内容后调用；目录不存在时静默） */
  invalidate(dir: string): void {
    this.cache.delete(dir)
  }

  /** 清空缓存（测试用 / 工作区切换时） */
  clear(): void {
    this.cache.clear()
  }
}

/** 全局单例（条目类型由使用方按需断言，如 files.ts 以 FileEntry 使用） */
export const globalFileListCache = new FileListCache<unknown>()
