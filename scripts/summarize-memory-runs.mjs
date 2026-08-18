/**
 * T8 soak 结果汇总（v2.5.3）：读取三次 memory-soak-<ts>.json，计算
 * 正式轮 heap/nodes 的 median / p95 / 前后半程趋势 / CV，给出冻结阈值建议。
 * 用法：node scripts/summarize-memory-runs.mjs <soak-json> [soak-json ...]
 * 用法（目录）：node scripts/summarize-memory-runs.mjs memory-soak-results/memory-soak-*.json
 */
import fs from 'node:fs'

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new Error(`无法读取 ${filePath}：${err.message}`)
  }
}

function percentile(sorted, p) {
  return sorted[Math.ceil(sorted.length * p) - 1]
}

function median(sorted) {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((t, v) => t + v, 0) / sorted.length
  const variance = sorted.reduce((t, v) => t + (v - mean) ** 2, 0) / sorted.length
  return {
    median: median(sorted),
    p95: percentile(sorted, 0.95),
    mean,
    cv: mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100,
  }
}

/** 前后半程均值比（>1.25 视为持续增长） */
function trend(values) {
  if (values.length < 2) return 1
  const half = Math.floor(values.length / 2)
  const first = values.slice(0, half)
  const second = values.slice(half)
  const mean = (arr) => arr.reduce((t, v) => t + v, 0) / arr.length
  const m1 = mean(first)
  const m2 = mean(second)
  return m1 === 0 ? 1 : m2 / m1
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node scripts/summarize-memory-runs.mjs <memory-soak-*.json> [...]')
  process.exit(2)
}

const rawRuns = files.map((f, i) => ({ file: f, run: readJson(f) }))
// 跳过 partial（崩溃中途落盘）文件；正式轮不完整（≠20）直接失败，防冻结阈值被污染
const runs = []
for (const { file, run } of rawRuns) {
  if (run.partial === true) {
    console.warn(`跳过部分结果文件：${file}（partial=true，采集中断）`)
    continue
  }
  const formalCount = (run.rounds ?? []).filter((r) => r.formal === true).length
  if (formalCount !== 20) throw new Error(`${file}：正式轮数 ${formalCount} !== 20，不能用于冻结阈值`)
  runs.push({ file, run })
}
if (runs.length === 0) throw new Error('没有可用的完整 soak 结果（全部 partial 或读取失败）')
const heapSeries = []
const nodesSeries = []
const virtualImages = []
const perRun = []

for (const { file, run } of runs) {
  const formal = (run.rounds ?? []).filter((r) => r.formal === true)
  const heap = formal.map((r) => r.heapUsedBytes)
  const nodes = formal.map((r) => r.nodes)
  const imgs = formal.map((r) => r.virtualImageCount ?? 0)
  if (heap.length === 0) throw new Error(`${run.startedAt ?? '?'}：没有正式轮数据`)
  heapSeries.push(...heap)
  nodesSeries.push(...nodes)
  virtualImages.push(...imgs)
  perRun.push({
    file,
    formalRounds: formal.length,
    heapMedian: stats(heap).median,
    heapTrend: Number(trend(heap).toFixed(4)),
    nodesTrend: Number(trend(nodes).toFixed(4)),
    maxNodes: Math.max(...nodes),
    maxVirtualImages: Math.max(...imgs),
  })
}

const heapStat = stats(heapSeries)
const nodesStat = stats(nodesSeries)
const imgsStat = stats(virtualImages)

const summary = {
  schemaVersion: 1,
  runs: runs.length,
  skippedPartial: rawRuns.length - runs.length,
  perRun,
  heapUsedBytes: {
    ...heapStat,
    median: Math.round(heapStat.median),
    p95: Math.round(heapStat.p95),
    mean: Math.round(heapStat.mean),
    trend: Number(trend(heapSeries).toFixed(4)),
  },
  domNodes: {
    ...nodesStat,
    median: Math.round(nodesStat.median),
    p95: Math.round(nodesStat.p95),
    mean: Math.round(nodesStat.mean),
    trend: Number(trend(nodesSeries).toFixed(4)),
  },
  virtualImageCount: {
    ...imgsStat,
    median: Math.round(imgsStat.median),
    p95: Math.round(imgsStat.p95),
    max: Math.max(...virtualImages),
  },
  thresholdSuggestion: {
    // 冻结阈值建议：跨运行中位数 × 1.25 且不低于 p95（供动作文档冻结）
    heapMedianBytes: Math.round(heapStat.median * 1.25),
    nodesMedian: Math.round(nodesStat.median * 1.25),
    virtualImagesMax: Math.max(100, Math.max(...virtualImages)),
  },
}

console.log(JSON.stringify(summary, null, 2))
