import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 与 main 侧同一份 userData 路径口径（e2e 下 index.ts 把 userData 指向 tmpdir/<QIHEBOX_E2E_USERDATA>） */
const userDataDir = (label: string): string => path.join(os.tmpdir(), e2eUserDataDirName(label))

/** 左栏容器列表一行的行根（data-calc-side 由页面自己写死，比 class 链稳） */
const CONTAINER_ROW = '[data-calc-side="container"]'
/** 右栏记录条目大卡的行根（同上） */
const ENTRY = '[data-calc-side="entry"]'
/** 页头 hint =「计算页在场」的唯一文本锚点（换路由即卸载，count 归零） */
const PAGE_PROMPT = '回车记一条 · 点结果复制 · 点算式回填改着再算'
/** 台账落盘位置（`<ws>/.qihefilemanager/calcs.json`，见 src/main/core/paths.ts calcsPath） */
const calcsFile = (wsDir: string): string => path.join(wsDir, '.qihefilemanager', 'calcs.json')
/** 容器台账落盘位置（`<ws>/.qihefilemanager/calc-containers.json`） */
const containersFile = (wsDir: string): string => path.join(wsDir, '.qihefilemanager', 'calc-containers.json')

/** 盘上台账的记录形状（src/main/core/calcs.ts 的 CalcRecord；可选文本字段为空时**不留键**） */
interface CalcRecordShape {
  expression: string
  result: string
  resultKind: 'number' | 'date'
  container_id: string
  saved: boolean
  created: string
  updated: string
  title?: string
  note?: string
}

/** 盘上容器形状（CalcContainer） */
interface CalcContainerShape {
  id: string
  name: string
  created: string
}

const readCalcs = async (wsDir: string): Promise<Record<string, CalcRecordShape>> => {
  try {
    return JSON.parse(await fsp.readFile(calcsFile(wsDir), 'utf-8')) as Record<string, CalcRecordShape>
  } catch {
    return {} // 还没落盘（或读坏了）= 空台账，交给 expect.poll 重试
  }
}

const readContainers = async (wsDir: string): Promise<Record<string, CalcContainerShape>> => {
  try {
    return JSON.parse(await fsp.readFile(containersFile(wsDir), 'utf-8')) as Record<string, CalcContainerShape>
  } catch {
    return {}
  }
}

/** 起一个实例（launch/kill 助手抄 app-settings.spec.ts：同 label 多次 launch = 共享同一 userData） */
const launch = async (label: string): Promise<{ app: ElectronApplication; page: Page }> => {
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName(label) },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  return { app, page }
}

/** 真杀进程（重启语义的唯一证据：`reload` 证不到跨实例持久化） */
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

/**
 * 计算页与计算台账（v2.5.9 A7「计算」· v2.6.1 B15 容器化）端到端。
 *
 * 权威 = `内部计算设计文档（不进公开仓）` §四「容器化修订」（左栏 = 容器列表，右栏 = 该容器下的
 * 计算历史 + 「全部/已标记」tab）/ §十（e2e 主链）。三个 describe 各守一段：
 *  1. **计算页**——渲染层主链：入口（侧栏「工具 → 计算」换页 / `Ctrl+=` 跳页 / `Ctrl+1…6` 位序不挪）、
 *     容器主链（新建容器 → 记一条 → 切走看不到 → 切回仍在）、记一条（展示态 × ÷、落底、空输入忽略）、
 *     「全部 / 已标记」tab、解析失败不落账、`%` 与日期插入钮（含输入条不溢出这条布局回归）、
 *     条目卡交互（点结果复制 / 点算式回填 / 常驻「标记一下」）、右键动词表、编辑标题备注、删除走确认弹窗、
 *     容器重命名 / 删除（删除连记录一起删，确认文案点明条数）；
 *  2. **计算台账跨重启**——§十 那条「重启后容器与归属全在」：同 userData **真杀进程**重启，
 *     容器 / 条目 / 顺序 / 「已标记」态都在，且以盘上 `calc-containers.json` + `calcs.json` 的
 *     container_id 对应关系为证；
 *  3. **老工作区迁移**——无 container_id 的老 calcs.json 首次打开即归入自动创建的「默认」容器，
 *     且**幂等、只写一次**（重启后再读，两个文件逐字节未变）。
 *
 * 几条写法口径：
 * - 启动走 `helpers/launch.ts` 的 userData 夹具（label 隔离），launch/kill 抄 app-settings.spec.ts；
 * - 等一律是条件等待（`expect` / `expect.poll`），**不用 sleep 对齐时序**；
 * - 右键菜单项带 emoji 图标 ⇒ 可及名不是纯文本，菜单内一律非 exact + 限定 `#ctx-menu-root`；
 *   弹窗按钮无图标 ⇒ 可 exact（菜单与弹窗同名「删除」，两处定位不混）；
 * - 容器是**共享台账**里的分区：各用例先建自己的容器再记，行数基线不押在别的用例身上。
 *
 * 跑法（先 `npm run build`，e2e 跑的是 out/ 产物）：
 *   xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/calc.spec.ts
 */
test.describe('计算页（v2.5.9 A7 整页化 · v2.6.1 容器化）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  const entries = () => page.locator(ENTRY)
  const containerRows = () => page.locator(CONTAINER_ROW)
  const input = () => page.getByLabel('算式输入', { exact: true })
  const pagePrompt = () => page.getByText(PAGE_PROMPT)
  const dialog = () => page.getByRole('dialog')
  const ctxMenu = () => page.locator('#ctx-menu-root')

  /** 用例前置：不在计算页就点侧栏「计算」进去（普通导航项，换页不弹层），等容器列与历史拉回来 */
  const ensurePage = async (): Promise<void> => {
    if ((await pagePrompt().count()) === 0) {
      await page.locator('aside').getByRole('button', { name: '计算' }).click()
      await expect(pagePrompt()).toBeVisible({ timeout: 5000 })
    }
    // 左栏容器列是挂载时异步拉的：等「至少一本容器」再交还控制权
    await expect(containerRows().first()).toBeVisible({ timeout: 5000 })
  }

  /** 新建一本容器（弹窗 → 保存）；返回后当前容器即新容器（新→旧排序下它在第一行） */
  const createContainer = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: '新建容器' }).click()
    await expect(dialog()).toBeVisible({ timeout: 5000 })
    await dialog().getByLabel('容器名', { exact: true }).fill(name)
    await dialog().getByRole('button', { name: '保存' }).click()
    await expect(dialog()).toHaveCount(0, { timeout: 5000 })
    await expect(containerRows().filter({ hasText: name })).toHaveCount(1, { timeout: 5000 })
  }

  /** 点左栏一本容器切过去（选中后右栏整列换人） */
  const selectContainer = async (name: string): Promise<void> => {
    await containerRows().filter({ hasText: name }).first().click()
  }

  test.beforeAll(async () => {
    ;({ app, page } = await launch('calc'))
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-calc-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success, `建工作区失败：${JSON.stringify(r)}`).toBe(true)
  })

  test.afterAll(async () => {
    if (app) await kill(app)
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(userDataDir('calc'), { recursive: true, force: true }).catch(() => {})
  })

  test('入口与版式：侧栏「计算」换页 / Ctrl+= 跳页 / Ctrl+1…6 位序不挪；左栏容器、右栏 tab + 输入条', async () => {
    // 本文件第一个用例：此时台账还是空的，空态与自动建的「默认」容器一并钉住
    await ensurePage()
    await expect(page.getByText('还没有记录：输入算式按回车')).toBeVisible()
    await expect(input(), '落到页就聚焦输入框').toBeFocused()
    // 首次打开自动建的那本容器：名字「默认」，且是当前唯一一本
    await expect(containerRows()).toHaveCount(1)
    await expect(containerRows().first()).toContainText('默认')

    // Ctrl+= 跳页（声明表里带 path 的导航项，guard=none ⇒ 输入框里也生效）
    // 先点页头把焦点移出输入框：Ctrl+1…6 是 guard="text" 档——焦点在输入框里时刻意不劫持
    // （那是文本编辑场景），这不是缺陷，故先 blur 再验位序
    await page.locator('h1').click()
    await page.keyboard.press('Control+1')
    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 }).toBe('#/')
    await page.keyboard.press('Control+Equal')
    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 }).toBe('#/calc')
    await expect(pagePrompt()).toBeVisible()

    // 侧栏「工具 → 计算」也是入口（导航项：换页 + 高亮）
    await page.locator('aside').getByRole('button', { name: '计算' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 }).toBe('#/calc')

    // Ctrl+1…6 与前六项的对齐不受新项影响（「计算」是工具组第 7 项，不占位序）
    await page.keyboard.press('Control+6')
    await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 }).toBe('#/clients')
  })

  test('容器主链：新建容器 → 记一条 → 切到另一容器看不到 → 切回仍在', async () => {
    await ensurePage()

    // 默认容器里记一条（它的数量不押死：本用例只认「filter 后 count=1」）
    await input().fill('(3200+380)*1.15')
    await page.keyboard.press('Enter')
    await expect(entries().filter({ hasText: '4,117.00' })).toHaveCount(1, { timeout: 5000 })

    // 新建容器 ⇒ 新→旧排序下它落到第一行，且自动成为当前容器（右栏换成它的历史 = 空）
    await createContainer('客户 A 的账')
    await expect(containerRows()).toHaveCount(2)
    await expect(containerRows().first()).toContainText('客户 A 的账')
    await expect(entries(), '切到新容器后看不到默认容器里的记录').toHaveCount(0, { timeout: 5000 })
    await expect(page.getByText('还没有记录：输入算式按回车')).toBeVisible()

    // 新容器里记一条：只出现在它自己的右栏
    await input().fill('2 × 3')
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(1, { timeout: 5000 })
    await expect(entries().first()).toContainText('6.00')
    await expect(entries().filter({ hasText: '4,117.00' })).toHaveCount(0)

    // 切回默认容器：4,117.00 还在、6.00 看不到
    await selectContainer('默认')
    await expect(entries().filter({ hasText: '4,117.00' })).toHaveCount(1, { timeout: 5000 })
    await expect(entries().filter({ hasText: '6.00' })).toHaveCount(0)

    // 再切回客户 A 的账：6.00 仍在（跨容器切换不丢、不串）
    await selectContainer('客户 A 的账')
    await expect(entries().filter({ hasText: '6.00' })).toHaveCount(1, { timeout: 5000 })
    await expect(entries().filter({ hasText: '4,117.00' })).toHaveCount(0)
  })

  test('记一条：结果与算式取展示态、新条目落底、输入清空、空输入忽略', async () => {
    await ensurePage()
    await createContainer('记一条')
    await expect(entries()).toHaveCount(0)

    await input().fill('(1200+300)*1.05')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '1,575.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })
    // 展示态（不是原始 ASCII）：× ÷ 已渲染，千分位已加
    await expect(entry.getByRole('button', { name: '(1200 + 300) × 1.05' })).toBeVisible()
    await expect(input(), '记完清空输入并交还焦点').toHaveValue('')
    await expect(input()).toBeFocused()
    // 右栏正序（旧的在上、新的在下）：刚记的一条落在最后一张卡
    expect(await entries().last().textContent()).toContain('1,575.00')

    // 空输入 / 纯空格：忽略（不提示、不落账、也不吃掉已敲的内容）
    await expect(input()).toBeFocused()
    await page.keyboard.press('Enter')
    await input().fill('   ')
    await expect(input()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(1)
    await expect(input()).toHaveValue('   ')
    await input().fill('')
  })

  test('「全部 / 已标记」tab：只筛当前容器内记录（默认「全部」）', async () => {
    await ensurePage()
    await createContainer('tab 筛选')

    await input().fill('(1200+300)*1.05')
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(1, { timeout: 5000 })
    await input().fill('(2000+500)*1.2')
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(2, { timeout: 5000 })

    // 默认落在「全部」：两条都在
    await expect(entries()).toHaveCount(2)
    // 标记其中一条（两态唯一视觉差异 = 「已标记」chip）
    const marked = entries().filter({ hasText: '3,000.00' })
    await marked.getByRole('button', { name: '标记一下', exact: true }).click()
    await expect(marked.getByText('已标记')).toHaveCount(1, { timeout: 5000 })

    // 已标记 tab：只剩标记的那一条
    await page.locator('[data-calc-tab="saved"]').click()
    await expect(entries()).toHaveCount(1, { timeout: 5000 })
    await expect(entries().first()).toContainText('3,000.00')
    await expect(entries().filter({ hasText: '1,575.00' })).toHaveCount(0)

    // 全部 tab：两条都回来
    await page.locator('[data-calc-tab="all"]').click()
    await expect(entries()).toHaveCount(2, { timeout: 5000 })

    // tab 只筛「当前容器」：切到一本空容器（保留已标记筛选）⇒ 空态提示，不是把别容器的拿来凑
    await createContainer('tab 空容器')
    await page.locator('[data-calc-tab="saved"]').click()
    await expect(entries()).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByText('这本容器还没有「已标记」的条目')).toBeVisible()

    // 切回 tab 筛选容器：已是「已标记」筛选 ⇒ 仍只有那一条
    await selectContainer('tab 筛选')
    await expect(entries()).toHaveCount(1, { timeout: 5000 })
    await expect(entries().first()).toContainText('3,000.00')
    await page.locator('[data-calc-tab="all"]').click()
  })

  test('解析失败不落账（除零）＋ % 与日期插入钮；底部输入条不横向溢出', async () => {
    await ensurePage()
    await createContainer('插入钮')
    await expect(entries()).toHaveCount(0)

    // 失败只给温和一句：不落账、不清空输入（用户改一下就能重来）
    await input().fill('1/0')
    await page.keyboard.press('Enter')
    await expect(page.getByText('除数不能为 0')).toBeVisible({ timeout: 5000 })
    await expect(entries()).toHaveCount(0)
    await expect(input()).toHaveValue('1/0')
    // 打字即撤提示
    await input().fill('')
    await expect(page.getByText('除数不能为 0')).toHaveCount(0)

    // 布局回归：输入条不得横向溢出卡片（文本框的 min-width:auto 曾把日期触发器挤出输入条右缘，
    // 并连带触发「聚焦 → 浏览器滚回视野 → 滚动事件 → DatePicker 自杀」那条链）。
    // 输入框的父节点就是底部输入条（Input 底座渲染裸 <input>，见 ui/Input.tsx）
    const barFits = await page.evaluate(() => {
      const el = document.querySelector('input[aria-label="算式输入"]')?.parentElement
      if (!el) return null
      return { scrollW: el.scrollWidth, clientW: el.clientWidth }
    })
    expect(barFits, '找不到底部输入条（算式输入框的父节点）').not.toBeNull()
    expect(
      barFits!.scrollW,
      `输入条横向溢出（scrollWidth ${barFits!.scrollW} > clientWidth ${barFits!.clientW}）`,
    ).toBeLessThanOrEqual(barFits!.clientW)

    // `%`：往光标处插，插完焦点回输入框
    await page.getByRole('button', { name: '插入百分号' }).click()
    await expect(input()).toHaveValue('%')
    await expect(input()).toBeFocused()

    // 日期走统一 DatePicker 的「今天」快捷 → 插 YYYY-MM-DD
    await input().fill('')
    await page.getByRole('button', { name: '插入日期' }).click()
    const dp = page.locator('[data-date-panel]')
    await expect(dp).toBeVisible({ timeout: 5000 })
    // 这条 400ms 不是 sleep 对齐时序，**它就是断言本身**：钉「日期面板开完不许自己关」——
    // 上面那条溢出病复发时它会 12ms 后自关；在页面里轮询，消失即返回存活时长供报错
    const survivedMs = await page.evaluate(async () => {
      const t0 = performance.now()
      while (performance.now() - t0 < 400) {
        if (!document.querySelector('[data-date-panel]')) return Math.round(performance.now() - t0)
        await new Promise((r) => setTimeout(r, 20))
      }
      return -1
    })
    expect(survivedMs, `日期面板开完 ${survivedMs}ms 就自己关了（聚焦滚动连锁复发）`).toBe(-1)

    await dp.getByRole('button', { name: '快捷：今天' }).click()
    await expect(input()).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
    await expect(input()).toBeFocused()
    await expect(entries(), '插入钮只改草稿，不落账').toHaveCount(0)
    await input().fill('')
  })

  test('条目卡交互：点结果复制、点算式回填、常驻「标记一下」标记', async () => {
    await ensurePage()
    await createContainer('条目卡')

    await input().fill('(2000+500)*1.2')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '3,000.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })

    // ① 点结果 = 复制千分位文本 + 出声（整宽大卡常驻可见，不再 hover 才现）
    await entry.getByRole('button', { name: '3,000.00' }).click()
    const copied = page.getByText('已复制结果到剪贴板')
    await expect(copied).toBeVisible({ timeout: 5000 })
    // 等这条 toast 自己收（3s）再验下一条同文案的复制，否则第二条断言会被上一条的残影顶成假绿
    await expect(copied).toHaveCount(0, { timeout: 8000 })

    // ② 点算式 = 整条回填输入框（改着再算，计算链从这里长出来）
    await entry.getByRole('button', { name: '(2000 + 500) × 1.2' }).click()
    await expect(input()).toHaveValue('(2000 + 500) × 1.2')
    await expect(input()).toBeFocused()
    await input().fill('')

    // ③ 常驻「标记一下」：两态唯一视觉差异 = 「已标记」chip（chip 只该出现在标记的那一条上）
    await entry.getByRole('button', { name: '标记一下', exact: true }).click()
    await expect(entry.getByText('已标记')).toHaveCount(1, { timeout: 5000 })
    await expect(entries().getByText('已标记')).toHaveCount(1)
    // 标记后按钮文案随状态切换「标记一下」⇄「取消标记」
    await entry.getByRole('button', { name: '取消标记', exact: true }).click()
    await expect(entry.getByText('已标记')).toHaveCount(0, { timeout: 5000 })
    // 全右栏不再有 chip——限定 entries 里数（顶部 tab 的标签本身就叫「已标记」，裸 getByText 会撞它）
    await expect(entries().getByText('已标记')).toHaveCount(0)
  })

  test('右键动词表（记录）＋ 编辑标题备注 ＋ 删除走确认弹窗', async () => {
    await ensurePage()
    await createContainer('右键菜单')

    await input().fill('99*9')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '891.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })

    // 右键动词表（菜单在 #ctx-menu-root 里，与弹窗同名按钮区分开）
    await entry.click({ button: 'right' })
    for (const label of ['复制结果', '复制算式', '编辑标题备注', '标记一下']) {
      await expect(ctxMenu().getByRole('button', { name: label })).toBeVisible({ timeout: 5000 })
    }

    // 编辑标题备注（framed Modal + 补丁式 update；弹窗内控件无图标 ⇒ 可 exact）
    await ctxMenu().getByRole('button', { name: '编辑标题备注' }).click()
    await expect(dialog()).toBeVisible({ timeout: 5000 })
    await dialog().getByLabel('标题', { exact: true }).fill('走查毛利')
    await dialog().getByPlaceholder(/备注（可空）/).fill('e2e 备注')
    await dialog().getByRole('button', { name: '保存' }).click()
    await expect(dialog()).toHaveCount(0, { timeout: 5000 })
    await expect(entry.getByText('走查毛利')).toBeVisible({ timeout: 5000 })
    await expect(entry.getByText('e2e 备注')).toBeVisible()

    // 标记走右键（菜单项）⇒ 菜单里变「取消标记」
    await entry.click({ button: 'right' })
    await ctxMenu().getByRole('button', { name: '标记一下' }).click()
    await expect(entry.getByText('已标记')).toHaveCount(1, { timeout: 5000 })
    await entry.click({ button: 'right' })
    await expect(ctxMenu().getByRole('button', { name: '取消标记' })).toBeVisible({ timeout: 5000 })

    // 删除：菜单项（带 🗑️ 图标 ⇒ 非 exact）→ 弹窗内确认（同名按钮，这里可 exact）
    const countBefore = await entries().count()
    const menuDelete = ctxMenu().getByRole('button', { name: '删除' })
    await entry.click({ button: 'right' })
    await menuDelete.click()
    await expect(page.getByText('删除这条计算？')).toBeVisible({ timeout: 5000 })
    await dialog().getByRole('button', { name: '取消' }).click()
    await expect(entries()).toHaveCount(countBefore) // 取消 = 不删

    await entry.click({ button: 'right' })
    await menuDelete.click()
    await dialog().getByRole('button', { name: '删除', exact: true }).click()
    await expect(entries()).toHaveCount(countBefore - 1, { timeout: 5000 })
    await expect(entry).toHaveCount(0)
  })

  test('容器重命名 / 删除：删除连记录一起删，确认文案点明条数', async () => {
    await ensurePage()
    await createContainer('待重命名')
    await input().fill('7 * 6')
    await page.keyboard.press('Enter')
    await expect(entries().filter({ hasText: '42.00' })).toHaveCount(1, { timeout: 5000 })

    // 重命名：右键容器行 → 重命名（改名只动 name，记录按 id 归属不受影响）
    await containerRows().filter({ hasText: '待重命名' }).first().click({ button: 'right' })
    await ctxMenu().getByRole('button', { name: '重命名' }).click()
    await expect(dialog()).toBeVisible({ timeout: 5000 })
    await dialog().getByLabel('容器名', { exact: true }).fill('改名后')
    await dialog().getByRole('button', { name: '保存' }).click()
    await expect(dialog()).toHaveCount(0, { timeout: 5000 })
    await expect(containerRows().filter({ hasText: '改名后' })).toHaveCount(1, { timeout: 5000 })
    await expect(entries().filter({ hasText: '42.00' }), '改名后记录仍在原容器里').toHaveCount(1)

    // 删除：先取消（不删），再确认——确认文案必须点明「这容器里有几条」
    await containerRows().filter({ hasText: '改名后' }).first().click({ button: 'right' })
    await ctxMenu().getByRole('button', { name: '删除' }).click()
    await expect(page.getByText('删除这本容器？')).toBeVisible({ timeout: 5000 })
    await expect(dialog().getByText(/1 条计算记录会一起删除/)).toBeVisible()
    await dialog().getByRole('button', { name: '取消' }).click()
    await expect(containerRows().filter({ hasText: '改名后' })).toHaveCount(1)
    await expect(entries().filter({ hasText: '42.00' })).toHaveCount(1)

    await containerRows().filter({ hasText: '改名后' }).first().click({ button: 'right' })
    await ctxMenu().getByRole('button', { name: '删除' }).click()
    await dialog().getByRole('button', { name: '删除', exact: true }).click()
    await expect(containerRows().filter({ hasText: '改名后' })).toHaveCount(0, { timeout: 5000 })
    await expect(entries().filter({ hasText: '42.00' })).toHaveCount(0, { timeout: 5000 })
    // 删除后选中落到仍存在的容器上（不悬空）：右栏照常可记
    await expect(containerRows().first()).toBeVisible()
    await expect(input()).toBeVisible()
  })
})

/**
 * §十 那条「重启后容器与归属全在」：客户端里建容器、记两条（第一条标记，归到新容器）→ 真杀进程 →
 * 同 userData 重启，容器 / 条目 / 顺序 / 「已标记」态都还在，并以盘上 `calc-containers.json` 与
 * `calcs.json` 的 container_id 对应关系为证（UI 与磁盘两头对得上才算数）。
 * 「最近工作区自动恢复」不在这里当被测对象（那是 sidebar.spec 的口径）：本用例只保证第二个实例
 * 跑在同一工作区上——并发/串行的其他 spec 也会往真实家目录的 recents 里写，靠自动恢复等于把断言
 * 押在别人身上，故不同就显式 `workspace.open`。
 */
test.describe('计算台账跨重启（v2.6.1 容器化）', () => {
  test('重启后容器、归属、顺序与「已标记」态都在（真杀进程，盘上两份台账为证）', async () => {
    const label = 'calc-restart'
    await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-calc-ws-'))
    let calcsSnapshot = ''
    let containerId = ''

    try {
      // —— 实例一：建容器 + 记两条 + 把第一条标记 ——
      const first = await launch(label)
      try {
        const created = await first.page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
        expect(created.success, `建工作区失败：${JSON.stringify(created)}`).toBe(true)

        const input1 = first.page.getByLabel('算式输入', { exact: true })
        const entries1 = first.page.locator(ENTRY)
        await first.page.keyboard.press('Control+Equal')
        await expect(first.page.getByText(PAGE_PROMPT)).toBeVisible({ timeout: 5000 })
        // 首次打开：自动建「默认」容器（漂到盘上）
        await expect(first.page.locator(CONTAINER_ROW)).toHaveCount(1, { timeout: 5000 })
        await expect
          .poll(async () => Object.values(await readContainers(wsDir)).map((c) => c.name), { timeout: 5000 })
          .toEqual(['默认'])

        // 新建容器（新→旧 ⇒ 落到第一行并自动选中），两条都记在它里面
        await first.page.getByRole('button', { name: '新建容器' }).click()
        await first.page.getByRole('dialog').getByLabel('容器名', { exact: true }).fill('重启验证')
        await first.page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
        await expect(first.page.locator(CONTAINER_ROW)).toHaveCount(2, { timeout: 5000 })

        await input1.fill('(3200+380)*1.15')
        await first.page.keyboard.press('Enter')
        await expect(entries1.filter({ hasText: '4,117.00' })).toHaveCount(1, { timeout: 5000 })
        await input1.fill('2026-09-16 + 60')
        await first.page.keyboard.press('Enter')
        await expect(entries1.filter({ hasText: '2026-11-15' })).toHaveCount(1, { timeout: 5000 })
        await expect(entries1).toHaveCount(2)

        // 第一条标记（右栏正序 = 录入序 ⇒ first() 即第一条）
        const firstEntry = entries1.first()
        await firstEntry.getByRole('button', { name: '标记一下', exact: true }).click()
        await expect(firstEntry.getByText('已标记')).toHaveCount(1, { timeout: 5000 })

        // 盘上容器台账：两本、名字与创建序（默认先建）；两条记录的 container_id 都指向「重启验证」
        await expect
          .poll(async () => Object.values(await readContainers(wsDir)).map((c) => c.name), { timeout: 5000 })
          .toEqual(['默认', '重启验证'])
        const containers = await readContainers(wsDir)
        containerId = Object.values(containers).find((c) => c.name === '重启验证')!.id
        await expect(
          Object.values(containers).find((c) => c.name === '默认')!.id,
          '默认容器与重启验证容器 id 不得相同',
        ).not.toBe(containerId)

        // 盘上计算台账：两条、顺序、两态、展示态，且归属都在新容器（不是「无主漂在默认里」）
        await expect
          .poll(
            async () =>
              Object.values(await readCalcs(wsDir)).map((r) => ({
                expression: r.expression,
                result: r.result,
                resultKind: r.resultKind,
                saved: r.saved,
                container_id: r.container_id,
              })),
            { timeout: 5000 },
          )
          .toEqual([
            { expression: '(3200 + 380) × 1.15', result: '4,117.00', resultKind: 'number', saved: true, container_id: containerId },
            { expression: '2026-09-16 + 60', result: '2026-11-15', resultKind: 'date', saved: false, container_id: containerId },
          ])
        const recs = Object.values(await readCalcs(wsDir))
        for (const r of recs) {
          expect(Number.isFinite(Date.parse(r.created)), `created 不是可解析时间：${r.created}`).toBe(true)
          expect(Number.isFinite(Date.parse(r.updated)), `updated 不是可解析时间：${r.updated}`).toBe(true)
          // 记一条时 created=updated；标记只刷 updated ⇒ updated 不早于 created
          expect(Date.parse(r.updated), `${r.expression} 的 updated 早于 created`).toBeGreaterThanOrEqual(
            Date.parse(r.created),
          )
          // 标题/备注从未填过 ⇒ 盘上连键都不该有（「清空」与「从未填过」同形态）
          expect(Object.keys(r)).not.toContain('title')
          expect(Object.keys(r)).not.toContain('note')
        }
        calcsSnapshot = await fsp.readFile(calcsFile(wsDir), 'utf-8')
      } finally {
        await kill(first.app)
      }

      // —— 实例二：同 userData 重启 ——
      const second = await launch(label)
      try {
        const cur = await second.page.evaluate(() => (window as any).qihebox.workspace.current())
        if (cur?.data?.path !== wsDir) {
          const opened = await second.page.evaluate((dir) => (window as any).qihebox.workspace.open(dir), wsDir)
          expect(opened.success, `显式打开工作区失败：${JSON.stringify(opened)}`).toBe(true)
        }
        await expect
          .poll(
            async () => (await second.page.evaluate(() => (window as any).qihebox.workspace.current()))?.data?.path,
            { timeout: 5000 },
          )
          .toBe(wsDir)

        await second.page.keyboard.press('Control+Equal')
        await expect(second.page.getByText(PAGE_PROMPT)).toBeVisible({ timeout: 5000 })

        // 左栏两本容器都在，名字与 id 与盘上一致（新→旧 ⇒ 「重启验证」在前、「默认」在后）
        const rows2 = second.page.locator(CONTAINER_ROW)
        await expect(rows2).toHaveCount(2, { timeout: 5000 })
        await expect(rows2.nth(0)).toContainText('重启验证')
        await expect(rows2.nth(1)).toContainText('默认')

        // 重启后落到的当前容器（最新的「重启验证」）：两条记录、顺序与「已标记」态都在
        const entries2 = second.page.locator(ENTRY)
        await expect(entries2, '重启后当前容器里的历史两条都在').toHaveCount(2, { timeout: 5000 })
        const texts = await entries2.allTextContents()
        expect(texts[0], '第一条算式').toContain('(3200 + 380) × 1.15')
        expect(texts[0], '第一条结果').toContain('4,117.00')
        expect(texts[1], '第二条算式').toContain('2026-09-16 + 60')
        expect(texts[1], '第二条结果').toContain('2026-11-15')
        await expect(entries2.getByText('已标记')).toHaveCount(1)
        await expect(entries2.nth(0).getByText('已标记')).toHaveCount(1)
        await expect(entries2.nth(1).getByText('已标记')).toHaveCount(0)

        // 切到「默认」：里面没有「重启验证」的记录（归属跟着容器走，不是全局一锅）
        await rows2.nth(1).click()
        await expect(entries2).toHaveCount(0, { timeout: 5000 })
        await expect(second.page.getByText('还没有记录：输入算式按回车')).toBeVisible()

        // 读路径不改盘：重启 + 进计算页（挂载即跑 listContainers/list）+ 切容器之后，calcs.json 逐字未变
        expect(await fsp.readFile(calcsFile(wsDir), 'utf-8'), '重启后的读路径把 calcs.json 改写了').toBe(calcsSnapshot)
        // 容器台账同样没被重写（已迁移/已存在 ⇒ 幂等不落笔）
        const containers2 = await readContainers(wsDir)
        expect(Object.values(containers2).find((c) => c.name === '重启验证')!.id).toBe(containerId)
      } finally {
        await kill(second.app)
      }
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    }
  })
})

/**
 * 老工作区迁移（§四 对象模型）：v2.5.9 的 calcs.json 里没有 container_id、也没有容器台账 ——
 * 首次打开时自动建「默认」容器并把老记录归进去；**幂等、只写一次**（重启后再读，两个文件逐字节未变）。
 */
test.describe('老工作区迁移（无 container_id → 默认容器）', () => {
  test('首次打开归入「默认」；重启后仍是同一本容器、字节未变（幂等）', async () => {
    const label = 'calc-migrate'
    await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-calc-legacy-'))
    let calcsSnapshot = ''
    let containersSnapshot = ''

    try {
      // 老工作区形态：先建工作区，再手工写一份 v2.5.9 形状的 calcs.json（无 container_id / 无容器台账）
      const seed = await launch(label)
      try {
        const created = await seed.page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
        expect(created.success, `建工作区失败：${JSON.stringify(created)}`).toBe(true)
      } finally {
        await kill(seed.app)
      }
      const legacy = {
        'old-1': {
          id: 'old-1',
          expression: '(3200 + 380) × 1.15',
          result: '4,117.00',
          resultKind: 'number',
          saved: true,
          created: '2026-09-01T00:00:00.000Z',
          updated: '2026-09-01T00:00:00.000Z',
        },
        'old-2': {
          id: 'old-2',
          expression: '2026-09-16 + 60',
          result: '2026-11-15',
          resultKind: 'date',
          saved: false,
          title: '老标题',
          created: '2026-09-02T00:00:00.000Z',
          updated: '2026-09-02T00:00:00.000Z',
        },
      }
      await fsp.writeFile(calcsFile(wsDir), JSON.stringify(legacy, null, 2), 'utf-8')

      // —— 首次打开：自动建「默认」，老记录整批归进去（UI 一眼可见） ——
      const first = await launch(label)
      try {
        const opened = await first.page.evaluate((dir) => (window as any).qihebox.workspace.open(dir), wsDir)
        expect(opened.success, `打开老工作区失败：${JSON.stringify(opened)}`).toBe(true)
        await first.page.keyboard.press('Control+Equal')
        await expect(first.page.getByText(PAGE_PROMPT)).toBeVisible({ timeout: 5000 })

        const rows = first.page.locator(CONTAINER_ROW)
        await expect(rows).toHaveCount(1, { timeout: 5000 })
        await expect(rows.first()).toContainText('默认')
        const entries = first.page.locator(ENTRY)
        await expect(entries, '老记录两条都躺在默认容器里').toHaveCount(2, { timeout: 5000 })
        // 迁移只补归属：saved 两态与标题一字未动
        await expect(entries.getByText('已标记')).toHaveCount(1)
        await expect(entries.filter({ hasText: '4,117.00' })).toHaveCount(1)
        await expect(entries.filter({ hasText: '老标题' })).toHaveCount(1)

        // 盘上：container_id 已补写、指向「默认」，其它字段原样
        const containers = await readContainers(wsDir)
        expect(Object.values(containers).map((c) => c.name)).toEqual(['默认'])
        const defaultId = Object.values(containers)[0].id
        const recs = await readCalcs(wsDir)
        expect(recs['old-1'].container_id).toBe(defaultId)
        expect(recs['old-2'].container_id).toBe(defaultId)
        expect(recs['old-1'].saved).toBe(true)
        expect(recs['old-2'].saved).toBe(false)
        expect(recs['old-2'].title).toBe('老标题')
        expect(recs['old-1'].created).toBe('2026-09-01T00:00:00.000Z')
        calcsSnapshot = await fsp.readFile(calcsFile(wsDir), 'utf-8')
        containersSnapshot = await fsp.readFile(containersFile(wsDir), 'utf-8')
      } finally {
        await kill(first.app)
      }

      // —— 重启：仍是同一本「默认」、同一批归属；迁移幂等，两个文件逐字节未变 ——
      const second = await launch(label)
      try {
        const opened = await second.page.evaluate((dir) => (window as any).qihebox.workspace.open(dir), wsDir)
        expect(opened.success, `再次打开工作区失败：${JSON.stringify(opened)}`).toBe(true)
        await second.page.keyboard.press('Control+Equal')
        await expect(second.page.getByText(PAGE_PROMPT)).toBeVisible({ timeout: 5000 })
        await expect(second.page.locator(CONTAINER_ROW)).toHaveCount(1, { timeout: 5000 })
        await expect(second.page.locator(ENTRY)).toHaveCount(2, { timeout: 5000 })
        expect(await fsp.readFile(calcsFile(wsDir), 'utf-8'), '重启后的读路径把 calcs.json 改写了（迁移不幂等）').toBe(calcsSnapshot)
        expect(
          await fsp.readFile(containersFile(wsDir), 'utf-8'),
          '重启后的读路径把 calc-containers.json 改写了（迁移不幂等）',
        ).toBe(containersSnapshot)
      } finally {
        await kill(second.app)
      }
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    }
  })
})