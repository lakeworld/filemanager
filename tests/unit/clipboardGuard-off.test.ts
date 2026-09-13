/**
 * `clipboardGuard`（v2.5.8 D11 / W7 剪贴板守卫开关）——**关态**的常驻断言。
 *
 * 既有覆盖只有开态：`tests/e2e/clipboard-guard.spec.ts` 全部用例都跑在默认（= 开）上，
 * 没有任何一条把开关拨到关；`appSettings.test.ts` 只钉了「默认值是 true」这一格。
 *
 * 本文件钉两半（缺任一半，关态都是没被证的）：
 *  ① 镜像真的能把关态送到消费点（跑真实的 `stores/appSettings.ts`，桥用假实现但归一用真函数）；
 *  ② 消费点确实按这个开关分支——守卫的 `return false` 必须**在写剪贴板之前**、且被
 *    `clipboardGuardOn()` 短路。这条用源码结构钉（本仓 vitest 是纯 node 环境，无 DOM 无 Electron，
 *    组件里的 keydown 回调装不起来；同类结构钉在本仓有先例：uiInventory / winBranchInventory）。
 *    并配**变异自检**：把「开关摘掉 / 早返回删掉 / 守卫挪到写之后」三种改法喂给同一个判别函数，
 *    必须全部判 false——否则②就成了永远为真的空检查。
 *
 * ⚠ 口径说明（与任务描述相反，故不照抄）：产品口径是 **开 = 让位正文选区（应用不改写剪贴板）**、
 * **关 = 文件选中优先（应用照旧把文件路径写进剪贴板）**，见 `src/shared/appSettings.ts:35-38` 与本文件
 * ② 的断言。所以「关态不得改写剪贴板」不成立，钉成那样会把产品语义钉反。
 * 关态的**运行时**证据（真按 Ctrl+C 后 `clipboard.readText()` 得到文件路径）只能由 e2e 给，
 * 见报告里的待补清单。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
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
  clipboardGuardOn,
  loadAppSettings,
  selectionBarVisible,
  setAppSetting,
} from '../../src/renderer/src/stores/appSettings'

type IpcResult = { success: boolean; data: AppSettings | null; error: string | null }

/** 假的 `window.qihebox.appSettings`：落盘语义完全复用 shared 真函数，不另写一份归一 */
function installBridge(initial: AppSettingsFile = {}) {
  let disk: AppSettingsFile = { ...initial }
  const writes: AppSettingsPatch[] = []
  let failNextWrite = false
  const api = {
    async get(): Promise<IpcResult> {
      return { success: true, data: resolveAppSettings(disk), error: null }
    },
    async set(p: AppSettingsPatch): Promise<IpcResult> {
      writes.push(p)
      if (failNextWrite) {
        failNextWrite = false
        return { success: false, data: null, error: 'EIO' }
      }
      disk = mergeAppSettings(disk, p)
      return { success: true, data: resolveAppSettings(disk), error: null }
    },
  }
  ;(globalThis as Record<string, unknown>).window = { qihebox: { appSettings: api } }
  return {
    writes,
    failNextWrite: () => {
      failNextWrite = true
    },
    disk: () => disk,
  }
}

/** 桥是异步 .then 落信号，跑一轮微任务队列等效等它回来 */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
}

const setWindow = (v: unknown): void => {
  ;(globalThis as Record<string, unknown>).window = v
}

describe('clipboardGuard 关态：镜像把「关」送到消费点', () => {
  afterAll(() => setWindow(undefined))
  beforeEach(() => setWindow(undefined))

  it('无桥 / 未拉取 = 开（默认 = v2.5.7 A1 现行口径，首帧不闪新行为）', () => {
    expect(clipboardGuardOn()).toBe(true)
    expect(APP_SETTINGS_DEFAULTS.clipboardGuard).toBe(true)
  })

  it('磁盘写着关 → 拉取后消费点读到关', async () => {
    installBridge({ clipboardGuard: false })
    loadAppSettings()
    await flush()
    expect(clipboardGuardOn()).toBe(false)
  })

  it('写「关」后重启（重新拉一次）仍是关，且只动这一个键', async () => {
    const b = installBridge()
    expect(await setAppSetting({ clipboardGuard: false })).toBe(true)
    expect(b.writes).toEqual([{ clipboardGuard: false }])
    expect(clipboardGuardOn()).toBe(false)
    expect(b.disk()).toEqual({ clipboardGuard: false }) // 等于默认值的键不落盘，关态必须落盘
    loadAppSettings() // = 重启后 App onMount 的首拉
    await flush()
    expect(clipboardGuardOn()).toBe(false)
    expect(selectionBarVisible()).toBe(true) // 没被顺带改掉
  })

  it('写失败不改本地信号（UI 不与磁盘漂移：磁盘还开着，消费点就还开着）', async () => {
    // 信号是模块级的，上一条用例留下的值不算前提——先把自己对齐到「开」再演写失败
    const b = installBridge()
    loadAppSettings()
    await flush()
    expect(clipboardGuardOn()).toBe(true)
    b.failNextWrite()
    expect(await setAppSetting({ clipboardGuard: false })).toBe(false)
    expect(clipboardGuardOn()).toBe(true)
  })

  it('主进程把脏值归一后，镜像跟服务端而不是停在本地值（天数脏 → 回落 30，不误伤守卫）', async () => {
    installBridge({ clipboardGuard: false })
    loadAppSettings()
    await flush()
    expect(await setAppSetting({ certReminderDays: 0 as never })).toBe(true)
    expect(appSettings().certReminderDays).toBe(30)
    expect(clipboardGuardOn()).toBe(false) // 归一没把守卫一起冲掉
  })
})

// —— ② 结构钉：消费点真的按开关分支 ——
// v2.5.8 D19（体验批 B2）：这段守卫从 `FileBrowserView.tsx` 搬进了
// `hooks/useCopyShortcut.ts`（判据本身再下沉一层到 `lib/copyShortcut.ts` 的纯函数），
// 因为 B2 要把 Ctrl+C 铺到七个选中态页面——守卫留在某一个组件里，其余六页只能各抄一份。
// 结构钉跟着搬家，**判据一条没减**：开关必须参与、早返回必须排在真的复制之前。
const VIEW_PATH = new URL('../../src/renderer/src/hooks/useCopyShortcut.ts', import.meta.url)

/**
 * 取 `registerShortcut("file.copy", …)` 那一段回调源码。
 * 先剥注释再定位：本文件头部那段说明里就出现过 `registerShortcut("file.copy"` 与
 * `clipboardGuardOn()` 这两个字面量，不剥注释的话锚点会先撞上散文，
 * 于是「变异」只改到注释、代码原样 ⇒ 判别函数瞎掉（D19 实测踩过一次）。
 * 剥注释的手法与 `tests/unit/shortcuts.test.ts` 的 `codeOnly` 同一份。
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n')
}

function copyHandler(src: string): string {
  const code = codeOnly(src)
  const start = code.indexOf('registerShortcut("file.copy"')
  expect(start, 'Ctrl+C 仍应住在 shortcuts 单注册点里（W6 收口；D19 起住 hooks/useCopyShortcut.ts）').toBeGreaterThanOrEqual(0)
  const end = code.indexOf('});', start)
  return code.slice(start, end < 0 ? undefined : end)
}

/**
 * 开态让位、关态放行：守卫的早返回必须存在、被开关短路、且在写剪贴板之前。
 * 新形态下开关是以 `guardOn: clipboardGuardOn()` 入参的形式参与判定的（判据住在纯函数里），
 * 所以这里钉三件事：① 开关真的被读；② `shouldTakeFileCopy` 真的被调用；
 * ③ 判定通过后为 false 的那次 `return false;` 出现在 `onCopy(paths)` 之前。
 */
const GUARD_RE = /guardOn:\s*clipboardGuardOn\(\)/
function guardShortCircuitsBeforeClipboardWrite(handler: string): boolean {
  const g = handler.search(GUARD_RE)
  if (g < 0) return false
  if (!handler.slice(0, g).includes('shouldTakeFileCopy(')) return false
  const earlyReturn = handler.indexOf('return false;', g)
  const w = handler.indexOf('onCopy(paths)', g)
  return earlyReturn > -1 && w > -1 && earlyReturn < w
}

describe('clipboardGuard 关态：消费点按开关分支（开关不是死码）', () => {
  const handler = copyHandler(readFileSync(VIEW_PATH, 'utf-8'))

  it('Ctrl+C 回调里，「让位正文」的早返回被 clipboardGuardOn() 短路，且在写剪贴板之前', () => {
    expect(guardShortCircuitsBeforeClipboardWrite(handler), handler.slice(0, 400)).toBe(true)
  })

  it('全仓只有一个守卫消费点（第二处各写一份判定 = 漂移）', () => {
    const root = new URL('../../src/', import.meta.url)
    const hits: string[] = []
    const walk = (dir: URL, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
        if (e.isDirectory()) walk(p, `${rel}${e.name}/`)
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, 'utf-8').includes('clipboardGuardOn()')) hits.push(`${rel}${e.name}`)
      }
    }
    walk(root, '')
    // D19（B2）起这个消费点是 `hooks/useCopyShortcut.ts`（页面版与预览版共用一份守卫读取）；
    // 判据本身在 `lib/copyShortcut.ts` 的纯函数里，那里不出现 `clipboardGuardOn()` 调用 ⇒ 不进本表
    expect(hits).toEqual(['renderer/src/hooks/useCopyShortcut.ts'])
  })

  it('变异自检：摘掉开关 / 删掉早返回 / 守卫挪到写之后，三种改法都必须被判为失效', () => {
    const guardStart = handler.indexOf('if (')
    const guardEnd = handler.indexOf('}', handler.indexOf('return false;')) + 1
    const guardBlock = handler.slice(guardStart, guardEnd)
    const withoutGuard = handler.slice(0, guardStart) + handler.slice(guardEnd)
    const mutants: [string, string][] = [
      ['开关摘掉（守卫变成无条件生效）', handler.replace('clipboardGuardOn()', 'true')],
      ['早返回整条删除（开态也不再让位）', handler.replace('return false;', '')],
      // 把整段判定搬到真的复制之后：形状还在，但剪贴板已经被改写了才让位，形同虚设
      ['守卫挪到写剪贴板之后（形同虚设）', withoutGuard.replace('onCopy(paths);', `onCopy(paths);\n      ${guardBlock}`)],
    ]
    for (const [why, mutated] of mutants) {
      expect(mutated, `变异未生效（原文没被改到）：${why}`).not.toBe(handler)
      expect(guardShortCircuitsBeforeClipboardWrite(mutated), `判别函数对该变异瞎了：${why}`).toBe(false)
    }
  })
})
