export function parseMemoryMeasurementArgs(argv) {
  let autostart = false
  let repeat = 1
  let seedPlugins = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--autostart') {
      autostart = true
      continue
    }
    if (arg === '--repeat') {
      const value = argv[++index]
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--repeat 必须是大于 0 的整数')
      }
      repeat = parsed
      continue
    }
    if (arg === '--seed-plugins') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('--seed-plugins 需要至少一个 .qbox 路径')
      seedPlugins = value.split(',').map((item) => item.trim()).filter(Boolean)
      if (seedPlugins.length === 0) throw new Error('--seed-plugins 需要至少一个 .qbox 路径')
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  return { autostart, repeat, seedPlugins }
}

const ROLES = new Set(['main', 'renderer', 'utility', 'other'])
const NUMBER_FIELDS = ['pid', 'rss_kb', 'pss_kb', 'private_kb', 'swap_kb']

export function parseMemorySamplerOutput(output) {
  const processes = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('role=')) continue

    const fields = Object.fromEntries(
      line.split(/\s+/).map((field) => {
        const separator = field.indexOf('=')
        return [field.slice(0, separator), field.slice(separator + 1)]
      }),
    )
    if (!ROLES.has(fields.role)) throw new Error(`采样返回未知进程角色：${fields.role ?? '缺失'}`)

    const numbers = {}
    for (const field of NUMBER_FIELDS) {
      const value = Number(fields[field])
      const mustBePositive = field === 'pid' || field === 'rss_kb' || field === 'pss_kb'
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        (mustBePositive && value === 0)
      ) {
        throw new Error(`采样返回非法 ${field}：${fields[field] ?? '缺失'}`)
      }
      numbers[field] = value
    }

    processes.push({
      role: fields.role,
      subtype: fields.subtype && fields.subtype !== '-' ? fields.subtype : null,
      pid: numbers.pid,
      rssKb: numbers.rss_kb,
      pssKb: numbers.pss_kb,
      privateKb: numbers.private_kb,
      swapKb: numbers.swap_kb,
    })
  }

  if (processes.length === 0) throw new Error('内存采样未识别到 Electron 进程')
  return processes
}

export function assertMemorySnapshot(processes, expectations = {}) {
  const mainCount = processes.filter((process) => process.role === 'main').length
  const rendererCount = processes.filter((process) => process.role === 'renderer').length
  const networkUtilityCount = processes.filter(
    (process) => process.role === 'utility' && process.subtype?.toLowerCase().includes('network'),
  ).length

  if (mainCount === 0) throw new Error('缺少 main 进程')
  if (expectations.requiresRenderer && rendererCount === 0) throw new Error('缺少 renderer 进程')
  if (expectations.rendererMustBeAbsent && rendererCount > 0) {
    throw new Error(`预期 renderer 为 0，实际为 ${rendererCount}`)
  }
  if (expectations.requiresNetworkUtility && networkUtilityCount === 0) {
    throw new Error('缺少 network utility 进程')
  }
}

export function sumMemorySnapshot(processes) {
  return processes.reduce(
    (total, process) => ({
      processCount: total.processCount + 1,
      rssKb: total.rssKb + process.rssKb,
      pssKb: total.pssKb + process.pssKb,
      privateKb: total.privateKb + process.privateKb,
      swapKb: total.swapKb + process.swapKb,
    }),
    { processCount: 0, rssKb: 0, pssKb: 0, privateKb: 0, swapKb: 0 },
  )
}

const SUMMARY_METRICS = ['rssKb', 'pssKb', 'privateKb', 'swapKb']

function percentile(sorted, percentileValue) {
  return sorted[Math.ceil(sorted.length * percentileValue) - 1]
}

/** 标准中位数：偶数样本取两个中间值的均值（与 percentile(0.5) 的最近秩取法不同） */
function medianValue(sorted) {
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function summarizeMetric(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length
  const variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length
  return {
    median: medianValue(sorted),
    p95: percentile(sorted, 0.95),
    // 保留未圆整 CV 供门禁比较；展示层自行格式化
    cv: mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100,
  }
}

export function summarizeMemoryRuns(runs) {
  const scenarioNames = new Set(runs.flatMap((run) => Object.keys(run)))
  const summary = {}

  for (const scenarioName of scenarioNames) {
    const samples = runs.map((run) => run[scenarioName]).filter(Boolean)
    summary[scenarioName] = { samples: samples.length }
    for (const metric of SUMMARY_METRICS) {
      summary[scenarioName][metric] = summarizeMetric(samples.map((sample) => sample[metric]))
    }
  }

  return summary
}

export function assertStableMemorySummary(summary, options = {}) {
  const maxCv = options.maxCv ?? 5
  for (const [scenarioName, scenario] of Object.entries(summary)) {
    if (options.expectedSamples !== undefined && scenario.samples !== options.expectedSamples) {
      throw new Error(`${scenarioName} 样本数 ${scenario.samples} 不等于预期 ${options.expectedSamples}`)
    }
    const cv = scenario.rssKb?.cv
    if (typeof cv !== 'number') throw new Error(`${scenarioName} 缺少 RSS 统计`)
    if (cv > maxCv) throw new Error(`${scenarioName} RSS 变异系数 ${cv.toFixed(2)}% 超过 ${maxCv}%`)
  }
}

/**
 * 自启态就绪断言：主进程 app.isReady() 必须为 true，且不得存在任何 BrowserWindow。
 * app 为 Playwright ElectronApplication；evaluate 超时/抛错都会让本断言失败（不插值）。
 */
export async function assertAutostartReady(app, timeoutMs = 10000) {
  let state
  try {
    state = await app.evaluate(
      ({ app: electronApp, BrowserWindow }) => ({
        ready: typeof electronApp?.isReady === 'function' ? electronApp.isReady() : null,
        windowCount: BrowserWindow.getAllWindows().length,
      }),
      { timeout: timeoutMs },
    )
  } catch (error) {
    throw new Error(`自启态就绪检查失败：${error.message}`, { cause: error })
  }
  if (state.ready !== true) {
    throw new Error(`自启态主进程未就绪：app.isReady()=${String(state.ready)}`)
  }
  if (state.windowCount !== 0) {
    throw new Error(`自启态不应存在窗口，实际 ${state.windowCount} 个`)
  }
  return { ready: true, windowCount: 0 }
}
