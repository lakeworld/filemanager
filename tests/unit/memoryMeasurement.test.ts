import { describe, expect, it } from 'vitest'

describe('内存测量脚本参数', () => {
  it('应解析 --autostart、--repeat 与 --seed-plugins', async () => {
    const { parseMemoryMeasurementArgs } = await import('../../scripts/memory-measurement.mjs')

    expect(
      parseMemoryMeasurementArgs(['--autostart', '--repeat', '3', '--seed-plugins', 'one.qbox,two.qbox']),
    ).toEqual({
      autostart: true,
      repeat: 3,
      seedPlugins: ['one.qbox', 'two.qbox'],
    })
  })

  it('应拒绝把下一个选项误作 --seed-plugins 的路径', async () => {
    const { parseMemoryMeasurementArgs } = await import('../../scripts/memory-measurement.mjs')

    expect(() => parseMemoryMeasurementArgs(['--seed-plugins', '--autostart'])).toThrow(
      '--seed-plugins 需要至少一个 .qbox 路径',
    )
  })

  it('应拒绝非法重复次数和未知参数', async () => {
    const { parseMemoryMeasurementArgs } = await import('../../scripts/memory-measurement.mjs')

    expect(() => parseMemoryMeasurementArgs(['--repeat', '0'])).toThrow('--repeat 必须是大于 0 的整数')
    expect(() => parseMemoryMeasurementArgs(['--unexpected'])).toThrow('未知参数：--unexpected')
  })
})

describe('内存采样结果校验', () => {
  it('应识别可用的窗口态进程，并拒绝缺少网络 utility 的托盘态', async () => {
    const { assertMemorySnapshot, parseMemorySamplerOutput } = await import('../../scripts/memory-measurement.mjs')
    const snapshot = parseMemorySamplerOutput([
      'role=main subtype=- pid=100 rss_kb=1024 pss_kb=512 private_kb=256 swap_kb=0',
      'role=renderer subtype=- pid=101 rss_kb=2048 pss_kb=1024 private_kb=512 swap_kb=0',
      'role=utility subtype=network.mojom.NetworkService pid=102 rss_kb=512 pss_kb=256 private_kb=128 swap_kb=0',
    ].join('\n'))

    expect(snapshot).toEqual([
      { role: 'main', subtype: null, pid: 100, rssKb: 1024, pssKb: 512, privateKb: 256, swapKb: 0 },
      { role: 'renderer', subtype: null, pid: 101, rssKb: 2048, pssKb: 1024, privateKb: 512, swapKb: 0 },
      {
        role: 'utility',
        subtype: 'network.mojom.NetworkService',
        pid: 102,
        rssKb: 512,
        pssKb: 256,
        privateKb: 128,
        swapKb: 0,
      },
    ])

    expect(() => assertMemorySnapshot(snapshot, { requiresRenderer: true })).not.toThrow()
    expect(() => assertMemorySnapshot(snapshot, { requiresNetworkUtility: true, rendererMustBeAbsent: true })).toThrow(
      '预期 renderer 为 0，实际为 1',
    )
    expect(() =>
      assertMemorySnapshot(snapshot.filter((process) => process.role !== 'utility'), {
        requiresNetworkUtility: true,
      }),
    ).toThrow('缺少 network utility 进程')
  })
})

describe('重复内存测量汇总', () => {
  it('应按场景计算合计 RSS 的中位数、P95 和变异系数（CV 保留未圆整精度）', async () => {
    const { summarizeMemoryRuns } = await import('../../scripts/memory-measurement.mjs')

    const summary = summarizeMemoryRuns([
      { awake: { rssKb: 100, pssKb: 50, privateKb: 30, swapKb: 0 } },
      { awake: { rssKb: 200, pssKb: 50, privateKb: 30, swapKb: 0 } },
      { awake: { rssKb: 300, pssKb: 50, privateKb: 30, swapKb: 0 } },
    ])

    expect(summary).toEqual({
      awake: {
        samples: 3,
        rssKb: { median: 200, p95: 300, cv: expect.closeTo(40.824829, 3) },
        pssKb: { median: 50, p95: 50, cv: 0 },
        privateKb: { median: 30, p95: 30, cv: 0 },
        swapKb: { median: 0, p95: 0, cv: 0 },
      },
    })
  })

  it('偶数样本的中位数应取两个中间值的均值', async () => {
    const { summarizeMemoryRuns } = await import('../../scripts/memory-measurement.mjs')

    const summary = summarizeMemoryRuns([
      { awake: { rssKb: 100, pssKb: 0, privateKb: 0, swapKb: 0 } },
      { awake: { rssKb: 200, pssKb: 0, privateKb: 0, swapKb: 0 } },
      { awake: { rssKb: 400, pssKb: 0, privateKb: 0, swapKb: 0 } },
      { awake: { rssKb: 500, pssKb: 0, privateKb: 0, swapKb: 0 } },
    ])

    expect(summary.awake.rssKb.median).toBe(300)
  })

  it('应拒绝 RSS 变异系数超过 5% 的场景作为基线', async () => {
    const { assertStableMemorySummary } = await import('../../scripts/memory-measurement.mjs')

    expect(() => assertStableMemorySummary({ awake: { rssKb: { cv: 5.01 } } })).toThrow(
      'awake RSS 变异系数 5.01% 超过 5%',
    )
    expect(() => assertStableMemorySummary({ awake: { rssKb: { cv: 5 } } })).not.toThrow()
  })

  it('真实 CV 略高于阈值但两位显示为 5.00 时不得通过（fail-closed 比较）', async () => {
    const { assertStableMemorySummary } = await import('../../scripts/memory-measurement.mjs')

    expect(() => assertStableMemorySummary({ awake: { rssKb: { cv: 5.004 } } })).toThrow('超过 5%')
    expect(() => assertStableMemorySummary({ awake: { rssKb: { cv: 5 } } })).not.toThrow()
  })

  it('样本数不等于预期次数时不得作为基线', async () => {
    const { assertStableMemorySummary } = await import('../../scripts/memory-measurement.mjs')

    const summary = { awake: { samples: 2, rssKb: { median: 100, p95: 110, cv: 1 } } }
    expect(() => assertStableMemorySummary(summary, { expectedSamples: 3 })).toThrow(
      'awake 样本数 2 不等于预期 3',
    )
    expect(() => assertStableMemorySummary(summary, { expectedSamples: 2 })).not.toThrow()
  })
})

describe('自启态就绪断言', () => {
  const fakeApp = (isReady: boolean, windowCount: number) => ({
    evaluate: async (fn: (electron: unknown) => unknown) =>
      fn({ app: { isReady: () => isReady }, BrowserWindow: { getAllWindows: () => Array.from({ length: windowCount }) } }),
  })

  it('主进程就绪且无窗口时通过', async () => {
    const { assertAutostartReady } = await import('../../scripts/memory-measurement.mjs')

    await expect(assertAutostartReady(fakeApp(true, 0), 1000)).resolves.toEqual({ ready: true, windowCount: 0 })
  })

  it('主进程未就绪时拒绝（插值自启基线）', async () => {
    const { assertAutostartReady } = await import('../../scripts/memory-measurement.mjs')

    await expect(assertAutostartReady(fakeApp(false, 0), 1000)).rejects.toThrow('自启态主进程未就绪')
  })

  it('存在窗口时拒绝（自启态不应建窗）', async () => {
    const { assertAutostartReady } = await import('../../scripts/memory-measurement.mjs')

    await expect(assertAutostartReady(fakeApp(true, 2), 1000)).rejects.toThrow('自启态不应存在窗口，实际 2 个')
  })

  it('evaluate 超时或抛错时拒绝并保留原因', async () => {
    const { assertAutostartReady } = await import('../../scripts/memory-measurement.mjs')

    const broken = { evaluate: async () => { throw new Error('renderer hung') } }
    await expect(assertAutostartReady(broken, 1000)).rejects.toThrow('自启态就绪检查失败：renderer hung')
  })
})

describe('内存采样结果 fail-closed 校验', () => {
  it('应拒绝 rss/pss 为 0 或缺失字段，防御采样假通过', async () => {
    const { parseMemorySamplerOutput } = await import('../../scripts/memory-measurement.mjs')

    expect(() => parseMemorySamplerOutput('role=main subtype=- pid=1 rss_kb=0 pss_kb=10 private_kb=5 swap_kb=0')).toThrow(
      '采样返回非法 rss_kb',
    )
    expect(() => parseMemorySamplerOutput('role=main subtype=- pid=1 rss_kb=10 pss_kb=0 private_kb=5 swap_kb=0')).toThrow(
      '采样返回非法 pss_kb',
    )
    expect(() => parseMemorySamplerOutput('role=main subtype=- pid=1 pss_kb=10 private_kb=5 swap_kb=0')).toThrow(
      '采样返回非法 rss_kb',
    )
    expect(() => parseMemorySamplerOutput('role=main subtype=- pid=1 rss_kb=10 pss_kb=10 private_kb=5 swap_kb=0')).not.toThrow()
  })

  it('整张快照采样失败时重试一次，成功后产出快照（fail-closed 重试路径）', async () => {
    const { snapshot } = await import('../../scripts/measure-memory.mjs')

    let calls = 0
    const runner = async () => {
      calls += 1
      if (calls === 1) throw new Error('进程竞态：/proc 读取失败')
      return 'role=main subtype=- pid=1 rss_kb=100 pss_kb=90 private_kb=80 swap_kb=0\n'
    }
    const result = await snapshot('测试', '/tmp/x', 12345, { requiresRenderer: false }, runner)
    expect(calls).toBe(2)
    expect(result.total.rssKb).toBe(100)
  })

  it('重试仍失败时整体抛错，不静默通过', async () => {
    const { snapshot } = await import('../../scripts/measure-memory.mjs')

    const runner = async () => {
      throw new Error('始终失败')
    }
    await expect(
      snapshot('测试', '/tmp/x', 12345, { requiresRenderer: false }, runner),
    ).rejects.toThrow(/始终失败/)
  })

  it('缺预期进程角色时拒绝（快照可用但断言失败）', async () => {
    const { snapshot } = await import('../../scripts/measure-memory.mjs')

    const runner = async () => 'role=main subtype=- pid=1 rss_kb=100 pss_kb=90 private_kb=80 swap_kb=0\n'
    await expect(snapshot('测试', '/tmp/x', 12345, { requiresRenderer: true }, runner)).rejects.toThrow('缺少 renderer 进程')
  })
})
