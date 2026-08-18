/**
 * T8 renderer 内存指标采集（v2.5.3）：
 * - CDP 会话先做 capability probe（collectGarbage / getHeapUsage / getDOMCounters），
 *   任一核心命令不可用时保留原始错误并使诊断失败——不能静默报通过。
 * - renderer RSS 是辅助时间序列：BrowserWindow.webContents.getOSProcessId() 取 PID，
 *   以 PID 关联 app.getAppMetrics() 的 renderer memory.workingSetSize（原始字段保留）。
 * - 不使用不存在的 HeapProfiler.getHeapUsage / SystemInfo.getPrivateMemory 等；
 *   Windows-only 的 privateBytes 不设跨平台硬门槛。
 */
import type { ElectronApplication, Page } from '@playwright/test'

/** 最小 CDP 会话接口（Playwright CDPSession.send 的形态；只声明用到的命令） */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface RendererMemorySample {
  /** post-GC 的 JS 堆 usedSize（字节） */
  heapUsedBytes: number
  /** 堆 totalSize（字节） */
  heapTotalBytes: number
  /** DOM 文档数 */
  documents: number
  /** DOM 节点数 */
  nodes: number
  /** DOM event listeners 数 */
  listeners: number
  /** 关联的 renderer 进程 working set（字节；-1 表示未关联到 PID） */
  rendererWorkingSetBytes: number
  /** working set 原始字段（供人工复核） */
  rendererWorkingSetRaw: unknown
  /** 采集时刻（ms） */
  at: number
}

export type CDPCommand = 'collectGarbage' | 'getHeapUsage' | 'getDOMCounters'

export interface CdpProbeResult {
  collectGarbage: boolean
  getHeapUsage: boolean
  getDOMCounters: boolean
  /** 探测失败的命令的原始错误信息（诊断必现，证明能力探测真实发生） */
  errors: Partial<Record<CDPCommand, string>>
}

/** 探测 CDP 能力：失败的命令记录原始错误（不吞),由调用方决定是否使诊断失败 */
export async function probeCdpCapabilities(session: CdpSessionLike): Promise<CdpProbeResult> {
  const result: CdpProbeResult = { collectGarbage: false, getHeapUsage: false, getDOMCounters: false, errors: {} }
  for (const method of ['HeapProfiler.collectGarbage', 'Runtime.getHeapUsage', 'Memory.getDOMCounters'] as const) {
    try {
      await session.send(method)
      if (method === 'HeapProfiler.collectGarbage') result.collectGarbage = true
      if (method === 'Runtime.getHeapUsage') result.getHeapUsage = true
      if (method === 'Memory.getDOMCounters') result.getDOMCounters = true
    } catch (err) {
      const key = method.split('.')[1] as CDPCommand
      result.errors[key] = err instanceof Error ? err.message : String(err)
    }
  }
  return result
}

/**
 * 采集一轮内存指标：
 * - 先 collectGarbage（可关：forceGc=false 时不做强制 GC，直接取当前 heap/DOM——
 *   用于「隐藏沉降后」的自然释放采样，设计 §7.2：增量释放门禁只使用无强制 GC 数据），
 *   再取 post-GC 的 Runtime.getHeapUsage.usedSize 与 Memory.getDOMCounters；
 * - 经 app.evaluate 拿渲染 webContents OS PID，再关联 app.getAppMetrics() 的 renderer workingSetSize。
 * 任一核心指标缺失 → throw（fail-closed，不静默通过）。
 */
export async function collectRendererMetrics(
  app: ElectronApplication,
  page: Page,
  session: CdpSessionLike,
  opts?: { forceGc?: boolean },
): Promise<RendererMemorySample> {
  const forceGc = opts?.forceGc ?? true
  const probe = await probeCdpCapabilities(session)
  const missing = (Object.keys(probe.errors) as CDPCommand[]).filter((k) => !probe[k])
  if (missing.length > 0) {
    const detail = missing.map((k) => `${k}: ${probe.errors[k]}`).join('; ')
    throw new Error(`CDP 能力缺失，无法完成内存诊断：${detail}`)
  }

  if (forceGc) await session.send('HeapProfiler.collectGarbage')
  const heap = (await session.send('Runtime.getHeapUsage')) as { usedSize?: number; totalSize?: number }
  const dom = (await session.send('Memory.getDOMCounters')) as { documents?: number; nodes?: number; jsEventListeners?: number }
  if (typeof heap.usedSize !== 'number' || typeof heap.totalSize !== 'number') {
    throw new Error(`Runtime.getHeapUsage 返回结构非法：${JSON.stringify(heap)}`)
  }
  if (typeof dom.documents !== 'number' || typeof dom.nodes !== 'number' || typeof dom.jsEventListeners !== 'number') {
    throw new Error(`Memory.getDOMCounters 返回结构非法：${JSON.stringify(dom)}`)
  }

  // renderer PID 关联（辅助时间序列；关联失败记录 -1 不阻断主指标）
  let rendererPid: number | null = null
  try {
    rendererPid = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? win.webContents.getOSProcessId() : null
    })
  } catch {
    rendererPid = null
  }

  let workingSet = -1
  let workingSetRaw: unknown = null
  if (rendererPid !== null) {
    try {
      const metrics = await app.evaluate(({ app: electronApp }) =>
        (electronApp.getAppMetrics?.() ?? []).map((m) => ({ ...m })),
      )
      const rendererMetric = (metrics as Array<{ pid: number; type: string; memory: { workingSetSize?: number } }>).find(
        (m) => m.pid === rendererPid,
      )
      if (rendererMetric?.memory) {
        // Electron AppMetrics.memory.workingSetSize 单位为 KB → 转字节
        workingSet = (rendererMetric.memory.workingSetSize ?? -1) * 1024
        workingSetRaw = rendererMetric.memory
      }
    } catch {
      // 关联失败仅记 -1，不阻断诊断
    }
  }

  return {
    heapUsedBytes: heap.usedSize,
    heapTotalBytes: heap.totalSize,
    documents: dom.documents,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    rendererWorkingSetBytes: workingSet,
    rendererWorkingSetRaw: workingSetRaw,
    at: Date.now(),
  }
}