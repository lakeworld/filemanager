/**
 * measure-memory.mjs 的类型声明（vitest node 侧 import 用；生产运行不受影响）。
 * 仅声明单测需要的导出：snapshot（可注入 sampler runner 以覆盖 fail-closed 重试路径）。
 */
import type { MemoryProcessInfo, MemoryTotal } from './memory-measurement.d.mts'

export interface MemorySnapshotResult {
  label: string
  processes: MemoryProcessInfo[]
  total: MemoryTotal
}

export type MemorySamplerRunner = (samplerPath: string, rootPid: number) => string | Promise<string>

export function snapshot(
  label: string,
  samplerPath: string,
  rootPid: number,
  expectations: {
    requiresRenderer?: boolean
    rendererMustBeAbsent?: boolean
    requiresNetworkUtility?: boolean
  },
  runSamplerImpl?: MemorySamplerRunner,
): Promise<MemorySnapshotResult>