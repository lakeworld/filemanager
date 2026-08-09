/**
 * 主进程文件日志：app.getPath('logs') 下按日期轮转。
 * 崩溃/异常/协议错误等关键事件落盘，便于排查。
 */
import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

let logDir = ''
let currentDate = ''
let stream: fsp.FileHandle | null = null

export function initLogger(): void {
  try {
    logDir = app.getPath('logs')
    void fsp.mkdir(logDir, { recursive: true })
    // v2.4.2（批次二）：启动时清理 14 天前的日志文件（防常驻运行一年 365 个文件无界增长）
    void cleanupOldLogs()
  } catch {
    // 日志不可用时静默降级
  }
}

/** 删除 N 天前的 main-YYYY-MM-DD.log（保留近期日志便于排查） */
const LOG_RETAIN_DAYS = 14
async function cleanupOldLogs(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000)
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
    const files = await fsp.readdir(logDir)
    for (const f of files) {
      const m = /^main-(\d{4}-\d{2}-\d{2})\.log$/.exec(f)
      if (m && m[1] < cutoffStr) {
        await fsp.rm(path.join(logDir, f), { force: true }).catch(() => {})
      }
    }
  } catch {
    // 清理失败不影响日志功能
  }
}

async function getStream(): Promise<fsp.FileHandle | null> {
  // 用本地日期命名日志文件（toISOString 是 UTC，会导致跨时区文件错日）
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (stream && currentDate === date) return stream
  try {
    await stream?.close()
  } catch {
    // 忽略
  }
  currentDate = date
  try {
    stream = await fsp.open(path.join(logDir, `main-${date}.log`), 'a')
    return stream
  } catch {
    return null
  }
}

/** 写日志：文件 + console 双通道 */
export async function log(level: 'info' | 'warn' | 'error', msg: string): Promise<void> {
  if (level === 'error') {
    console.error(`[main] ${msg}`)
  } else if (level === 'warn') {
    console.warn(`[main] ${msg}`)
  } else {
    console.log(`[main] ${msg}`)
  }
  try {
    const s = await getStream()
    if (s) {
      await s.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`)
    }
  } catch {
    // 静默
  }
}
