import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const userDataDir = (label: string): string => path.join(os.tmpdir(), e2eUserDataDirName(label))

/**
 * 最近工作区落盘位置（唯一真相 `core/paths.ts` 的 `RECENT_FILE`，家目录级、**不在 userData 隔离范围内**）。
 * 本 spec 会经 workspace.create/switch 往这份**真实文件**里写两个临时目录 ⇒ 结尾按快照原样还原（见 recentsBackup）。
 * 这个隔离缺口是既有的（本机该文件里就躺着 conformance 跑出的 /tmp 条目），修它要连带全量 e2e 回归，
 * 不在本批：见 docs/INTERNAL/PLAN-v2.6.1-默认工作区.md §五。
 */
const RECENTS_FILE = path.join(os.homedir(), '.qihefilemanager_recent.json')

const readRecents = async (): Promise<string | null> => {
  try {
    return await fsp.readFile(RECENTS_FILE, 'utf-8')
  } catch {
    return null // 本来就没有这份文件 → 结尾删掉本次产生的那份
  }
}

const readSettingsRaw = async (label: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await fsp.readFile(path.join(userDataDir(label), 'settings.json'), 'utf-8')) as Record<string, unknown>
  } catch {
    return {} // 没动过任何设置时磁盘上可以根本没有这个文件
  }
}

/** 当前打开的工作区（走应用自己的 IPC，不读内部状态） */
const currentWsPath = async (page: Page): Promise<string | null> => {
  const r = (await page.evaluate(async () => (window as any).qihebox.workspace.current())) as {
    data: { path: string } | null
  }
  return r.data?.path ?? null
}

/**
 * 默认工作区（v2.6.1）端到端。
 *
 * 要坐实的三件事，单测都证不到（跨进程 + 真重启 + 真界面那一下点击）：
 *  1. 在顶栏工作区下拉里点「设为默认」→ 只落 `defaultWorkspace` 一个键到 settings.json；
 *  2. **真重启后开的是默认那个工作区，而不是最近列表首位**——这是本功能的全部意义：
 *     用例刻意在设默认前最后切到 A，使 recents[0] = A，若默认不生效就一定开 A（判据可分辨）；
 *  3. 点「取消默认」→ 键从磁盘上消失（删键即回滚），再重启回到 LRU 行为。
 *
 * 覆盖面诚实声明：默认指针**失效**（目录被删/移动盘未挂）时的降级路径只有单测
 * （`tests/unit/workspace.test.ts` 的三态那组），本 spec 不造"重启前把目录删掉"的现场；
 * 插件侧 `host.workspace.defaultPath()` 的读口也不在这里验（它属插件契约面，见 plugins-host /
 * plugins-contract 两份单测）。
 */
test.describe('默认工作区（v2.6.1）', () => {
  const LABEL = 'default-workspace'

  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName(LABEL),
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    return { app, page }
  }

  const kill = async (app: ElectronApplication): Promise<void> => {
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }

  const createWs = async (page: Page, dir: string): Promise<void> => {
    const r = (await page.evaluate(async (p) => (window as any).qihebox.workspace.create(p), dir)) as {
      success: boolean
      error?: string
    }
    expect(r.success, `创建工作区失败：${r.error ?? ''}`).toBe(true)
  }

  const switchWs = async (page: Page, dir: string): Promise<void> => {
    const r = (await page.evaluate(async (p) => (window as any).qihebox.workspace.switch(p), dir)) as {
      success: boolean
      error?: string
    }
    expect(r.success, `切换工作区失败：${r.error ?? ''}`).toBe(true)
  }

  /** 打开顶栏工作区下拉（触发钮是带 🏢 的那枚，含当前工作区名） */
  const openWsMenu = async (page: Page): Promise<void> => {
    await page.locator('header button').filter({ hasText: '🏢' }).first().click()
    await expect(page.getByText('最近工作区')).toBeVisible({ timeout: 5000 })
  }

  /**
   * 某个工作区那一行（行容器 = 名称钮 + 默认钮的父级），限定在顶栏里，别 matched 到页面别处的同形状 div。
   */
  const rowOf = (page: Page, name: string) =>
    page.locator('header div.flex.items-center').filter({ hasText: name })

  /**
   * 让下拉里的「最近工作区」列表看到裸 IPC 建出来的工作区。
   * 存在的理由不是刷新数据，而是**绕开一条渲染层捷径**：本用例建/切工作区走的是
   * `window.qihebox.workspace.*`（不经 `stores/workspace` 的那几个包装函数），
   * 而下拉读的是 `workspaces()` 信号——只有 store 函数或组件挂载才会重拉。
   * 不 reload 就会「盘上已经有了、下拉里没有」，点击目标根本不存在。
   */
  const refreshWsList = async (page: Page): Promise<void> => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await expect(page.locator('header button').filter({ hasText: '🏢' }).first()).toBeVisible({ timeout: 10000 })
  }

  let tmpA = ''
  let tmpB = ''
  let recentsBackup: string | null = null

  test.beforeAll(async () => {
    recentsBackup = await readRecents()
    tmpA = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dw-a-'))
    tmpB = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dw-b-'))
  })

  test.afterAll(async () => {
    // 真实家目录那份 recents 原样还原：本 spec 不该在用户机器上留下任何痕迹
    if (recentsBackup === null) await fsp.rm(RECENTS_FILE, { force: true }).catch(() => {})
    else await fsp.writeFile(RECENTS_FILE, recentsBackup, 'utf-8').catch(() => {})
    await fsp.rm(tmpA, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(tmpB, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(userDataDir(LABEL), { recursive: true, force: true }).catch(() => {})
  })

  test('设为默认 → 真重启开的是默认，不是最近列表首位', async () => {
    const nameA = path.basename(tmpA)
    const nameB = path.basename(tmpB)

    // —— 实例一：造 A、B 两个工作区，并**最后切到 A**（令 recents[0] = A）——
    const first = await launch()
    try {
      await createWs(first.page, tmpA)
      await createWs(first.page, tmpB)
      await switchWs(first.page, tmpA)
      expect(await currentWsPath(first.page)).toBe(tmpA)
      await refreshWsList(first.page)

      await openWsMenu(first.page)
      await rowOf(first.page, nameB).getByRole('button', { name: '设为默认工作区' }).click()

      // 只落 defaultWorkspace 一个键（其余开关保持默认 → 不落盘）
      await expect.poll(async () => readSettingsRaw(LABEL)).toEqual({ defaultWorkspace: tmpB })
      // 行内标记即时可见（不用重启）。exact 是必须的：同排那枚钮此刻写着「取消默认」，
      // 子串匹配会把两格都捞出来撞成 strict-mode violation。
      await expect(rowOf(first.page, nameB).getByText('默认', { exact: true })).toBeVisible()
    } finally {
      await kill(first.app) // 真杀进程：重启语义的唯一证据（reload 证不到跨实例）
    }

    // —— 实例二：同 userData 重启 ——
    const second = await launch()
    try {
      // 判据核心：默认 = B 压过 recents[0] = A
      await expect.poll(async () => currentWsPath(second.page), { timeout: 15000 }).toBe(tmpB)
      // 「开成 B」这件事本身就把 B 顶回了 recents[0]（打开 = 最近使用）——记在这儿，
      // 因为它决定了实例三必须先显式切回 A，否则第三条断言是同义反复（B 本来就是 LRU 首位，开 B 测不到什么）。
      const listAfter = (await second.page.evaluate(async () => (window as any).qihebox.workspace.list())) as {
        data: { path: string }[]
      }
      expect(listAfter.data[0]?.path).toBe(tmpB)

      await openWsMenu(second.page)
      await expect(rowOf(second.page, nameB).getByRole('button', { name: '取消默认工作区' })).toBeVisible()

      // —— 取消默认 → 删键 ——
      await rowOf(second.page, nameB).getByRole('button', { name: '取消默认工作区' }).click()
      await expect.poll(async () => readSettingsRaw(LABEL)).toEqual({})
      await switchWs(second.page, tmpA) // 让 recents[0] 重新变成 A，第三条断言才有分辨力
      expect(await currentWsPath(second.page)).toBe(tmpA)
    } finally {
      await kill(second.app)
    }

    // —— 实例三：没有默认指针了 → 回到 LRU 首位（A）——
    const third = await launch()
    try {
      await expect.poll(async () => currentWsPath(third.page), { timeout: 15000 }).toBe(tmpA)
    } finally {
      await kill(third.app)
    }
  })
})
