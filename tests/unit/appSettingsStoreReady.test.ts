/**
 * `stores/appSettings` 的**失败路径**常驻断言（v2.5.8 复审 r2 ⑤-3）。
 *
 * 缺陷形状：三条 IPC 调用都只挂了 `.then`，没有 `.catch`。`get()` / `set()` 的 promise 被
 * **reject**（IPC 通道缺失 ⇒ `src/main/index.ts:740` 只 log 后继续、主进程失联、桥不可用）时，
 * `.then` 的回调根本不执行 ⇒
 *  - `appSettingsReady()` 永远 false ⇒ 设置页六个开关永久停在 `disabled={!prefReady()}` 的置灰态；
 *  - `reloadAppSettings()` 的 reject 会掀翻 `Settings.tsx` 的 `savePref`（它 await 且无 try/catch），
 *    后面那句「设置失败」的 toast 永远不弹；
 *  - 外加 unhandled rejection。
 * 注意区分：handler **内部抛错**不会走到这里（`ipc.ts` 的 `handle()` 会包成 `{success:false}`），
 * 所以本文件演的是「promise 被 reject」这一条路，不是「返回 success:false」（后者 `appSettings.test.ts` 已钉）。
 *
 * 环境事实：本仓 vitest 是 `environment: 'node'`（无 DOM 无 Electron），所以桥用假 `globalThis.window`
 * 顶替——但**归一与合并复用 `src/shared/appSettings` 真函数**，不另写一份（假设有先例：
 * `clipboardGuard-off.test.ts` 同一套路）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_DEFAULTS,
  mergeAppSettings,
  resolveAppSettings,
  type AppSettings,
  type AppSettingsFile,
  type AppSettingsPatch,
} from '../../src/shared/appSettings'
import {
  appSettings,
  appSettingsReady,
  loadAppSettings,
  reloadAppSettings,
  setAppSetting,
} from '../../src/renderer/src/stores/appSettings'

type IpcResult = { success: boolean; data: AppSettings | null; error: string | null }

/** 桥：get / set 可各自被演成 reject（reject = 通道层失败，与 handler 抛错不同） */
function installBridge(opts: { rejectGet?: boolean; rejectSet?: boolean } = {}) {
  // 桥自己得真的"落盘"，否则 `setAppSetting` 按「以主进程回包为权威」把默认值盖回来是**正确行为**
  // （本仓明文：值一律从信号读、信号跟服务端）——第一版脚手架没合并补丁，被这条抓到。
  let disk: AppSettingsFile = {}
  const api = {
    async get(): Promise<IpcResult> {
      if (opts.rejectGet) throw new Error('ipc: channel unavailable')
      return { success: true, data: resolveAppSettings(disk), error: null }
    },
    async set(p: AppSettingsPatch): Promise<IpcResult> {
      if (opts.rejectSet) throw new Error('ipc: channel unavailable')
      disk = mergeAppSettings(disk, p)
      return { success: true, data: resolveAppSettings(disk), error: null }
    },
  }
  ;(globalThis as Record<string, unknown>).window = { qihebox: { appSettings: api } }
}

const setWindow = (v: unknown): void => {
  ;(globalThis as Record<string, unknown>).window = v
}

/** 桥是异步 .then/.finally 落信号，跑一轮微任务 + 宏任务等效等它回来 */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** 收集 unhandled rejection（老代码的洞就长这样：`void b.get().then(...)` 无 catch） */
function trackUnhandled(): string[] {
  const seen: string[] = []
  const on = (e: unknown): void => {
    seen.push(e instanceof Error ? e.message : String(e))
  }
  process.on('unhandledRejection', on)
  afterEach(() => process.off('unhandledRejection', on))
  return seen
}

describe('设置 store 的失败路径：reject 不许把开关永久置灰', () => {
  let unhandled: string[]

  beforeEach(() => {
    setWindow(undefined)
    unhandled = trackUnhandled()
  })
  afterEach(() => setWindow(undefined))

  it('首拉 get() 被 reject → 仍解除置灰（六开关可点），值按默认落位', async () => {
    installBridge({ rejectGet: true })
    loadAppSettings()
    expect(appSettingsReady(), '拉取在途时未就绪是对的，但绝不能停在未就绪').toBe(false)
    await flush()
    expect(appSettingsReady(), 'reject 后必须解除置灰，否则设置页永久不可用').toBe(true)
    expect(appSettings()).toEqual(APP_SETTINGS_DEFAULTS) // 降级为「读不到设置」= 默认值 = 现行行为
  })

  it('reject 不留 unhandled rejection（`void b.get()` 必须自己收口）', async () => {
    installBridge({ rejectGet: true })
    loadAppSettings()
    await flush()
    await flush()
    expect(unhandled, '老写法在这里会攒下一条未处理的 rejection').toEqual([])
  })

  it('reloadAppSettings 在 get() reject 时 resolve 而非抛出（savePref 的 toast 必须还有机会弹）', async () => {
    installBridge({ rejectGet: true })
    // 关键：不 await 它会不会 reject，而是直接 await 看它有没有把异常送给调用方
    await expect(reloadAppSettings()).resolves.toBeUndefined()
  })

  it('set() 被 reject 时 setAppSetting 返回 false，而不是把异常抛给 savePref', async () => {
    installBridge({ rejectSet: true })
    await expect(setAppSetting({ certReminder: false })).resolves.toBe(false)
    expect(unhandled).toEqual([])
  })

  it('成功路径不受影响（防我把 catch 写成"永远失败也当成功"）', async () => {
    installBridge()
    loadAppSettings()
    await flush()
    expect(appSettingsReady()).toBe(true)
    expect(await setAppSetting({ certReminder: false })).toBe(true)
    expect(appSettings().certReminder).toBe(false) // 以主进程回包为权威，本地信号确实跟上
  })
})
