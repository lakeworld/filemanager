/**
 * core 统一日志接口单测（v2.4.9 S6-1）：node 直测，tmp 目录注入，不碰真实 logs。
 * 覆盖：三通道写文件+行格式、console 双通道、跨日轮转（假 now）、静默降级、
 * 容量上限清理（删最旧不删最新）、14 天日期清理、Logger 接口可 mock（MemoryLogger）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileLogger, MemoryLogger, type Logger } from '../../src/main/core/logger'

/** 创建独立临时日志目录 */
function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-'))
}

async function readLines(dir: string, name: string): Promise<string[]> {
  const content = await fsp.readFile(path.join(dir, name), 'utf8')
  return content.trimEnd().split('\n').filter((l) => l.length > 0)
}

// 全局静音 console（FileLogger 双通道会打印），并在 console 双通道用例中做路由断言
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('FileLogger 三通道写文件 + 行格式', () => {
  it('info/warn/error 各写一条 → 文件存在，行格式 [ISO] [level] msg', async () => {
    const dir = tmpLogDir()
    const logger = new FileLogger({ logDir: dir, now: () => new Date(2026, 7, 12, 10, 0, 0) })
    await logger.info('i-msg')
    await logger.warn('w-msg')
    await logger.error('e-msg')

    expect(fs.existsSync(path.join(dir, 'main-2026-08-12.log'))).toBe(true)
    const lines = await readLines(dir, 'main-2026-08-12.log')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[info\] i-msg$/)
    expect(lines[1]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[warn\] w-msg$/)
    expect(lines[2]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[error\] e-msg$/)
  })

  it('console 双通道：error→console.error / warn→console.warn / info→console.log，前缀 [main]', async () => {
    const dir = tmpLogDir()
    const logger = new FileLogger({ logDir: dir })
    await logger.info('a')
    await logger.warn('b')
    await logger.error('c')

    expect(console.log).toHaveBeenCalledWith('[main] a')
    expect(console.warn).toHaveBeenCalledWith('[main] b')
    expect(console.error).toHaveBeenCalledWith('[main] c')
  })
})

describe('FileLogger 跨日轮转', () => {
  it('假 now 前进一天 → 新文件 main-<新日期>.log 创建，旧文件保留', async () => {
    const dir = tmpLogDir()
    let t = new Date(2026, 7, 12, 23, 59, 59)
    const logger = new FileLogger({ logDir: dir, now: () => t })
    await logger.info('day1')

    t = new Date(2026, 7, 13, 0, 0, 1)
    await logger.warn('day2')

    const files = (await fsp.readdir(dir)).sort()
    expect(files).toEqual(['main-2026-08-12.log', 'main-2026-08-13.log'])
    expect(await readLines(dir, 'main-2026-08-12.log')).toEqual([expect.stringMatching(/\[info\] day1$/)])
    expect(await readLines(dir, 'main-2026-08-13.log')).toEqual([expect.stringMatching(/\[warn\] day2$/)])
  })
})

describe('FileLogger 静默降级不抛', () => {
  it('logDir 在普通文件之下（mkdir 失败）→ 不抛异常，不产生文件', async () => {
    const dir = tmpLogDir()
    const blocker = path.join(dir, 'blocker')
    await fsp.writeFile(blocker, 'x')
    const logger = new FileLogger({ logDir: path.join(blocker, 'logs') })

    await expect(logger.info('x')).resolves.toBeUndefined()
    await expect(logger.error('x')).resolves.toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual(['blocker'])
  })

  it('FileHandle 打开失败（文件名被目录占用）→ 不抛异常，静默跳过写盘', async () => {
    const dir = tmpLogDir()
    // 预占文件名：open(path, 'a') 对目录抛 EISDIR
    await fsp.mkdir(path.join(dir, 'main-2026-08-12.log'))
    const logger = new FileLogger({ logDir: dir, now: () => new Date(2026, 7, 12, 10, 0, 0) })

    await expect(logger.info('x')).resolves.toBeUndefined()
    const st = await fsp.stat(path.join(dir, 'main-2026-08-12.log'))
    expect(st.isDirectory()).toBe(true) // 仍是被占用的目录，未产生文件写入
  })
})

describe('FileLogger 容量上限清理（§3.6.5）', () => {
  it('小容量注入 → 撑爆后按日期删最旧（保留最新），总大小 ≤ 上限', async () => {
    const dir = tmpLogDir()
    const capacityBytes = 1024
    let t = new Date(2026, 7, 10, 10, 0, 0)
    const logger = new FileLogger({
      logDir: dir,
      now: () => t,
      capacityBytes,
      capacityCheckIntervalMs: 0, // 每次写后都检查，便于测试
    })
    // 每行约 300 字节，每天 2 条 ≈ 600 字节：单日 ≤ 上限、双日 > 上限
    const writeTwo = async (msg: string) => {
      await logger.info(msg)
      await logger.info(msg)
    }
    await writeTwo('x'.repeat(265)) // day1
    t = new Date(2026, 7, 11, 10, 0, 0)
    await writeTwo('y'.repeat(265)) // day2
    t = new Date(2026, 7, 12, 10, 0, 0)
    await writeTwo('z'.repeat(265)) // day3

    const files = (await fsp.readdir(dir)).sort()
    expect(files).toEqual(['main-2026-08-12.log']) // 最旧两日被删，最新保留
    let total = 0
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f))
      total += st.size
    }
    expect(total).toBeLessThanOrEqual(capacityBytes)
  })

  it('容量未超限 → 不删任何文件', async () => {
    const dir = tmpLogDir()
    let t = new Date(2026, 7, 10, 10, 0, 0)
    const logger = new FileLogger({
      logDir: dir,
      now: () => t,
      capacityBytes: 1024,
      capacityCheckIntervalMs: 0,
    })
    await logger.info('small') // 一行远小于 1KB
    t = new Date(2026, 7, 11, 10, 0, 0)
    await logger.info('small2')

    const files = (await fsp.readdir(dir)).sort()
    expect(files).toEqual(['main-2026-08-10.log', 'main-2026-08-11.log'])
  })

  it('当日单文件自身超限 → 截断到上限一半且保留完整行，后续写入不中断（P2-16b）', async () => {
    const dir = tmpLogDir()
    const capacityBytes = 4096
    const logger = new FileLogger({
      logDir: dir,
      now: () => new Date(2026, 7, 12, 10, 0, 0),
      capacityBytes,
      capacityCheckIntervalMs: 0, // 每次写后都检查，便于测试
    })
    // 每行约 312 字节；20 行 ≈ 6.2KB 单文件超限——「删最旧跳过最新」处理不了单文件超限，需截断兜底
    for (let i = 0; i < 20; i++) await logger.info('x'.repeat(280))
    const file = path.join(dir, 'main-2026-08-12.log')
    const st = await fsp.stat(file)
    expect(st.size).toBeLessThanOrEqual(capacityBytes) // 总大小回落到上限内
    expect(st.size).toBeLessThan(20 * 312) // 截断确实发生（不截断则 ≈ 6240B）
    // 保留完整行：文件末尾是换行符，每行均为完整行格式（无半行残尾）
    const content = await fsp.readFile(file, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    for (const line of content.trimEnd().split('\n')) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[info\] x+$/)
    }
    // 截断后继续写入不中断（日志功能不受影响）
    await logger.info('after-truncate')
    const lines = await readLines(dir, 'main-2026-08-12.log')
    expect(lines[lines.length - 1]).toMatch(/after-truncate$/)
  })
})

describe('FileLogger 14 天日期清理', () => {
  it('构造后：15 天前文件被删，13 天前与当日保留', async () => {
    const dir = tmpLogDir()
    // 预置旧日志（用文件内容标记）
    await fsp.writeFile(path.join(dir, 'main-2026-08-15.log'), 'old-15d\n') // 15 天前 → 删
    await fsp.writeFile(path.join(dir, 'main-2026-08-17.log'), 'old-13d\n') // 13 天前 → 留
    await fsp.writeFile(path.join(dir, 'main-2026-08-30.log'), 'today\n')

    const logger = new FileLogger({ logDir: dir, now: () => new Date(2026, 7, 30, 10, 0, 0) })
    await logger.info('probe') // 等构造期初始化（mkdir + 清理）完成

    const files = (await fsp.readdir(dir)).sort()
    expect(files).toEqual(['main-2026-08-17.log', 'main-2026-08-30.log'])
    // 当日文件被追加了探针行（预置内容在前，追加行在后）
    const lines = await readLines(dir, 'main-2026-08-30.log')
    expect(lines[0]).toBe('today')
    expect(lines[1]).toMatch(/\[info\] probe$/)
  })
})

describe('Logger 接口可 mock（测试替身）', () => {
  it('MemoryLogger 记录调用数组', () => {
    const mem = new MemoryLogger()
    mem.info('a')
    mem.warn('b')
    mem.error('c')
    expect(mem.calls).toEqual([
      { level: 'info', msg: 'a' },
      { level: 'warn', msg: 'b' },
      { level: 'error', msg: 'c' },
    ])
  })

  it('任意对象满足 Logger 接口即可注入（S1–S5 模块断言用）', () => {
    const mock: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    mock.info('x')
    mock.error('y')
    expect(mock.info).toHaveBeenCalledWith('x')
    expect(mock.error).toHaveBeenCalledWith('y')
    expect(mock.warn).not.toHaveBeenCalled()
  })
})
