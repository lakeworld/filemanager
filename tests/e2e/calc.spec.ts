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

/** 左栏历史索引一行的行根（data-calc-side 由页面自己写死，比 class 链稳） */
const HISTORY_ROW = '[data-calc-side="history"]'
/** 右栏记录条目大卡的行根（同上） */
const ENTRY = '[data-calc-side="entry"]'
/** 页头 hint =「计算页在场」的唯一文本锚点（换路由即卸载，count 归零） */
const PAGE_PROMPT = '回车记一条 · 点结果复制 · 点算式回填改着再算'
/** 台账落盘位置（`<ws>/.qihefilemanager/calcs.json`，见 src/main/core/paths.ts calcsPath） */
const calcsFile = (wsDir: string): string => path.join(wsDir, '.qihefilemanager', 'calcs.json')

/** 盘上台账的记录形状（src/main/core/calcs.ts 的 CalcRecord；可选文本字段为空时**不留键**） */
interface CalcRecordShape {
  expression: string
  result: string
  resultKind: 'number' | 'date'
  saved: boolean
  created: string
  updated: string
  title?: string
  note?: string
}

const readCalcs = async (wsDir: string): Promise<Record<string, CalcRecordShape>> => {
  try {
    return JSON.parse(await fsp.readFile(calcsFile(wsDir), 'utf-8')) as Record<string, CalcRecordShape>
  } catch {
    return {} // 还没落盘（或读坏了）= 空台账，交给 expect.poll 重试
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
 * 计算页与计算台账（v2.5.9 A7「计算」· 2026-09-22 深夜整页化修订）端到端。
 *
 * 权威 = `docs/INTERNAL/PLAN-v2.6-计算.md` §四（2026-09-22 深夜整页化后的新版式：左历史索引 + 右计算区）
 * / §八（拍板）/ §十（e2e 主链）。两个 describe 各守一段：
 *  1. **计算页**——渲染层主链：入口（侧栏「工具 → 计算」换页 / `Ctrl+=` 跳页）、双栏版式
 *     （左栏新→旧且行内含结果、点左栏行右栏定位高亮）、记一条（展示态 × ÷、正序落底、空输入忽略）、
 *     解析失败不落账、`%` 与日期插入钮（含输入条不溢出这条布局回归）、条目卡交互（点结果复制 /
 *     点算式回填 / 常驻「存为资料」）、右键动词表、编辑标题备注、删除走确认弹窗；
 *  2. **计算台账跨重启**——§十 那条「重启应用历史仍在」：同 userData **真杀进程**重启，
 *     条目 / 顺序 / 「已存资料」态都在，且以盘上 `calcs.json` 为证。
 *
 * 几条写法口径：
 * - 启动走 `helpers/launch.ts` 的 userData 夹具（label 隔离），launch/kill 抄 app-settings.spec.ts；
 * - 等一律是条件等待（`expect` / `expect.poll`），**不用 sleep 对齐时序**；
 * - 右键菜单项带 emoji 图标 ⇒ 可及名不是纯文本，菜单内一律非 exact + 限定 `#ctx-menu-root`；
 *   弹窗按钮无图标 ⇒ 可 exact（菜单与弹窗同名「删除」，两处定位不混）。
 *
 * 跑法（先 `npm run build`，e2e 跑的是 out/ 产物）：
 *   xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test tests/e2e/calc.spec.ts
 */
test.describe('计算页（v2.5.9 A7 整页化）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  const entries = () => page.locator(ENTRY)
  const historyRows = () => page.locator(HISTORY_ROW)
  const input = () => page.getByLabel('算式输入', { exact: true })
  const pagePrompt = () => page.getByText(PAGE_PROMPT)

  /** 用例前置：不在计算页就点侧栏「计算」进去（普通导航项，换页不弹层），等历史拉回来 */
  const ensurePage = async (): Promise<void> => {
    if ((await pagePrompt().count()) === 0) {
      await page.locator('aside').getByRole('button', { name: '计算' }).click()
      await expect(pagePrompt()).toBeVisible({ timeout: 5000 })
      // 历史是挂载时异步拉的：等「要么空态、要么条目已渲染」再交还控制权，
      // 免得用例拿到的条目数是「还没加载完」的中间态（以下各用例的行数基线都靠这条）
      await expect(page.getByText('还没有记录：输入算式按回车').or(entries().first())).toBeVisible({ timeout: 5000 })
    }
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

  test('入口：侧栏「计算」换页 / Ctrl+= 跳页 / Ctrl+1…6 位序不挪', async () => {
    // 本文件第一个用例：此时台账还是空的，空态一并钉住
    await ensurePage()
    await expect(page.getByText('还没有记录：输入算式按回车')).toBeVisible()
    await expect(input(), '落到页就聚焦输入框').toBeFocused()

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

  test('双栏版式：左栏新→旧且行内含结果；点左栏行 ⇒ 右栏对应卡高亮', async () => {
    await ensurePage()
    await input().fill('(3200+380)*1.15')
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(1, { timeout: 5000 })
    await input().fill('2026-09-16 + 60')
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(2, { timeout: 5000 })

    // 左栏 = 新→旧：第 0 行是后记的日期条，第 1 行是先记的数字条；行内含结果（不等去右栏看）
    const rows = historyRows()
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('2026-11-15')
    await expect(rows.nth(0)).toContainText('2026-09-16 + 60')
    await expect(rows.nth(1)).toContainText('4,117.00')
    await expect(rows.nth(1)).toContainText('(3200 + 380) × 1.15')

    // 点左栏第 1 行（旧的那条）⇒ 右栏对应条目卡高亮（card-selected，1.2s 自熄）
    const target = entries().filter({ hasText: '4,117.00' })
    await rows.nth(1).click()
    await expect(target, '点左栏行后右栏对应卡高亮').toHaveClass(/card-selected/, { timeout: 3000 })
  })

  test('记一条：结果与算式取展示态、新条目落底、输入清空、空输入忽略', async () => {
    await ensurePage()
    const before = await entries().count()

    await input().fill('(1200+300)*1.05')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '1,575.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })
    // 展示态（不是原始 ASCII）：× ÷ 已渲染，千分位已加
    await expect(entry.getByRole('button', { name: '(1200 + 300) × 1.05' })).toBeVisible()
    await expect(input(), '记完清空输入并交还焦点').toHaveValue('')
    await expect(input()).toBeFocused()
    // 右栏正序（旧的在上、新的在下）：刚记的一条落在最后一张卡
    await expect(entries()).toHaveCount(before + 1)
    expect(await entries().last().textContent()).toContain('1,575.00')

    // 空输入 / 纯空格：忽略（不提示、不落账、也不吃掉已敲的内容）
    await expect(input()).toBeFocused()
    await page.keyboard.press('Enter')
    await input().fill('   ')
    await expect(input()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(entries()).toHaveCount(before + 1)
    await expect(input()).toHaveValue('   ')
    await input().fill('')
  })

  test('解析失败不落账（除零）＋ % 与日期插入钮；底部输入条不横向溢出', async () => {
    await ensurePage()
    const before = await entries().count()

    // 失败只给温和一句：不落账、不清空输入（用户改一下就能重来）
    await input().fill('1/0')
    await page.keyboard.press('Enter')
    await expect(page.getByText('除数不能为 0')).toBeVisible({ timeout: 5000 })
    await expect(entries()).toHaveCount(before)
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
    await expect(entries(), '插入钮只改草稿，不落账').toHaveCount(before)
    await input().fill('')
  })

  test('条目卡交互：点结果复制、点算式回填、常驻「存为资料」转正（chip 两态唯一差异）', async () => {
    await ensurePage()
    const before = await entries().count()

    // 值与前面用例错开：同 describe 共用一个工作区台账，(1200+300)*1.05 已被「双栏版式」用例记过
    await input().fill('(2000+500)*1.2')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '3,000.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })
    await expect(entries()).toHaveCount(before + 1)

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

    // ③ 常驻「存为资料」：两态唯一视觉差异 = 「已存资料」chip（chip 只该出现在转正的那一条上）
    await entry.getByRole('button', { name: '存为资料', exact: true }).click()
    await expect(entry.getByText('已存资料')).toHaveCount(1, { timeout: 5000 })
    await expect(entries().getByText('已存资料')).toHaveCount(1)
    // 转正后按钮文案随状态切换「存为资料」⇄「取消转正」
    await entry.getByRole('button', { name: '取消转正', exact: true }).click()
    await expect(entry.getByText('已存资料')).toHaveCount(0, { timeout: 5000 })
    await expect(page.getByText('已存资料')).toHaveCount(0)
  })

  test('右键动词表（含转正后「取消转正」）＋ 编辑标题备注 ＋ 删除走确认弹窗', async () => {
    await ensurePage()
    await input().fill('99*9')
    await page.keyboard.press('Enter')
    const entry = entries().filter({ hasText: '891.00' })
    await expect(entry).toHaveCount(1, { timeout: 5000 })

    // 右键动词表（菜单在 #ctx-menu-root 里，与弹窗同名按钮区分开）
    const menu = page.locator('#ctx-menu-root')
    await entry.click({ button: 'right' })
    for (const label of ['复制结果', '复制算式', '编辑标题备注', '存为资料']) {
      await expect(menu.getByRole('button', { name: label })).toBeVisible({ timeout: 5000 })
    }

    // 编辑标题备注（framed Modal + 补丁式 update；弹窗内控件无图标 ⇒ 可 exact）
    const dlg = page.getByRole('dialog')
    await menu.getByRole('button', { name: '编辑标题备注' }).click()
    await expect(dlg).toBeVisible({ timeout: 5000 })
    await dlg.getByLabel('标题', { exact: true }).fill('走查毛利')
    await dlg.getByPlaceholder(/备注（可空）/).fill('e2e 备注')
    await dlg.getByRole('button', { name: '保存' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 5000 })
    await expect(entry.getByText('走查毛利')).toBeVisible({ timeout: 5000 })
    await expect(entry.getByText('e2e 备注')).toBeVisible()

    // 转正走右键（菜单项）⇒ 菜单里变「取消转正」
    await entry.click({ button: 'right' })
    await menu.getByRole('button', { name: '存为资料' }).click()
    await expect(entry.getByText('已存资料')).toHaveCount(1, { timeout: 5000 })
    await entry.click({ button: 'right' })
    await expect(menu.getByRole('button', { name: '取消转正' })).toBeVisible({ timeout: 5000 })

    // 删除：菜单项（带 🗑️ 图标 ⇒ 非 exact）→ 弹窗内确认（同名按钮，这里可 exact）
    const countBefore = await entries().count()
    const menuDelete = menu.getByRole('button', { name: '删除' })
    await entry.click({ button: 'right' })
    await menuDelete.click()
    await expect(page.getByText('删除这条计算？')).toBeVisible({ timeout: 5000 })
    await dlg.getByRole('button', { name: '取消' }).click()
    await expect(entries()).toHaveCount(countBefore) // 取消 = 不删

    await entry.click({ button: 'right' })
    await menuDelete.click()
    await dlg.getByRole('button', { name: '删除', exact: true }).click()
    await expect(entries()).toHaveCount(countBefore - 1, { timeout: 5000 })
    await expect(entry).toHaveCount(0)
  })
})

/**
 * PLAN §十 那条「重启应用历史还在」：计算页里记两条（第一条转正）→ 真杀进程 → 同 userData 重启，
 * 条目 / 顺序 / 「已存资料」态都还在，并以盘上 `calcs.json` 为证（UI 与磁盘两头对得上才算数）。
 * 「最近工作区自动恢复」不在这里当被测对象（那是 sidebar.spec 的口径）：本用例只保证第二个实例
 * 跑在同一工作区上——并发/串行的其他 spec 也会往真实家目录的 recents 里写，靠自动恢复等于把断言
 * 押在别人身上，故不同就显式 `workspace.open`。
 */
test.describe('计算台账跨重启（v2.5.9 A7 整页化）', () => {
  test('重启后历史、顺序与「已存资料」态都在（真杀进程，盘上 calcs.json 为证）', async () => {
    const label = 'calc-restart'
    await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-calc-ws-'))
    let persisted = ''

    try {
      // —— 实例一：记两条 + 把第一条转正 ——
      const first = await launch(label)
      try {
        const created = await first.page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
        expect(created.success, `建工作区失败：${JSON.stringify(created)}`).toBe(true)

        const input1 = first.page.getByLabel('算式输入', { exact: true })
        const entries1 = first.page.locator(ENTRY)
        await first.page.keyboard.press('Control+Equal')
        await expect(first.page.getByText(PAGE_PROMPT)).toBeVisible({ timeout: 5000 })

        await input1.fill('(3200+380)*1.15')
        await first.page.keyboard.press('Enter')
        // 结果文本会同时出现在左栏索引行与右栏条目卡 ⇒ 一律限定右栏锚点，别用裸 getByText
        // （整页化后同一记录两处呈现，裸文本定位会撞 strict 双命中）
        await expect(entries1.filter({ hasText: '4,117.00' })).toHaveCount(1, { timeout: 5000 })
        await input1.fill('2026-09-16 + 60')
        await first.page.keyboard.press('Enter')
        await expect(entries1.filter({ hasText: '2026-11-15' })).toHaveCount(1, { timeout: 5000 })
        await expect(entries1).toHaveCount(2)

        // 第一条转正（右栏正序 = 录入序 ⇒ first() 即第一条）
        const firstEntry = entries1.first()
        await firstEntry.getByRole('button', { name: '存为资料', exact: true }).click()
        await expect(firstEntry.getByText('已存资料')).toHaveCount(1, { timeout: 5000 })

        // 盘上台账：两条、顺序、两态、展示态、时间戳形状（轮询到落盘，不 sleep）
        await expect
          .poll(
            async () =>
              Object.values(await readCalcs(wsDir)).map((r) => ({
                expression: r.expression,
                result: r.result,
                resultKind: r.resultKind,
                saved: r.saved,
              })),
            { timeout: 5000 },
          )
          .toEqual([
            { expression: '(3200 + 380) × 1.15', result: '4,117.00', resultKind: 'number', saved: true },
            { expression: '2026-09-16 + 60', result: '2026-11-15', resultKind: 'date', saved: false },
          ])
        const recs = Object.values(await readCalcs(wsDir))
        for (const r of recs) {
          expect(Number.isFinite(Date.parse(r.created)), `created 不是可解析时间：${r.created}`).toBe(true)
          expect(Number.isFinite(Date.parse(r.updated)), `updated 不是可解析时间：${r.updated}`).toBe(true)
          // 记一条时 created=updated；转正只刷 updated ⇒ updated 不早于 created
          expect(Date.parse(r.updated), `${r.expression} 的 updated 早于 created`).toBeGreaterThanOrEqual(
            Date.parse(r.created),
          )
          // 标题/备注从未填过 ⇒ 盘上连键都不该有（「清空」与「从未填过」同形态）
          expect(Object.keys(r)).not.toContain('title')
          expect(Object.keys(r)).not.toContain('note')
        }
        persisted = await fsp.readFile(calcsFile(wsDir), 'utf-8')
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
        const entries2 = second.page.locator(ENTRY)
        await expect(entries2, '重启后历史两条都在').toHaveCount(2, { timeout: 5000 })

        // 顺序与内容逐条对：第 0 张卡 = 先记的那条（含展示态算式与结果），第 1 张 = 后记的日期条
        const texts = await entries2.allTextContents()
        expect(texts[0], '第一条算式').toContain('(3200 + 380) × 1.15')
        expect(texts[0], '第一条结果').toContain('4,117.00')
        expect(texts[1], '第二条算式').toContain('2026-09-16 + 60')
        expect(texts[1], '第二条结果').toContain('2026-11-15')
        // 「已存资料」态跟着条目回来，且只挂在第一条上
        await expect(entries2.getByText('已存资料')).toHaveCount(1)
        await expect(entries2.nth(0).getByText('已存资料')).toHaveCount(1)
        await expect(entries2.nth(1).getByText('已存资料')).toHaveCount(0)

        // 读路径不改盘：重启 + 进计算页（挂载即跑一遍 calcs.list）之后，文件逐字未变
        expect(await fsp.readFile(calcsFile(wsDir), 'utf-8'), '重启后的读路径把 calcs.json 改写了').toBe(persisted)
      } finally {
        await kill(second.app)
      }
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    }
  })
})
