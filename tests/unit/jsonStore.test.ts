import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', { spy: true })

import * as fsp from 'node:fs/promises'
import os from 'node:os'

const realFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
import path from 'node:path'
import {
  mutateJsonFile,
  readJsonDetailed,
  readJsonForMutation,
  writeJsonAtomic,
} from '../../src/main/core/jsonStore'
import {
  readJsonFile as readJsonFileFromPaths,
  writeJsonAtomic as writeJsonAtomicFromPaths,
} from '../../src/main/core/paths'

type Counter = { count: number }

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-json-store-'))
}

function validCounter(value: unknown): Counter | null {
  if (typeof value !== 'object' || value === null) return null
  return typeof (value as { count?: unknown }).count === 'number' ? value as Counter : null
}

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readJsonDetailed', () => {
  it('文件不存在时返回 missing 且不创建备份', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'missing.json')

    await expect(readJsonDetailed<Counter>(filePath)).resolves.toMatchObject({ ok: false, reason: 'missing' })
    expect(await fsp.readdir(dir)).toEqual([])
  })

  it('语法损坏时隔离原文件并返回 invalid 与备份路径', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'broken.json')
    const raw = '{not valid json'
    await fsp.writeFile(filePath, raw, 'utf-8')

    const result = await readJsonDetailed<Counter>(filePath, { validate: validCounter })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    if (result.ok || !result.backupPath) throw new Error('损坏读取必须返回备份路径')
    expect(path.basename(result.backupPath)).toMatch(/^broken\.json\.corrupt-\d{8}-\d{6}\.\d{3}-[0-9a-f]{6}$/)
    expect(await fsp.readFile(result.backupPath, 'utf-8')).toBe(raw)
    await expect(fsp.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('结构校验失败时返回 invalid 并备份原文件', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'wrong-shape.json')
    await fsp.writeFile(filePath, JSON.stringify({ count: 'not-number' }), 'utf-8')

    const result = await readJsonDetailed<Counter>(filePath, { validate: validCounter })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    if (result.ok || !result.backupPath) throw new Error('结构损坏必须返回备份路径')
    expect(await fsp.readFile(result.backupPath, 'utf-8')).toBe(JSON.stringify({ count: 'not-number' }))
  })

  it('未提供校验器时保留合法 JSON null 值', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'null.json')
    await fsp.writeFile(filePath, 'null', 'utf-8')

    await expect(readJsonDetailed<null>(filePath)).resolves.toEqual({ ok: true, value: null })
  })

  it('非 ENOENT 的读取失败返回 io', async () => {
    const dir = await tmp()
    const directoryPath = path.join(dir, 'not-a-json-file')
    await fsp.mkdir(directoryPath)

    await expect(readJsonDetailed(directoryPath)).resolves.toMatchObject({ ok: false, reason: 'io' })
  })

  it('rename 隔离失败时回退 copyFile 留存原始损坏内容', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'copy-fallback.json')
    const raw = '{copy fallback'
    await fsp.writeFile(filePath, raw, 'utf-8')
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errorWithCode('rename blocked', 'EPERM'))

    const result = await readJsonDetailed(filePath)

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    if (result.ok || !result.backupPath) throw new Error('copy 回退必须返回备份路径')
    expect(await fsp.readFile(result.backupPath, 'utf-8')).toBe(raw)
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(raw)
  })

  it('连续损坏时只保留最新三个 .corrupt-* 备份', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'rotate.json')

    for (let index = 1; index <= 4; index++) {
      await fsp.writeFile(filePath, `{broken-${index}`, 'utf-8')
      await expect(readJsonDetailed(filePath)).resolves.toMatchObject({ ok: false, reason: 'invalid' })
      await sleep(4)
    }

    const backups = (await fsp.readdir(dir)).filter((name) => name.startsWith('rotate.json.corrupt-')).sort()
    expect(backups).toHaveLength(3)
    await expect(Promise.all(backups.map((name) => fsp.readFile(path.join(dir, name), 'utf-8')))).resolves.toEqual([
      '{broken-2',
      '{broken-3',
      '{broken-4',
    ])
  })
})

describe('readJsonForMutation', () => {
  it('只将 missing 视为空库，invalid 与 io 都拒绝继续修改', async () => {
    const dir = await tmp()
    const missingPath = path.join(dir, 'missing.json')
    const invalidPath = path.join(dir, 'invalid.json')
    const ioPath = path.join(dir, 'directory.json')
    await fsp.writeFile(invalidPath, '{bad json', 'utf-8')
    await fsp.mkdir(ioPath)

    await expect(readJsonForMutation<Counter>(missingPath, { validate: validCounter })).resolves.toBeNull()
    await expect(readJsonForMutation<Counter>(invalidPath, { validate: validCounter })).rejects.toThrow()
    await expect(readJsonForMutation<Counter>(ioPath, { validate: validCounter })).rejects.toThrow()
  })
})

describe('writeJsonAtomic', () => {
  it('时钟相同的并发写入仍使用不同临时文件并留下完整 JSON', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'concurrent.json')
    vi.spyOn(Date, 'now').mockReturnValue(123456789)

    await expect(Promise.all([
      writeJsonAtomic(filePath, { writer: 1 }),
      writeJsonAtomic(filePath, { writer: 2 }),
    ])).resolves.toHaveLength(2)

    expect(JSON.parse(await fsp.readFile(filePath, 'utf-8'))).toMatchObject({ writer: expect.any(Number) })
    expect((await fsp.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('rename 失败后清理自己创建的临时文件', async () => {
    const dir = await tmp()
    const targetDirectory = path.join(dir, 'target-directory')
    await fsp.mkdir(targetDirectory)

    await expect(writeJsonAtomic(targetDirectory, { count: 1 })).rejects.toThrow()
    expect((await fsp.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('durable 写同步临时文件，目录同步失败仍不影响原子写', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'durable.json')
    const syncedPaths: string[] = []
    type OpenArgs = Parameters<typeof fsp.open>

    vi.spyOn(fsp, 'open').mockImplementation((async (...args: OpenArgs) => {
      const handle = await realFsp.open(...args)
      const openedPath = String(args[0])
      if (openedPath === dir) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory fsync unavailable'))
      } else {
        const originalSync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          syncedPaths.push(openedPath)
          return originalSync()
        })
      }
      return handle
    }) as typeof fsp.open)

    await expect(writeJsonAtomic(filePath, { durable: true }, { durable: true })).resolves.toBeUndefined()

    expect(syncedPaths.some((openedPath) => openedPath.startsWith(`${filePath}.tmp-`))).toBe(true)
    expect(JSON.parse(await fsp.readFile(filePath, 'utf-8'))).toEqual({ durable: true })
  })
})

describe('mutateJsonFile', () => {
  it('损坏读取先隔离原文件，且不会调用 mutate、save 或覆盖新 JSON', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'corrupt-store.json')
    const raw = '{corrupt store'
    const mutate = vi.fn<(value: Counter) => number>()
    const save = vi.fn<() => Promise<boolean>>()
    await fsp.writeFile(filePath, raw, 'utf-8')

    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate,
      save,
      validate: validCounter,
    })).rejects.toThrow()

    expect(mutate).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    const backups = (await fsp.readdir(dir)).filter((name) => name.startsWith('corrupt-store.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(raw)
    await expect(fsp.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('备份与隔离都失败时拒绝 mutation 并保留原损坏文件', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'backup-failure.json')
    const raw = '{cannot preserve'
    const mutate = vi.fn<(value: Counter) => number>()
    await fsp.writeFile(filePath, raw, 'utf-8')
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errorWithCode('rename blocked', 'EPERM'))
    vi.spyOn(fsp, 'copyFile').mockRejectedValueOnce(errorWithCode('copy blocked', 'EACCES'))

    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate,
      save: async () => true,
      validate: validCounter,
    })).rejects.toThrow()

    expect(mutate).not.toHaveBeenCalled()
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(raw)
  })

  it('其他 I/O 读取错误不会调用 mutation 或 save', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'not-a-file')
    const mutate = vi.fn<(value: Counter) => number>()
    const save = vi.fn<() => Promise<boolean>>()
    await fsp.mkdir(filePath)

    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate,
      save,
      validate: validCounter,
    })).rejects.toThrow()

    expect(mutate).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('missing 文件才调用默认 read，并在 save 为 true 时写入 mutation 结果', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'new-store.json')
    const read = vi.fn(async (): Promise<Counter> => ({ count: 4 }))

    const result = await mutateJsonFile<Counter, string>(filePath, {
      read,
      mutate: (value) => {
        value.count++
        return 'saved'
      },
      save: async () => true,
      validate: validCounter,
    })

    expect(result).toBe('saved')
    expect(read).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await fsp.readFile(filePath, 'utf-8'))).toEqual({ count: 5 })
  })

  it('按绝对路径串行完整读改写，避免并发 mutation 丢失更新', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'counter.json')
    const relativePath = path.relative(process.cwd(), filePath)
    await writeJsonAtomic(filePath, { count: 0 })

    await Promise.all(Array.from({ length: 8 }, (_, index) => mutateJsonFile<Counter, number>(
      index % 2 === 0 ? filePath : relativePath,
      {
        read: async () => ({ count: 0 }),
        mutate: async (value) => {
          const current = value.count
          await sleep(2)
          value.count = current + 1
          return value.count
        },
        save: async () => true,
        validate: validCounter,
      },
    )))

    expect(JSON.parse(await fsp.readFile(filePath, 'utf-8'))).toEqual({ count: 8 })
  })

  it('save 返回 false 时不落盘，也不刷新 mtime', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'unchanged.json')
    await writeJsonAtomic(filePath, { count: 7 })
    await sleep(20)
    const before = await fsp.stat(filePath)

    const result = await mutateJsonFile<Counter, string>(filePath, {
      read: async () => ({ count: 0 }),
      mutate: (value) => {
        value.count++
        return 'unchanged'
      },
      save: async () => false,
      validate: validCounter,
    })

    expect(result).toBe('unchanged')
    expect(await fsp.readFile(filePath, 'utf-8')).toContain('"count": 7')
    expect((await fsp.stat(filePath)).mtimeMs).toBe(before.mtimeMs)
  })

  it('等待同路径事务超过 lockTimeoutMs 时拒绝，后续事务仍可继续', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'locked.json')
    const entered = deferred()
    const release = deferred()
    await writeJsonAtomic(filePath, { count: 0 })

    const first = mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate: async (value) => {
        entered.resolve()
        await release.promise
        value.count++
        return value.count
      },
      save: async () => true,
      validate: validCounter,
    })
    await entered.promise

    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate: (value) => {
        value.count++
        return value.count
      },
      save: async () => true,
      validate: validCounter,
      lockTimeoutMs: 10,
    })).rejects.toThrow(/锁/)

    release.resolve()
    await expect(first).resolves.toBe(1)
    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate: (value) => {
        value.count++
        return value.count
      },
      save: async () => true,
      validate: validCounter,
    })).resolves.toBe(2)
  })

  it('同一路径嵌套 mutation 立即拒绝而非等待自身锁', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'nested.json')
    await writeJsonAtomic(filePath, { count: 0 })

    await expect(mutateJsonFile<Counter, number>(filePath, {
      read: async () => ({ count: 0 }),
      mutate: async (value) => {
        await expect(mutateJsonFile<Counter, number>(filePath, {
          read: async () => ({ count: 0 }),
          mutate: (nested) => {
            nested.count++
            return nested.count
          },
          save: async () => true,
          validate: validCounter,
        })).rejects.toThrow(/嵌套/)
        value.count++
        return value.count
      },
      save: async () => true,
      validate: validCounter,
    })).resolves.toBe(1)

    expect(JSON.parse(await fsp.readFile(filePath, 'utf-8'))).toEqual({ count: 1 })
  })
})

describe('overwriteJson（v2.5.3 T2 整档覆盖式事务）', () => {
  it('文件缺失时按新值创建', async () => {
    const { overwriteJson } = await import('../../src/main/core/jsonStore')
    const dir = await tmp()
    const filePath = path.join(dir, 'missing.json')
    await overwriteJson(filePath, { a: 1 })
    expect(JSON.parse(await realFsp.readFile(filePath, 'utf-8'))).toEqual({ a: 1 })
  })

  it('已有合法文件时整档替换', async () => {
    const { overwriteJson } = await import('../../src/main/core/jsonStore')
    const dir = await tmp()
    const filePath = path.join(dir, 'store.json')
    await realFsp.writeFile(filePath, JSON.stringify({ old: true }, null, 2))
    await overwriteJson(filePath, { new: [1, 2] })
    expect(JSON.parse(await realFsp.readFile(filePath, 'utf-8'))).toEqual({ new: [1, 2] })
  })

  it('损坏文件：隔离备份并拒绝覆盖，原始损坏内容转入备份不丢失', async () => {
    const { overwriteJson } = await import('../../src/main/core/jsonStore')
    const dir = await tmp()
    const filePath = path.join(dir, 'corrupt.json')
    await realFsp.writeFile(filePath, '{broken', 'utf-8')
    await expect(overwriteJson(filePath, { a: 1 })).rejects.toThrow(/损坏|覆盖/)
    // 隔离采用 rename：原始路径不再存在，损坏内容保存在 .corrupt-* 备份中
    await expect(realFsp.readFile(filePath, 'utf-8')).rejects.toThrow()
    const backups = (await realFsp.readdir(dir)).filter((n) => n.startsWith('corrupt.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(await realFsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe('{broken')
  })

  it('连续损坏写入只保留最多三个 .corrupt-* 备份', async () => {
    const { overwriteJson } = await import('../../src/main/core/jsonStore')
    const dir = await tmp()
    const filePath = path.join(dir, 'corrupt2.json')
    for (let i = 0; i < 5; i++) {
      await realFsp.writeFile(filePath, '{broken', 'utf-8')
      await expect(overwriteJson(filePath, { a: i })).rejects.toThrow(/损坏|覆盖/)
    }
    const backups = (await realFsp.readdir(dir)).filter((n) => n.startsWith('corrupt2.json.corrupt-'))
    expect(backups.length).toBe(3)
  })

  it('同路径并发整档覆盖按调用序串行执行（overwriteJson 为整档替换语义，最后提交者胜出）', async () => {
    const { overwriteJson } = await import('../../src/main/core/jsonStore')
    const dir = await tmp()
    const filePath = path.join(dir, 'serial.json')
    // 注意：overwriteJson 是整档替换 API，不存在 mutate 回调，天然 last-write-wins；
    // 本用例验证的是「同路径并发写被按路径锁串行化、不产生中间态/临时文件残留」——
    // 真并发读改写不丢更新由上方 mutateJsonFile 用例（并发 8 次 count++ 终值=8）断言。
    await Promise.all([
      overwriteJson(filePath, { v: 1 }),
      overwriteJson(filePath, { v: 2 }),
      overwriteJson(filePath, { v: 3 }),
    ])
    const final = JSON.parse(await realFsp.readFile(filePath, 'utf-8'))
    expect(final.v).toBe(3)
    expect((await realFsp.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })
})

describe('paths.ts 兼容薄壳', () => {
  it('保留旧 readJsonFile 与 writeJsonAtomic 的导入和回读语义', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'legacy.json')

    await writeJsonAtomicFromPaths(filePath, { count: 12 })

    await expect(readJsonFileFromPaths<Counter>(filePath)).resolves.toEqual({ count: 12 })
  })

  it('v2.5.3（T2）：readJsonFile 只读路径损坏时返回 null 且不移动/备份文件（留证交给写路径守卫）', async () => {
    const dir = await tmp()
    const filePath = path.join(dir, 'readonly-corrupt.json')
    const raw = '{bad json'
    await fsp.writeFile(filePath, raw, 'utf-8')

    await expect(readJsonFileFromPaths(filePath)).resolves.toBeNull()
    // 只读不移动、不产生 .corrupt-* 备份：损坏文件原位保留，写路径的隔离备份仍能留证
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(raw)
    expect((await fsp.readdir(dir)).filter((n) => n.startsWith('readonly-corrupt.json.corrupt-'))).toEqual([])
  })
})
