/**
 * v2.5.8（D3）：导入硬链接去重——纯逻辑模块（TDD，内部硬链接去重设计文档（已归档，不进公开仓）§3.1）。
 * 不引入持久化哈希（坚果云双机同步场景下持久索引有陈旧风险），索引按导入批次在锁内现建，
 * 候选哈希批内缓存（同批多文件命中同一候选不重算）。
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PRODUCT_SETS_DIR, CERTS_DIR, DOCS_DIR, isPathInsideWorkspaceReal } from './paths'

const HASH_CHUNK = 1024 * 1024
/** 部分哈希读取字节数（漏斗第②级：仅同大小组读文件头比对） */
const PARTIAL_HASH_BYTES = 64 * 1024

/** 文件大小 → 路径列表（内容索引，大小预筛用） */
export type ContentIndex = Map<number, string[]>

/** SHA-256 流式哈希（1MB 块读，不整载内存） */
export async function hashFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256')
  const fh = await fsp.open(p, 'r')
  try {
    const buf = Buffer.alloc(HASH_CHUNK)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, HASH_CHUNK)
      if (bytesRead === 0) break
      h.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return h.digest('hex')
}

/** 首 bytes 字节哈希（漏斗第②级；64KB ≤ 单块，一次读入） */
export async function partialHashFile(p: string, bytes = PARTIAL_HASH_BYTES): Promise<string> {
  const read = Math.min(bytes, HASH_CHUNK)
  const h = crypto.createHash('sha256')
  const fh = await fsp.open(p, 'r')
  try {
    const buf = Buffer.alloc(read)
    const { bytesRead } = await fh.read(buf, 0, read)
    if (bytesRead > 0) h.update(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
  return h.digest('hex')
}

/**
 * 遍历 「产品集/*」 下的证书/文档域递归收集「文件大小 → 路径列表」
 * （跳隐藏项；目录不存在跳过；每导入批次在锁内构建一次）。
 */
export async function buildContentIndex(ws: string): Promise<ContentIndex> {
  const index: ContentIndex = new Map()
  const psRoot = path.join(ws, PRODUCT_SETS_DIR)
  let psEntries: import('node:fs').Dirent[]
  try {
    psEntries = await fsp.readdir(psRoot, { withFileTypes: true })
  } catch {
    return index
  }
  for (const ps of psEntries) {
    if (!ps.isDirectory() || ps.name.startsWith('.')) continue
    for (const domain of [CERTS_DIR, DOCS_DIR]) {
      await walkIndex(path.join(psRoot, ps.name, domain), index, ws)
    }
  }
  return index
}

async function walkIndex(dir: string, index: ContentIndex, ws: string): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return // 证书/文档目录不存在（未建齐）时跳过
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walkIndex(full, index, ws)
      continue
    }
    // 形态照 listDirFilesRecursive：经 stat（跟随符号链接）判定，symlink 文件同样纳入
    if (!e.isFile() && !e.isSymbolicLink()) continue
    const info = await fsp.stat(full).catch(() => null)
    if (!info || !info.isFile()) continue
    let registered = full
    if (e.isSymbolicLink()) {
      // link(2) 不解引用 symlink——索引登记解析后的真实文件路径，且不得逃逸工作区（与列表 realpath 边界同规）
      registered = await fsp.realpath(full).catch(() => '')
      if (!registered || !(await isPathInsideWorkspaceReal(ws, registered))) continue
    }
    const list = index.get(info.size)
    if (list) list.push(registered)
    else index.set(info.size, [registered])
  }
}

/** 批内落盘文件登记进索引（同批后续同内容文件直接建链） */
export function registerContent(index: ContentIndex, filePath: string, size: number): void {
  const list = index.get(size)
  if (list) list.push(filePath)
  else index.set(size, [filePath])
}

/**
 * 大小预筛 → 仅同大小候选逐个哈希比对 → 返回首个命中路径或 null。
 * 候选哈希批内缓存（cache 由调用方持有，跨批不缓存）。
 */
export async function findContentMatch(
  index: ContentIndex,
  srcSize: number,
  srcHash: string,
  cache: Map<string, string>,
): Promise<string | null> {
  for (const p of index.get(srcSize) ?? []) {
    let h = cache.get(p)
    if (h === undefined) {
      h = await hashFile(p).catch((err) => {
        console.warn('[dedup] 候选哈希失败，本批跳过该候选:', err)
        return ''
      })
      cache.set(p, h)
    }
    if (h && h === srcHash) return p
  }
  return null
}

export interface FindContentGroupsOpts {
  /** 每处理完一个候选让出事件循环（sweep 串行节流用） */
  yield?: () => Promise<void>
  onProgress?: (done: number, total: number) => void
}

/**
 * v2.5.8（D3.5）：去重巡检漏斗——大小分组（零内容 IO）→ 首 64KB 部分哈希 → 全量 SHA-256，
 * 返回同内容组（每组 ≥2 路径，组内排序）。哈希缓存放组内局部，组完即弃；读失败候选跳过。
 */
export async function findContentGroups(
  index: ContentIndex,
  opts?: FindContentGroupsOpts,
): Promise<string[][]> {
  const sizeGroups = [...index.entries()].filter(([, list]) => list.length >= 2)
  const total = sizeGroups.reduce((t, [, list]) => t + list.length, 0)
  const groups: string[][] = []
  let done = 0
  for (const [, paths] of sizeGroups) {
    // 第②级：部分哈希
    const byHead = new Map<string, string[]>()
    for (const p of paths) {
      const head = await partialHashFile(p).catch(() => '')
      if (head) {
        const list = byHead.get(head)
        if (list) list.push(p)
        else byHead.set(head, [p])
      }
      done++
      opts?.onProgress?.(done, total)
      if (opts?.yield) await opts.yield()
    }
    // 第③级：全量哈希（仅部分哈希撞上的候选）
    for (const candidates of byHead.values()) {
      if (candidates.length < 2) continue
      const byFull = new Map<string, string[]>()
      for (const p of candidates) {
        const full = await hashFile(p).catch(() => '')
        if (full) {
          const list = byFull.get(full)
          if (list) list.push(p)
          else byFull.set(full, [p])
        }
        if (opts?.yield) await opts.yield()
      }
      for (const g of byFull.values()) {
        if (g.length >= 2) groups.push(g.sort())
      }
    }
  }
  return groups
}
