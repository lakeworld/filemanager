import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

export type JsonReadReason = 'missing' | 'invalid' | 'io'

export type JsonReadResult<T> =
  | { ok: true; value: T; backupPath?: string }
  | { ok: false; reason: JsonReadReason; error?: Error; backupPath?: string }

export interface JsonReadOptions<T> {
  backupOnCorrupt?: boolean
  maxBackups?: number
  validate?: (value: unknown) => T | null
}

export interface JsonWriteOptions {
  durable?: boolean
  mode?: number
}

export interface JsonMutationOptions<T, R> {
  read: () => Promise<T>
  mutate: (value: T) => Promise<R> | R
  save: (value: T, result: R) => Promise<boolean>
  validate?: (value: unknown) => T | null
  lockTimeoutMs?: number
  durable?: boolean
  maxBackups?: number
}

const DEFAULT_MAX_BACKUPS = 3
const DEFAULT_LOCK_TIMEOUT_MS = 30_000

/** 每个绝对路径的事务尾部；仅协调当前进程内的同文件读改写。 */
const mutationTails = new Map<string, Promise<void>>()
const activeMutationPaths = new AsyncLocalStorage<Set<string>>()

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function normalizeMaxBackups(maxBackups?: number): number {
  if (!Number.isFinite(maxBackups)) return DEFAULT_MAX_BACKUPS
  return Math.min(DEFAULT_MAX_BACKUPS, Math.max(1, Math.floor(maxBackups!)))
}

function normalizeLockTimeout(lockTimeoutMs?: number): number {
  if (!Number.isFinite(lockTimeoutMs)) return DEFAULT_LOCK_TIMEOUT_MS
  return Math.max(0, Math.floor(lockTimeoutMs!))
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function corruptTimestamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function corruptBackupPath(filePath: string): string {
  return `${filePath}.corrupt-${corruptTimestamp()}-${randomBytes(3).toString('hex')}`
}

async function pruneCorruptBackups(filePath: string, maxBackups: number): Promise<void> {
  const directory = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.corrupt-`
  const names = (await fsp.readdir(directory))
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()

  await Promise.all(names.slice(maxBackups).map((name) => fsp.unlink(path.join(directory, name))))
}

/**
 * 为损坏 JSON 留证：优先移动原文件；跨卷/权限等移动失败时才复制。
 * 两种方式都失败时抛错，调用方不得在同一次 mutation 中继续覆盖。
 */
async function backupCorruptFile(filePath: string, maxBackups: number): Promise<string> {
  let renameError: Error | undefined
  let copyError: Error | undefined

  for (let attempt = 0; attempt < 8; attempt++) {
    const backupPath = corruptBackupPath(filePath)
    try {
      await fsp.rename(filePath, backupPath)
      await pruneCorruptBackups(filePath, maxBackups)
      return backupPath
    } catch (error) {
      renameError = toError(error)
    }

    try {
      await fsp.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL)
      await pruneCorruptBackups(filePath, maxBackups)
      return backupPath
    } catch (error) {
      copyError = toError(error)
      if (errorCode(error) === 'EEXIST') continue
      break
    }
  }

  const details = [renameError, copyError]
    .filter((error): error is Error => error !== undefined)
    .map((error) => error.message)
    .join('；')
  throw new Error(`无法备份损坏的 JSON 文件：${filePath}${details ? `（${details}）` : ''}`)
}

/**
 * 读取 JSON 并精确区分缺失、损坏与 I/O 失败。损坏默认先隔离/备份留证。
 */
export async function readJsonDetailed<T>(
  filePath: string,
  opts: JsonReadOptions<T> = {},
): Promise<JsonReadResult<T>> {
  const absolutePath = path.resolve(filePath)
  let raw: string
  try {
    raw = await fsp.readFile(absolutePath, 'utf-8')
  } catch (error) {
    const normalized = toError(error)
    if (errorCode(error) === 'ENOENT') return { ok: false, reason: 'missing', error: normalized }
    return { ok: false, reason: 'io', error: normalized }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!opts.validate) return { ok: true, value: parsed as T }
    const value = opts.validate(parsed)
    if (value === null) throw new Error('JSON 结构非法')
    return { ok: true, value }
  } catch (error) {
    const invalidError = toError(error)
    if (opts.backupOnCorrupt === false) return { ok: false, reason: 'invalid', error: invalidError }

    try {
      const backupPath = await backupCorruptFile(absolutePath, normalizeMaxBackups(opts.maxBackups))
      return { ok: false, reason: 'invalid', error: invalidError, backupPath }
    } catch (backupError) {
      const backupFailure = toError(backupError)
      return {
        ok: false,
        reason: 'invalid',
        error: new Error(`JSON 文件损坏，且备份失败：${absolutePath}（${backupFailure.message}）`),
      }
    }
  }
}

/**
 * mutation 专用读取：只有明确不存在才返回 null；损坏和任意其他 I/O 都拒绝覆盖。
 */
export async function readJsonForMutation<T>(
  filePath: string,
  opts: Pick<JsonReadOptions<T>, 'maxBackups' | 'validate'> = {},
): Promise<T | null> {
  const absolutePath = path.resolve(filePath)
  const result = await readJsonDetailed(absolutePath, opts)
  if (result.ok) return result.value
  if (result.reason === 'missing') return null

  const detail = result.error ? `：${result.error.message}` : ''
  if (result.reason === 'invalid') {
    throw new Error(`JSON 文件损坏，拒绝覆盖：${absolutePath}${detail}`)
  }
  throw new Error(`读取 JSON 文件失败，拒绝覆盖：${absolutePath}${detail}`)
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await fsp.open(directory, 'r')
    await handle.sync()
  } catch {
    // Windows 与部分文件系统不支持目录 fsync；原子 rename 已完成，目录同步仅尽力而为。
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

/**
 * 写入相邻临时文件后 rename，避免进程中断时直接截断目标文件。
 * durable 模式在 rename 前同步临时文件，并在 rename 后尽力同步父目录。
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  opts: JsonWriteOptions = {},
): Promise<void> {
  const absolutePath = path.resolve(filePath)
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  const content = JSON.stringify(data, null, 2)
  if (content === undefined) throw new Error(`无法序列化 JSON：${absolutePath}`)

  let handle: FileHandle | undefined
  let created = false
  try {
    handle = await fsp.open(tmpPath, 'wx', opts.mode ?? 0o644)
    created = true
    await handle.writeFile(content, { encoding: 'utf-8' })
    if (opts.durable) await handle.sync()
    await handle.close()
    handle = undefined

    await fsp.rename(tmpPath, absolutePath)
    created = false
    if (opts.durable) await syncDirectoryBestEffort(path.dirname(absolutePath))
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    if (created) await fsp.unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

function waitForPreviousMutation(previous: Promise<void>, timeoutMs: number, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`JSON 文件锁等待超时（${timeoutMs}ms）：${filePath}`))
    }, timeoutMs)
    previous.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function withPathMutationLock<T>(
  absolutePath: string,
  lockTimeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const parentPaths = activeMutationPaths.getStore()
  if (parentPaths?.has(absolutePath)) {
    throw new Error(`同一路径嵌套 JSON mutation 被拒绝：${absolutePath}`)
  }

  const previous = mutationTails.get(absolutePath) ?? Promise.resolve()
  let release!: () => void
  const ownDone = new Promise<void>((resolve) => {
    release = resolve
  })
  // 即便本次等待超时，tail 仍必须等前序事务完成，防止后续事务越过前序写入。
  const tail = previous.catch(() => undefined).then(() => ownDone)
  mutationTails.set(absolutePath, tail)
  void tail.then(() => {
    if (mutationTails.get(absolutePath) === tail) mutationTails.delete(absolutePath)
  })

  try {
    await waitForPreviousMutation(previous, lockTimeoutMs, absolutePath)
    const nextPaths = new Set(parentPaths ?? [])
    nextPaths.add(absolutePath)
    return await activeMutationPaths.run(nextPaths, operation)
  } finally {
    release()
  }
}

/**
 * 进程内同绝对路径的完整读改写事务。`save` 返回 false 时不触碰磁盘。
 * 不提供跨进程或跨文件事务保证。
 */
export async function mutateJsonFile<T, R>(
  filePath: string,
  opts: JsonMutationOptions<T, R>,
): Promise<R> {
  const absolutePath = path.resolve(filePath)
  return withPathMutationLock(absolutePath, normalizeLockTimeout(opts.lockTimeoutMs), async () => {
    const stored = await readJsonForMutation<T>(absolutePath, {
      validate: opts.validate,
      maxBackups: opts.maxBackups,
    })
    const value = stored === null ? await opts.read() : stored
    const result = await opts.mutate(value)
    if (await opts.save(value, result)) {
      await writeJsonAtomic(absolutePath, value, { durable: opts.durable ?? true })
    }
    return result
  })
}

/**
 * 整档覆盖式事务（v2.5.3 T2 共享 JSON 写路径统一入口）：
 * 严格读取先行——文件缺失按新值创建；文件损坏/读取失败即备份隔离并拒绝覆盖；否则原子替换为整份 data。
 * 走与 mutateJsonFile 相同的按路径串行锁，避免同文件并发覆盖丢更新。
 * metadata/config/product_sets/customers/suppliers/invoices/inbound/quotes/tags/exchange_state 等共享 JSON 一律经此写入。
 */
export async function overwriteJson<T>(
  filePath: string,
  data: T,
  opts: Pick<JsonMutationOptions<T, void>, 'lockTimeoutMs' | 'durable' | 'maxBackups' | 'validate'> = {},
): Promise<void> {
  const absolutePath = path.resolve(filePath)
  await withPathMutationLock(absolutePath, normalizeLockTimeout(opts.lockTimeoutMs), async () => {
    // 严格读取：损坏/IO 会先隔离备份并抛错（readJsonForMutation），不把损坏文件当空库覆盖
    await readJsonForMutation<T>(absolutePath, {
      validate: opts.validate,
      maxBackups: opts.maxBackups,
    })
    await writeJsonAtomic(absolutePath, data, { durable: opts.durable ?? true })
  })
}
