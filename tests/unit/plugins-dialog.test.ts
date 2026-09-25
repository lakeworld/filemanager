/**
 * host.dialog 能力单测（v2.6.1 协议增量，B8）：宿主侧三档行为——多选 / 取消 / 截断 / 失败分类。
 *
 * 为什么单独立文件：装配闭包（ipc.ts）与 electron 强耦合，宿主侧行为此前无从在 node 下钉；
 * 实现抽到 `src/main/plugins/dialog.ts`（io 注入）后，这里喂假 dialog 直钉契约语义。
 * 装配真链另有一条（`plugins-assembly.test.ts`，mock electron + 真 registerPluginHost）——
 * 两层各管一段：这里钉语义与上限，那里钉真正的注入口径。
 *
 * 判据取向（协议卡 §二 三条语义）：取消 ≠ 失败；返回裸值不是信封；只增不改（单选形状与取消一字不动）。
 */
import { describe, expect, it } from 'vitest'
import { createDialogCapability, OPEN_FILES_MAX, type OpenDialogOptionsLike } from '../../src/main/plugins/dialog'

interface FakeIo {
  io: Parameters<typeof createDialogCapability>[0]
  calls: Array<{ win: unknown; opts: OpenDialogOptionsLike }>
  logs: string[]
}

/** 假 dialog：resultOf 决定每次应答；可让它抛错模拟对话框失败 */
function fakeIo(resultOf: () => { canceled: boolean; filePaths: string[] } | 'throw'): FakeIo {
  const calls: FakeIo['calls'] = []
  const logs: string[] = []
  const io = {
    getWindow: () => ({ __win: true }),
    showOpenDialog: async (win: unknown, opts: OpenDialogOptionsLike) => {
      calls.push({ win, opts })
      const r = resultOf()
      if (r === 'throw') throw new Error('GTK: cannot open display')
      return r
    },
    log: (level: string, msg: string) => {
      logs.push(`${level}:${msg}`)
    },
  }
  return { io, calls, logs }
}

describe('dialog.openFiles：多选语义（P1 拍板 ≤200）', () => {
  it('多选一批原样回（裸数组不是信封）——选了 N 条就回 N 条', async () => {
    const f = fakeIo(() => ({ canceled: false, filePaths: ['/p/a.jpg', '/p/b.png', '/p/c.webp'] }))
    const d = createDialogCapability(f.io)
    await expect(d.openFiles({ title: '选择图片', filters: [{ name: '图片', extensions: ['jpg', 'png', 'webp'] }] }))
      .resolves.toEqual(['/p/a.jpg', '/p/b.png', '/p/c.webp'])
    // properties 必带 multiSelections（单选档没有它）；title/filters 原样交给 electron
    expect(f.calls[0].opts.properties).toEqual(['openFile', 'multiSelections'])
    expect(f.calls[0].opts.title).toBe('选择图片')
    expect(f.calls[0].opts.filters).toEqual([{ name: '图片', extensions: ['jpg', 'png', 'webp'] }])
    // 有主窗口 → 以窗口为 parent（electron 两形中最常见的一形）
    expect(f.calls[0].win).toEqual({ __win: true })
  })

  it('恰好 200 条：不截断、不记截断日志（截断只在真的超过时发生）', async () => {
    const exactly = Array.from({ length: OPEN_FILES_MAX }, (_, i) => `/p/${i}.jpg`)
    const f = fakeIo(() => ({ canceled: false, filePaths: exactly }))
    const d = createDialogCapability(f.io)
    const out = await d.openFiles({})
    expect(out).toHaveLength(OPEN_FILES_MAX)
    expect(out).toEqual(exactly)
    expect(f.logs.filter((l) => l.includes('截断'))).toEqual([])
  })

  it('>200：截断到 200 且**宿主日志如实记**（含真实条数与上限）——NaN 截断=静默丢弃，日志是唯一落痕', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `/p/${i}.jpg`)
    const f = fakeIo(() => ({ canceled: false, filePaths: many }))
    const d = createDialogCapability(f.io)
    const out = await d.openFiles({})
    expect(out).toHaveLength(OPEN_FILES_MAX)
    expect(out).toEqual(many.slice(0, OPEN_FILES_MAX))
    const hit = f.logs.filter((l) => l.includes('250') && l.includes('200'))
    expect(hit, '截断必须在宿主日志留痕（原始条数 + 上限）').toHaveLength(1)
    expect(hit[0]).toContain('截断')
  })

  it('取消 → []（空数组不是 undefined、不是信封；插件侧按「取消」静默处理）', async () => {
    const f = fakeIo(() => ({ canceled: true, filePaths: [] }))
    const d = createDialogCapability(f.io)
    await expect(d.openFiles({})).resolves.toEqual([])
  })

  it('opts 缺省/垃圾：title 落默认「选择文件」，filters 非数组一律忽略（不把 undefined 递给 electron）', async () => {
    const f = fakeIo(() => ({ canceled: true, filePaths: [] }))
    const d = createDialogCapability(f.io)
    await d.openFiles(undefined)
    await d.openFiles({ title: 42, filters: 'nope' })
    await d.openFiles(null)
    expect(f.calls.map((c) => c.opts.title)).toEqual(['选择文件', '选择文件', '选择文件'])
    expect(f.calls.every((c) => c.opts.filters === undefined)).toBe(true)
  })
})

describe('取消与失败必须可分辨（协议卡语义①：不得两者都回空）', () => {
  it('对话框抛错 → 带 code 的 DIALOG_FAILED；原始英文只进日志不外泄', async () => {
    const f = fakeIo(() => 'throw')
    const d = createDialogCapability(f.io)
    const err = await d.openFiles({}).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err, '失败必须抛（回空 = 与取消同形，正是要禁止的那一格）').not.toBeNull()
    expect(err!.code).toBe('DIALOG_FAILED')
    expect(err!.message).not.toContain('GTK')
    expect(f.logs.some((l) => l.includes('GTK'))).toBe(true)
  })

  it('单选两档同样按「失败抛带 code 错误 / 取消回空串」——三档一套语义', async () => {
    const f = fakeIo(() => 'throw')
    const d = createDialogCapability(f.io)
    await expect(d.openFile({})).rejects.toMatchObject({ code: 'DIALOG_FAILED' })
    await expect(d.openDirectory({})).rejects.toMatchObject({ code: 'DIALOG_FAILED' })
  })
})

describe('只增不改：单选两档的形状与取消语义一字不动', () => {
  it('openFile 仍只取首条（对话框回多条也只留第一条）；properties 仍是单选档', async () => {
    const f = fakeIo(() => ({ canceled: false, filePaths: ['/p/first.jpg', '/p/second.jpg'] }))
    const d = createDialogCapability(f.io)
    await expect(d.openFile({ filters: [{ name: '图片', extensions: ['jpg'] }] })).resolves.toBe('/p/first.jpg')
    expect(f.calls[0].opts.properties).toEqual(['openFile'])
    expect(f.calls[0].opts.filters).toEqual([{ name: '图片', extensions: ['jpg'] }])
  })

  it('openFile / openDirectory 取消 → 空串；默认 title 各自成句', async () => {
    const f = fakeIo(() => ({ canceled: true, filePaths: [] }))
    const d = createDialogCapability(f.io)
    await expect(d.openFile({})).resolves.toBe('')
    await expect(d.openDirectory({})).resolves.toBe('')
    expect(f.calls[0].opts.title).toBe('选择文件')
    expect(f.calls[0].opts.properties).toEqual(['openFile'])
    expect(f.calls[1].opts.title).toBe('选择文件夹')
    expect(f.calls[1].opts.properties).toEqual(['openDirectory', 'createDirectory'])
  })
})