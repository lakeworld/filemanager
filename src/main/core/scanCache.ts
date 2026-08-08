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
    if (hit && hit.sig === sig) return hit.count

    const count = await this.countFilesRaw(dir)
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
