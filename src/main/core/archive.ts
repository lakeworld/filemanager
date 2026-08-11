/**
 * 压缩分享 / 解压（v2.4.4）
 * 纯 TS + node 内置 zlib，零新增依赖（守体积红线 Linux ≤140MB / Windows ≤195MB）。
 * 全程流式，内存与文件大小无关（恒定缓冲，守内存红线）。
 *
 * - 压缩：手写 ZIP 容器（local header + 数据描述符 + central directory + EOCD），
 *   zlib.createDeflateRaw 逐 chunk 压缩；支持目录（含空目录条目）
 * - 解压：解析 EOCD/central directory 后按条目 inflate 流式写出；逐条目 CRC 校验
 * - 安全：zip-slip 防护（拒绝绝对路径 / .. 逃逸 / 盘符）、拒绝符号链接条目
 * - 编码：条目名按 ZIP 通用位 bit11（UTF-8）判断；非 UTF-8 按 GBK 解码（Windows 压缩包常见）
 * - 取消：条目间 + 大文件 chunk 间检测（isCancelled），中断清理半成品
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pipeline, finished } from 'node:stream/promises'
import { Transform, Writable } from 'node:stream'
import zlib from 'node:zlib'
import { isPathInsideWorkspaceReal, productSetFromFilePath, EXPORTS_DIR } from './paths'
import { resolveConflictName } from './naming'
import { WorkspaceService } from './workspace'
import type { ArchiveCompressRequest, ArchiveExtractRequest, ArchiveResult, ExportEntry } from '../../shared/types'

export interface ArchiveProgressCb {
  (done: number, total: number, current: string): void
}
export interface ArchiveCancelCb {
  (): boolean
}

// —— CRC32（ZIP 用，查表法，~1KB 表 + 循环，逐 chunk 增量）——
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

function dosDateTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return [time, date]
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v & 0xffff)
  return b
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}

/** 统一取消检查：抛错中断整条 pipeline（调用方捕获后清理半成品） */
class ZipCancelledError extends Error {
  constructor() {
    super('操作已取消')
    this.name = 'ZipCancelledError'
  }
}

// ==================== 压缩 ====================

/** 压缩条目（文件或目录） */
interface ZipSourceEntry {
  absPath: string
  entryName: string
  isDir: boolean
}

export interface CompressOpts {
  onProgress?: ArchiveProgressCb
  isCancelled?: ArchiveCancelCb
}

/** 压缩多个源到 zipPath（zipPath 须为可写的目标完整路径）。返回 {count, size} */
export async function compressToZip(
  sources: string[],
  zipPath: string,
  opts: CompressOpts = {},
): Promise<{ count: number; size: number }> {
  if (!sources || sources.length === 0) throw new Error('没有选择要压缩的文件')
  const entries = await expandCompressEntries(sources)
  if (entries.length === 0) throw new Error('没有可压缩的文件')

  const out = fs.createWriteStream(zipPath, { flags: 'w', mode: 0o644 })
  // v2.4.4：输出流错误防御——ENOENT（目录缺失）/ EEXIST / 磁盘满等错误不再以 unhandled 'error'
  // 事件炸进程（会让调用方挂起），而是记录后让写入/等待路径显式 reject
  let outErr: Error | null = null
  out.on('error', (e: Error) => {
    outErr = e
  })
  const central: Buffer[] = []
  const offsets: number[] = []
  let written = 0
  let totalBytes = 0

  const writeBuf = (buf: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (outErr) {
        reject(outErr)
        return
      }
      if (!out.write(buf)) {
        out.once('drain', () => {
          if (outErr) reject(outErr)
          else resolve()
        })
      } else resolve()
    })

  try {
    for (let i = 0; i < entries.length; i++) {
      if (opts.isCancelled?.()) throw new ZipCancelledError()
      const e = entries[i]
      const localOffset = written
      const nameBuf = Buffer.from(e.entryName, 'utf8')
      let compSize = 0
      let srcSize = 0
      let srcCrc = 0

      if (e.isDir) {
        // 目录条目：method 0、大小 0，名字以 / 结尾；UTF-8 标记必须与文件条目一致
        const header = Buffer.concat([
          Buffer.from('PK\x03\x04', 'binary'),
          u16(20), // version needed
          u16(0x0800), // flags: UTF-8
          u16(0), // method: store
          u16(0),
          u16(0),
          u32(0),
          u32(0),
          u32(0),
          u16(nameBuf.length),
          u16(0),
        ])
        await writeBuf(header)
        await writeBuf(nameBuf)
        written += header.length + nameBuf.length
        central.push(makeCentralEntry(e.entryName, 0, 0, 0, 0, 0, localOffset, 0x0800, 0, true))
        offsets.push(localOffset)
        continue
      }

      // —— 文件条目：流式 deflate ——
      const [time, date] = dosDateTime(await fsp.stat(e.absPath).then((s) => s.mtime))
      const header = Buffer.concat([
        Buffer.from('PK\x03\x04', 'binary'),
        u16(20),
        u16(0x0808), // flags: data descriptor + UTF-8
        u16(8), // method: deflate
        u16(time),
        u16(date),
        u32(0), // crc（数据描述符里给）
        u32(0),
        u32(0),
        u16(nameBuf.length),
        u16(0),
      ])
      await writeBuf(header)
      await writeBuf(nameBuf)
      written += header.length + nameBuf.length

      const deflate = zlib.createDeflateRaw({ level: 6 })
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          if (outErr) {
            cb(outErr)
            return
          }
          compSize += chunk.length
          if (opts.isCancelled?.()) {
            cb(new ZipCancelledError())
            return
          }
          if (!out.write(chunk)) {
            out.once('drain', () => cb())
          } else cb()
        },
      })
      const crcT = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          srcCrc = crc32(chunk, srcCrc)
          srcSize += chunk.length
          cb(null, chunk)
        },
      })
      await pipeline(fs.createReadStream(e.absPath), crcT, deflate, sink)
      written += compSize

      // ZIP 格式限制：u32 大小字段 + u16 条目数，超限明确报错（不静默截断）
      if (srcSize > 0xffffffff || compSize > 0xffffffff) {
        throw new Error(`文件过大，单文件超 4GB 暂不支持 ZIP 打包：${e.entryName}`)
      }

      // 数据描述符
      await writeBuf(
        Buffer.concat([
          Buffer.from('PK\x07\x08', 'binary'),
          u32(srcCrc),
          u32(compSize),
          u32(srcSize),
        ]),
      )
      written += 16
      totalBytes += srcSize

      central.push(makeCentralEntry(e.entryName, srcCrc, compSize, srcSize, time, date, localOffset, 0x0808, 8, false))
      offsets.push(localOffset)
      opts.onProgress?.(i + 1, entries.length, e.entryName)
    }

    if (entries.length > 0xffff) {
      throw new Error('条目数超过 65535，暂不支持 ZIP64 打包')
    }
    if (written > 0xffffffff) {
      throw new Error('压缩包总大小超 4GB，暂不支持 ZIP64')
    }

    // —— central directory + EOCD ——
    const cdOffset = written
    const cdBuf = Buffer.concat(central)
    await writeBuf(cdBuf)
    written += cdBuf.length
    const eocd = Buffer.concat([
      Buffer.from('PK\x05\x06', 'binary'),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(cdBuf.length),
      u32(cdOffset),
      u16(0),
    ])
    await writeBuf(eocd)
    void offsets // 保留：4GB+ 时扩展 ZIP64 用（当前单包限 4GB，超出抛错）
  } finally {
    out.end()
    // v2.4.4：用 finished() 等资源释放（finish/close 均收敛，error 路径不挂起）；
    // 压缩错误由调用方（ArchiveService.compress）清理半成品包
    await finished(out).catch(() => {})
  }
  return { count: entries.length, size: totalBytes }
}

function makeCentralEntry(
  name: string,
  crc: number,
  compSize: number,
  srcSize: number,
  time: number,
  date: number,
  localOffset: number,
  flags: number,
  method: number,
  isDir: boolean,
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  return Buffer.concat([
    Buffer.from('PK\x01\x02', 'binary'),
    u16(20), // version made by
    u16(20), // version needed
    u16(flags),
    u16(method),
    u16(time),
    u16(date),
    u32(crc),
    u32(compSize),
    u32(srcSize),
    u16(nameBuf.length),
    u16(0), // extra len
    u16(0), // comment len
    u16(0), // disk
    u16(0), // internal attrs
    u32(isDir ? 0x10 : 0), // external attrs（目录位；文件 0）
    u32(localOffset),
    nameBuf,
  ])
}

/** 展开压缩源为条目列表：单目录 → dir/ 结构；多源 → 各自顶层平铺 */
async function expandCompressEntries(sources: string[]): Promise<ZipSourceEntry[]> {
  const out: ZipSourceEntry[] = []
  for (const raw of sources) {
    const p = raw.trim()
    if (!p) continue
    const info = await fsp.stat(p).catch(() => null)
    if (!info) throw new Error(`源不存在或不可读：${p}`)
    if (info.isDirectory()) {
      const base = path.basename(p)
      out.push({ absPath: p, entryName: `${base}/`, isDir: true })
      await walkDir(p, `${base}`, out)
    } else {
      out.push({ absPath: p, entryName: path.basename(p), isDir: false })
    }
  }
  return out
}

async function walkDir(dir: string, prefix: string, out: ZipSourceEntry[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return // 子目录不可读跳过
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    const name = `${prefix}/${e.name}`
    if (e.isDirectory()) {
      out.push({ absPath: full, entryName: `${name}/`, isDir: true })
      await walkDir(full, name, out)
    } else if (e.isFile()) {
      out.push({ absPath: full, entryName: name, isDir: false })
    }
  }
}

/** 自动压缩包命名：全部源属于同一产品集 → <产品集名>_分享；否则 分享_时间戳 */
export function suggestZipName(sources: string[], ws: string, ts = new Date()): string {
  const sets = new Set(sources.map((s) => productSetFromFilePath(ws, s.trim())).filter(Boolean))
  if (sets.size === 1) return `${sets.values().next().value as string}_分享`
  const pad = (n: number) => String(n).padStart(2, '0')
  return `分享_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
}

// ==================== 解压 ====================

interface CdEntry {
  name: string
  method: number
  flags: number
  crc: number
  compSize: number
  srcSize: number
  localOffset: number
  externalAttrs: number
  isDir: boolean
}

export interface ExtractOpts {
  onProgress?: ArchiveProgressCb
  isCancelled?: ArchiveCancelCb
}

/** 解压 zipPath 到 targetDir（必须已存在且为空以外的任意目录）。返回 {count, size} */
export async function extractZip(
  zipPath: string,
  targetDir: string,
  opts: ExtractOpts = {},
): Promise<{ count: number; size: number }> {
  await fsp.stat(zipPath)
  await fsp.mkdir(targetDir, { recursive: true })
  const entries = await readCentralDirectory(zipPath)
  if (entries.length === 0) throw new Error('压缩包为空或格式无效')

  let done = 0
  let totalBytes = 0
  for (const e of entries) {
    if (opts.isCancelled?.()) throw new ZipCancelledError()
    const safe = safeEntryName(e.name, zipPath, targetDir)
    if (!safe) continue // 危险条目：跳过（zip-slip 拦截）
    if (e.isDir) {
      await fsp.mkdir(safe, { recursive: true })
      done++
      opts.onProgress?.(done, entries.length, e.name)
      continue
    }
    await fsp.mkdir(path.dirname(safe), { recursive: true })
    // 冲突文件名加序号（复用命名引擎）；resolveConflictName 只返回文件名，须拼回目标目录
    const resolved = await resolveConflictName(path.dirname(safe), path.basename(safe), '_{n}', path.extname(safe))
    const finalPath = path.join(path.dirname(safe), resolved)
    await extractOne(zipPath, e, finalPath, opts)
    totalBytes += e.srcSize
    done++
    opts.onProgress?.(done, entries.length, e.name)
  }
  return { count: done, size: totalBytes }
}

/**
 * zip-slip 防护：条目名归一化后必须是 targetDir 内合法相对路径。
 * 返回安全目标路径；危险条目（绝对路径 / .. 逃逸 / 盘符 / 符号链接）返回 null（跳过）。
 */
function safeEntryName(entryName: string, zipPath: string, targetDir: string): string | null {
  if (entryName.includes('\\')) entryName = entryName.replace(/\\/g, '/')
  if (entryName.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(entryName)) return null // 盘符
  const parts = entryName.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return null
  for (const p of parts) {
    if (p === '..') return null
  }
  const isDir = entryName.endsWith('/')
  const rel = path.join(...parts)
  const target = path.resolve(targetDir, rel)
  // 最终解析路径必须仍在 targetDir 内
  if (target !== path.resolve(targetDir) && !target.startsWith(path.resolve(targetDir) + path.sep)) return null
  return isDir ? target : target
}

/** 读取 central directory（内存中只保留目录元数据，条目数据仍流式） */
async function readCentralDirectory(zipPath: string): Promise<CdEntry[]> {
  const fileSize = (await fsp.stat(zipPath)).size
  const fh = await fsp.open(zipPath, 'r')
  try {
    // EOCD：从文件尾部最多 64KB+22 字节中找 PK\x05\x06
    const tailLen = Math.min(fileSize, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, fileSize - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到目录尾）')
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset + cdSize > fileSize) throw new Error('zip 目录损坏')

    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)

    const entries: CdEntry[] = []
    let pos = 0
    while (pos + 46 <= cd.length) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) break
      const flags = cd.readUInt16LE(pos + 8)
      const method = cd.readUInt16LE(pos + 10)
      const crc = cd.readUInt32LE(pos + 16)
      const compSize = cd.readUInt32LE(pos + 20)
      const srcSize = cd.readUInt32LE(pos + 24)
      const nameLen = cd.readUInt16LE(pos + 28)
      const extraLen = cd.readUInt16LE(pos + 30)
      const commentLen = cd.readUInt16LE(pos + 32)
      const externalAttrs = cd.readUInt32LE(pos + 38)
      const localOffset = cd.readUInt32LE(pos + 42)
      const name = decodeEntryName(cd.subarray(pos + 46, pos + 46 + nameLen), flags)
      entries.push({
        name,
        method,
        flags,
        crc,
        compSize,
        srcSize,
        localOffset,
        externalAttrs,
        isDir: name.endsWith('/'),
      })
      pos += 46 + nameLen + extraLen + commentLen
    }
    if (entries.length === 0) throw new Error('zip 目录为空或损坏')
    return entries
  } finally {
    await fh.close()
  }
}

/** 条目名解码：bit11=UTF-8 用 utf8；否则优先 GBK（Windows 常见），失败回退 utf8 */
function decodeEntryName(buf: Buffer, flags: number): string {
  if (flags & 0x0800) return buf.toString('utf8')
  if (buf.some((b) => b > 0x7f)) {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      // TextDecoder 不支持 gbk（极端环境）→ utf8 兜底
    }
  }
  return buf.toString('utf8')
}

/** 流式解压单个条目到 finalPath，逐 chunk CRC 校验 */
async function extractOne(zipPath: string, e: CdEntry, finalPath: string, opts: ExtractOpts): Promise<void> {
  // 符号链接条目：跳过（安全）
  if (((e.externalAttrs >>> 16) & 0xf000) === 0xa000) return
  // 空文件：直接创建，不读流（compSize=0 时 readStream 的 end < start 行为不可靠）
  if (e.srcSize === 0) {
    const fh = await fsp.open(finalPath, 'wx', 0o644)
    await fh.close()
    return
  }
  const fh = await fsp.open(zipPath, 'r')
  try {
    // 读 local header，跳过 name/extra，定位数据起点
    const lh = Buffer.alloc(30)
    await fh.read(lh, 0, 30, e.localOffset)
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`条目损坏：${e.name}`)
    const nameLen = lh.readUInt16LE(26)
    const extraLen = lh.readUInt16LE(28)
    const dataStart = e.localOffset + 30 + nameLen + extraLen

    const out = fs.createWriteStream(finalPath, { flags: 'wx', mode: 0o644 })
    let outErr: Error | null = null
    out.on('error', (err: Error) => {
      outErr = err
    })
    let srcCrc = 0
    let got = 0
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (outErr) {
          cb(outErr)
          return
        }
        srcCrc = crc32(chunk, srcCrc)
        got += chunk.length
        if (opts.isCancelled?.()) {
          cb(new ZipCancelledError())
          return
        }
        if (!out.write(chunk)) {
          out.once('drain', () => cb())
        } else cb()
      },
    })
    let ok = false
    try {
      const src = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + e.compSize - 1 })
      if (e.method === 8) {
        const inflate = zlib.createInflateRaw()
        await pipeline(src, inflate, sink)
      } else if (e.method === 0) {
        await pipeline(src, sink)
      } else {
        throw new Error(`不支持的压缩方式（method=${e.method}），请使用标准 zip`)
      }
      if (outErr) throw outErr
      if (got !== e.srcSize || srcCrc !== e.crc) {
        throw new Error(`校验失败（文件可能已损坏）：${e.name}`)
      }
      ok = true
    } finally {
      out.end()
      // v2.4.4：finished() 收敛 finish/close/error 全路径，杜绝 close 等待挂起
      await finished(out).catch(() => {})
      if (!ok) {
        await fsp.rm(finalPath, { force: true }) // 失败/校验不过清理半成品
      }
    }
  } finally {
    await fh.close()
  }
}

// ==================== 服务（BoxService 装配） ====================

export class ArchiveService {
  /** 单任务守卫（v2.4.4 验收修复）：压缩/解压共享一把锁，防快速连点/多入口并发起第二个归档任务 */
  private taskRunning = false

  constructor(private workspace: WorkspaceService) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  private beginTask(): void {
    if (this.taskRunning) throw new Error('已有压缩/解压任务进行中，请等待其完成')
    this.taskRunning = true
  }

  /** 列出导出区产物（工作区/导出/ 下文件，按修改时间倒序；目录条目忽略；目录不存在返回空） */
  async listExports(): Promise<ExportEntry[]> {
    const ws = this.requireWS()
    const exportDir = path.join(ws, EXPORTS_DIR)
    let names: string[]
    try {
      names = await fsp.readdir(exportDir)
    } catch {
      return []
    }
    const entries: ExportEntry[] = []
    for (const name of names) {
      const full = path.join(exportDir, name)
      let st: fs.Stats
      try {
        st = await fsp.stat(full)
      } catch {
        continue // 竞态删除/不可读条目跳过
      }
      if (!st.isFile()) continue
      entries.push({
        name,
        path: full,
        size: st.size,
        mtime: st.mtime.toISOString(),
      })
    }
    return entries.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0))
  }

  /** 压缩分享：产物落 工作区/导出/，返回产物路径 */
  async compress(
    req: ArchiveCompressRequest,
    opts: CompressOpts = {},
  ): Promise<ArchiveResult> {
    this.beginTask()
    try {
      const ws = this.requireWS()
      if (!req.paths || req.paths.length === 0) throw new Error('没有选择要压缩的文件')
      for (const p of req.paths) {
        if (!(await isPathInsideWorkspaceReal(ws, p.trim()))) throw new Error('只能压缩工作区内的文件')
      }
      const exportDir = path.join(ws, EXPORTS_DIR)
      await fsp.mkdir(exportDir, { recursive: true })

      const name = (req.name ?? '').trim() || suggestZipName(req.paths, ws)
      const safeName = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.zip$/i, '')
      const fileName = await resolveConflictName(exportDir, `${safeName}.zip`, '_{n}', '.zip')
      const zipPath = path.join(exportDir, fileName)

      try {
        const { count, size } = await compressToZip(req.paths, zipPath, {
          onProgress: opts.onProgress,
          isCancelled: opts.isCancelled,
        })
        return { path: zipPath, count, size }
      } catch (err) {
        // 取消/失败：清理半成品压缩包（不残留垃圾文件）
        await fsp.rm(zipPath, { force: true }).catch(() => {})
        throw err
      }
    } finally {
      this.taskRunning = false
    }
  }

  /** 解压：here → 当前文件夹；folder → <zip 名>/ 子文件夹（冲突加序号） */
  async extract(req: ArchiveExtractRequest, opts: ExtractOpts = {}): Promise<ArchiveResult> {
    this.beginTask()
    try {
      const ws = this.requireWS()
      const zipPath = req.zipPath.trim()
      if (!zipPath) throw new Error('缺少压缩包路径')
      if (!(await isPathInsideWorkspaceReal(ws, zipPath))) throw new Error('只能解压工作区内的压缩包')
      if (path.extname(zipPath).toLowerCase() !== '.zip') throw new Error('仅支持 .zip 文件')

      const baseDir = path.dirname(zipPath)
      const zipBase = path.basename(zipPath, '.zip')
      let targetDir: string
      if (req.mode === 'folder') {
        const folderName = await resolveConflictName(baseDir, zipBase, '_{n}', '')
        targetDir = path.join(baseDir, folderName)
      } else {
        targetDir = baseDir
      }

      const { count, size } = await extractZip(zipPath, targetDir, {
        onProgress: opts.onProgress,
        isCancelled: opts.isCancelled,
      })
      return { path: targetDir, count, size }
    } finally {
      this.taskRunning = false
    }
  }
}

/** 取消异常（IPC 层识别，事件置 cancelled） */
export { ZipCancelledError }
