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
  } catch {
    // 日志不可用时静默降级
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
