/**
 * core 层统一日志接口（v2.4.9 S6-1）：主进程文件日志核心迁入本文件。
 * 不 import electron，node 直测；行为与 v2.4.2 src/main/log.ts 一致：
 * 本地日期文件名 main-YYYY-MM-DD.log、跨日轮转、行格式 [ISO] [level] msg、
 * console 双通道（[main] 前缀）、全程异常静默降级不抛。
 * 新增：容量上限清理（默认 20MB，写后节流检查，超限按日期删最旧日志文件，保留最新；
 * 当日单文件自身超限时截断到上限一半并保留完整行，P2-16b）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 统一日志接口：S1–S5 新模块构造注入本接口，测试注入 MemoryLogger 替身 */
export interface Logger {
  info(msg: string): void | Promise<void>
  warn(msg: string): void | Promise<void>
  error(msg: string): void | Promise<void>
}

export interface FileLoggerOptions {
  /** 日志目录（主进程传 app.getPath('logs')，测试传 tmp 目录） */
  logDir: string
  /** 时钟注入：跨日轮转 / ISO 时间戳 / 容量节流时间均取自本函数；每次调用返回新的 Date（默认 new Date()） */
  now?: () => Date
  /** 日志文件（main-*.log）总大小上限，默认 20MB；超限删最旧直至 ≤ 上限；当日单文件自身超限时截断到上限一半 */
  capacityBytes?: number
  /** 容量检查节流间隔（毫秒），默认 1 分钟；写日志后距上次检查 ≥ 间隔才执行 */
  capacityCheckIntervalMs?: number
}

const DEFAULT_CAPACITY_BYTES = 20 * 1024 * 1024
const DEFAULT_CAPACITY_CHECK_INTERVAL_MS = 60 * 1000
/** 保留天数：删除 N 天前的 main-YYYY-MM-DD.log（v2.4.2 沿用） */
const LOG_RETAIN_DAYS = 14
/** 仅统计/管理 main-YYYY-MM-DD.log，不碰其他文件 */
const LOG_FILE_RE = /^main-(\d{4}-\d{2}-\d{2})\.log$/

export class FileLogger implements Logger {
  private readonly logDir: string
  private readonly now: () => Date
  private readonly capacityBytes: number
  private readonly capacityCheckIntervalMs: number
  private stream: fsp.FileHandle | null = null
  private currentDate = ''
  private lastCapacityCheck = 0
  /** 构造期初始化（mkdir + 14 天清理）完成后再写文件；任何失败静默降级 */
  private readonly initPromise: Promise<void>

  constructor(opts: FileLoggerOptions) {
    this.logDir = opts.logDir
    this.now = opts.now ?? (() => new Date())
    this.capacityBytes = opts.capacityBytes ?? DEFAULT_CAPACITY_BYTES
    this.capacityCheckIntervalMs = opts.capacityCheckIntervalMs ?? DEFAULT_CAPACITY_CHECK_INTERVAL_MS
    this.initPromise = this.init().catch(() => {})
  }

  private async init(): Promise<void> {
    await fsp.mkdir(this.logDir, { recursive: true })
    await this.cleanupOldLogs()
  }

  async info(msg: string): Promise<void> {
    console.log(`[main] ${msg}`)
    await this.writeLine('info', msg)
  }

  async warn(msg: string): Promise<void> {
    console.warn(`[main] ${msg}`)
    await this.writeLine('warn', msg)
  }

  async error(msg: string): Promise<void> {
    console.error(`[main] ${msg}`)
    await this.writeLine('error', msg)
  }

  /** 删除 LOG_RETAIN_DAYS 天前的 main-*.log（初始化时执行一次，保留近期日志便于排查） */
  private async cleanupOldLogs(): Promise<void> {
    try {
      const cutoff = new Date(this.now().getTime() - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000)
      const cutoffStr = this.dateStr(cutoff)
      const files = await fsp.readdir(this.logDir)
      for (const f of files) {
        const m = LOG_FILE_RE.exec(f)
        if (m && m[1] < cutoffStr) {
          await fsp.rm(path.join(this.logDir, f), { force: true }).catch(() => {})
        }
      }
    } catch {
      // 清理失败不影响日志功能
    }
  }

  /** 容量上限清理：main-*.log 总大小 > capacityBytes 时按文件名日期升序删最旧（保留最新），直至 ≤ 上限 */
  private async checkCapacity(): Promise<void> {
    try {
      const files = await fsp.readdir(this.logDir)
      const logs: { name: string; date: string; size: number }[] = []
      for (const name of files) {
        const m = LOG_FILE_RE.exec(name)
        if (!m) continue
        const st = await fsp.stat(path.join(this.logDir, name)).catch(() => null)
        if (st) logs.push({ name, date: m[1], size: st.size })
      }
      // 文件名本地日期升序 = 时间升序（YYYY-MM-DD 字典序即时间序）
      logs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      let total = logs.reduce((s, l) => s + l.size, 0)
      if (total <= this.capacityBytes) return
      // 删最旧（跳过最新——正在写入的文件不删），直至总大小 ≤ 上限
      for (let i = 0; i < logs.length - 1 && total > this.capacityBytes; i++) {
        await fsp.rm(path.join(this.logDir, logs[i].name), { force: true }).catch(() => {})
        total -= logs[i].size
      }
      // v2.5.3（P2-16b）：删完其余仍超限（当日单文件自身 > 上限，loop 保最新的豁免使旧删不动它）→
      // 对当日文件截断到上限一半（保留换行完整，最小实现）；防单日大日志无限膨胀
      if (total > this.capacityBytes && logs.length > 0) {
        const newest = logs[logs.length - 1]
        await this.truncateToLineBoundary(path.join(this.logDir, newest.name), Math.floor(this.capacityBytes / 2))
      }
    } catch {
      // 清理失败不影响日志功能
    }
  }

  /**
   * v2.5.3（P2-16b）：把文件截断到 ≤ target 字节，并前移到最后一行完整行边界
   * （保留头部完整行，不把某行截断成半行；窗口内找不到换行时按 target 保底）。
   * 最小实现：读 target 前 64KB 窗口找最后一个 \n（日志行短，窗口内必命中）。
   */
  private async truncateToLineBoundary(filePath: string, target: number): Promise<void> {
    if (target <= 0) return
    const handle = await fsp.open(filePath, 'r+')
    try {
      const st = await handle.stat()
      if (st.size <= target) return
      const window = Math.min(64 * 1024, target)
      const buf = Buffer.alloc(window)
      const { bytesRead } = await handle.read(buf, 0, window, target - window)
      let cut = target
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          cut = target - window + i + 1
          break
        }
      }
      await handle.truncate(cut)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** 按本地日期轮转：同日复用 FileHandle，跨日关旧开新（追加模式） */
  private async getStream(): Promise<fsp.FileHandle | null> {
    const date = this.dateStr(this.now())
    if (this.stream && this.currentDate === date) return this.stream
    try {
      await this.stream?.close()
    } catch {
      // 忽略
    }
    this.currentDate = date
    try {
      this.stream = await fsp.open(path.join(this.logDir, `main-${date}.log`), 'a')
      return this.stream
    } catch {
      return null
    }
  }

  private async writeLine(level: 'info' | 'warn' | 'error', msg: string): Promise<void> {
    await this.initPromise
    try {
      const s = await this.getStream()
      if (!s) return
      await s.write(`[${this.now().toISOString()}] [${level}] ${msg}\n`)
      // 容量清理：写后节流检查（距上次检查 ≥ 间隔才执行）
      const nowMs = this.now().getTime()
      if (nowMs - this.lastCapacityCheck >= this.capacityCheckIntervalMs) {
        this.lastCapacityCheck = nowMs
        await this.checkCapacity()
      }
    } catch {
      // 静默：日志不可用不抛
    }
  }

  private dateStr(d: Date): string {
    // 用本地日期命名日志文件（toISOString 是 UTC，会导致跨时区文件错日）
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}

/** 内存 logger 测试替身：记录调用数组，不写文件不打印 console（供 S1–S5 模块测试注入断言） */
export class MemoryLogger implements Logger {
  calls: { level: 'info' | 'warn' | 'error'; msg: string }[] = []

  info(msg: string): void {
    this.calls.push({ level: 'info', msg })
  }

  warn(msg: string): void {
    this.calls.push({ level: 'warn', msg })
  }

  error(msg: string): void {
    this.calls.push({ level: 'error', msg })
  }
}
