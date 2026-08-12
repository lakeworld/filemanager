/**
 * 主进程文件日志入口（v2.4.9 S6-1 薄壳）：核心能力迁至 core 层 FileLogger（src/main/core/logger.ts）。
 * 本文件仅负责 electron 侧初始化（app.getPath('logs')）与转发，导出签名与 v2.4.2 完全一致，现有调用零改动。
 */
import { app } from 'electron'
import { FileLogger, type Logger } from './core/logger'

let instance: FileLogger | null = null

export function initLogger(): void {
  try {
    instance = new FileLogger({ logDir: app.getPath('logs') })
  } catch {
    // 日志不可用时静默降级（后续 log() 仅 console 输出）
  }
}

/** 写日志：文件 + console 双通道（转发 core FileLogger） */
export async function log(level: 'info' | 'warn' | 'error', msg: string): Promise<void> {
  if (instance) {
    if (level === 'error') await instance.error(msg)
    else if (level === 'warn') await instance.warn(msg)
    else await instance.info(msg)
    return
  }
  // 未初始化（initLogger 未调用或失败）：仅 console 输出，保持旧行为
  if (level === 'error') {
    console.error(`[main] ${msg}`)
  } else if (level === 'warn') {
    console.warn(`[main] ${msg}`)
  } else {
    console.log(`[main] ${msg}`)
  }
}

/** 暴露 FileLogger 实例（v2.4.9 S6：供后续模块注入使用） */
export function getLogger(): Logger | null {
  return instance
}
