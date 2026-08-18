/**
 * scripts/memory-measurement.mjs 的类型声明（供 tests/unit 静态检查使用；
 * 脚本本体为纯 JS，运行时不加载本文件）。与 .mjs 实现保持同步。
 */

/** Electron 进程角色分类（与 measure-memory.mjs 采样器逐字一致，未知角色会被拒绝） */
export type MemoryProcessRole = 'main' | 'renderer' | 'utility' | 'other'

/** 单个进程的内存采样行（对应采样器输出的 role= 行） */
export interface MemoryProcessInfo {
  role: MemoryProcessRole
  /** 采样器无 subtype 或为 '-' 时归一为 null */
  subtype: string | null
  pid: number
  /** 常驻集（KiB） */
  rssKb: number
  /** 按 RSS 比例分摊后的常驻集（KiB） */
  pssKb: number
  /** 私有常驻集（KiB） */
  privateKb: number
  /** 交换集（KiB） */
  swapKb: number
}

/** 单场景单次运行的内存合计样本 */
export interface MemorySample {
  rssKb: number
  pssKb: number
  privateKb: number
  swapKb: number
}

/** 某场景重复运行全部进程的合计 */
export interface MemoryTotal extends MemorySample {
  processCount: number
}

/** 单指标统计：中位数、P95、变异系数（%，保留两位小数） */
export interface MetricStats {
  median: number
  p95: number
  cv: number
}

/** summarizeMemoryRuns 输出的每个场景的统计 */
export interface MemoryScenarioSummary {
  samples: number
  rssKb: MetricStats
  pssKb: MetricStats
  privateKb: MetricStats
  swapKb: MetricStats
}

/** 解析测量参数：--autostart / --repeat N / --seed-plugins a.qbox,b.qbox；出现未知参数或非法值抛错 */
export function parseMemoryMeasurementArgs(argv: string[]): {
  autostart: boolean
  repeat: number
  seedPlugins: string[]
}

/** 解析采样器输出（role= 行，详见 measure-memory.mjs 的 SAMPLER 输出协议）；无进程或字段非法抛错 */
export function parseMemorySamplerOutput(output: string): MemoryProcessInfo[]

/** 按场景组合断言进程成分；expectations 传需存在/需缺席的角色，不符则抛错 */
export function assertMemorySnapshot(
  processes: MemoryProcessInfo[],
  expectations?: {
    requiresRenderer?: boolean
    rendererMustBeAbsent?: boolean
    requiresNetworkUtility?: boolean
  },
): void

/** 合计整张快照的 RSS/PSS/private/swap 与进程数 */
export function sumMemorySnapshot(processes: MemoryProcessInfo[]): MemoryTotal

/**
 * 按场景汇总多次运行：每个场景至少提供一次样本，否则该场景不输出；
 * 输出各指标的标准中位数（偶数样本取均值）、P95 与未圆整变异系数。
 */
export function summarizeMemoryRuns(runs: Array<Record<string, MemorySample>>): Record<string, MemoryScenarioSummary>

/**
 * 断言各场景 RSS 变异系数不超过 maxCv（默认 5%），否则抛错。
 * options.expectedSamples 提供时要求每个场景样本数严格等于该值（防止不完整样本被当基线）。
 * CV 以未圆整精度比较；错误信息中的展示值仍保留两位小数。
 */
export function assertStableMemorySummary(
  summary: Record<string, { samples?: number; rssKb?: { cv?: number } }>,
  options?: { maxCv?: number; expectedSamples?: number },
): void

/**
 * 自启态就绪断言：主进程 app.isReady() 必须为 true 且不得存在任何 BrowserWindow；
 * app 为 Playwright ElectronApplication（或提供 evaluate(fn, options) 的替身）。失败抛错。
 */
export function assertAutostartReady(app: unknown, timeoutMs?: number): Promise<{ ready: true; windowCount: 0 }>