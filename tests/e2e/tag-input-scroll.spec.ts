import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * TagInput 下拉面板的滚动回归（用户报「改信息弹窗里标签选择区滑动有 bug，滚不动/跳顶/空白都有」）。
 *
 * 根因（探针实测，读数见下）：`TagInput` 把「滚动即关」无条件挂在 `window` 的**捕获**阶段，
 * 而面板自己是 `max-h-48 overflow-y-auto` —— 两个特性互相残：**在面板里滚第一格就把整个下拉关掉**。
 * 后果不是"不好看"而是**功能不可达**：实测 30 个标签时面板 scrollHeight 968 / clientHeight 190
 * （一屏只看得见约 7 行），滚不动 ⇒ 尾部 23 个标签在改信息弹窗里永远选不到；重开又从头 ⇒
 * 用户主观读作"跳顶/空白/错位"。
 *
 * 同一家缺陷 `ui/SearchSelect.tsx` v2.5.8 已经修过并留了注释（"选项 >7 条时面板内 .vscroll
 * 一翻页就把自己关掉"），当时**没有同步到 TagInput**——本文件把那边的判据口径搬过来钉死，
 * 顺带钉住修复的两半：面板内滚动不关（含真滚轮）、键盘 ↓ 高亮行必须进视野。
 * ⚠ 反向护栏在同一条链的第四例：祖先容器（弹窗主体）滚动**仍须关闭**——那是原设计意图，
 *    不能为了修这个 bug 把面板改成"飘在错位上也不关"。
 */
test.describe('TagInput 下拉滚动（改信息弹窗内的标签选择区）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  const TAG_COUNT = 30

  test.beforeAll(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tagscroll-'))
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('tag-input-scroll') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    // 造够多的标签定义让面板必须滚动，再建一个产品集作为改信息弹窗的主体
    await page.evaluate(async (n) => {
      for (let i = 1; i <= n; i += 1) {
        await (window as any).qihebox.tags.create(`滚动探针标签${String(i).padStart(2, '0')}`, '#64748b', null, undefined)
      }
    }, TAG_COUNT)
    await page.evaluate(() => (window as any).qihebox.ui.openCreatePrefill('productSet', { name: '标签滚动探针集' }))
    const cdlg = page.locator('[role="dialog"][aria-label="新建产品集"]')
    await expect(cdlg).toBeVisible({ timeout: 10000 })
    await cdlg.getByRole('button', { name: '确认创建' }).click()
    await expect(cdlg).toHaveCount(0, { timeout: 10000 })
    // 重新挂载页面：标签定义由各页 onMount 的 loadTagDefs() 拉，重开一次拿到全量 30 条
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    if (app) {
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
  })

  const panel = () => page.locator('div.fixed.z-\\[70\\]') // TagInput 的 Portal 面板
  const tagInputBox = () => page.locator('input[placeholder="如：客户、重点"]')

  /** 打开「编辑产品集信息」弹窗并把焦点送进标签输入框 ⇒ 下拉打开 */
  const openTagDropdown = async (): Promise<void> => {
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/product-sets')
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => (window as any).qihebox.ui.openEditPrefill('productSet', '标签滚动探针集', {}))
    const dlg = page.locator('[role="dialog"]', { hasText: '编辑产品集信息' })
    await expect(dlg).toBeVisible({ timeout: 15000 })
    await tagInputBox().click()
    await page.waitForTimeout(300)
    await expect(panel()).toBeVisible({ timeout: 10000 })
  }

  test('面板确实需要滚动（30 条 ≫ 一屏），且滚动后不被关闭——尾部标签可达', async () => {
    await openTagDropdown()
    const geo = await panel().evaluate((el) => ({
      rows: el.querySelectorAll('button').length,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    }))
    expect(geo.rows).toBe(TAG_COUNT) // 30 条候选都在面板里（不是被截断成 7 条）
    expect(geo.scrollH).toBeGreaterThan(geo.clientH) // 且必然要滚

    // 用户在面板里翻到底部那一下：面板不得自杀
    const lastText = await panel().evaluate((el) => (el.querySelectorAll('button')[(el.querySelectorAll('button').length - 1)] as HTMLElement).textContent)
    await panel().evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(panel(), '面板内滚动把下拉关掉 ⇒ 尾部标签选不到（本 bug 的主判据）').toBeVisible({ timeout: 3000 })
    // 尾行此时应真的在视野内（不是"还挂着但看不见"）
    const visible = await panel().evaluate((el, txt) => {
      const row = Array.from(el.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent === txt)
      if (!row) return false
      const pr = el.getBoundingClientRect()
      const rr = row.getBoundingClientRect()
      return rr.top >= pr.top - 1 && rr.bottom <= pr.bottom + 1
    }, lastText)
    expect(visible, '滚到底后尾行不在面板视野内').toBe(true)
  })

  test('真滚轮打在面板上：面板保持打开且真的滚了', async () => {
    await openTagDropdown()
    const box = await panel().boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 30)
    await page.mouse.wheel(0, 200)
    await expect(panel(), '滚轮一滚下拉就关（同缺陷的真事件形态，非程序化赋值才说明修到位）').toBeVisible({ timeout: 3000 })
    // 滚轮滚动在 Chromium 里是异步合成的，读完 scrollTop 会是 0——**等它生效**再判（判据本身不放宽）
    await expect
      .poll(() => panel().evaluate((el) => el.scrollTop), { timeout: 5000, message: '滚轮没真的滚面板' })
      .toBeGreaterThan(0)
  })

  test('反向护栏：祖先容器（弹窗主体）滚动仍须关闭——原设计意图不能被修没', async () => {
    await openTagDropdown()
    // 找输入框**真正的**祖先滚动容器：上一版我直接抓 `.dlg-body` / 第一个 overflow-y-auto，
    // 结果那要么不是祖先、要么根本不溢出（弹窗一屏放得下 ⇒ scrollTop 不变 ⇒ 不派发 scroll 事件），
    // 于是这条护栏测的是"我能不能滚到一个不存在的东西"，而不是判据本身。
    const how = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="如：客户、重点"]')
      if (!input) return 'no-input'
      let el: HTMLElement | null = input.parentElement
      while (el) {
        const cs = getComputedStyle(el)
        if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) {
          el.scrollTop = el.scrollTop + 120
          return `scrolled:${el.className}`
        }
        el = el.parentElement
      }
      // 弹窗一屏放得下时没有可滚祖先：直接在该祖先上派发 scroll（判据吃的是事件目标，不是布局）
      const anc = (input.closest('.dlg-body') as HTMLElement | null) ?? (input.parentElement?.parentElement as HTMLElement)
      anc?.dispatchEvent(new Event('scroll', { bubbles: true }))
      return `dispatched:${anc?.className ?? 'none'}`
    })
    console.log('【反向护栏走的是哪条路】', how)
    await expect(panel(), '祖先滚动不再关闭面板 = 面板会飘在错位上（改过头）').toHaveCount(0, { timeout: 3000 })
  })

  test('键盘 ↓ 连按 12 次：高亮行必须一直在视野内（否则"能滚但瞎选"）', async () => {
    await openTagDropdown()
    for (let k = 0; k < 12; k += 1) {
      await tagInputBox().press('ArrowDown')
    }
    await page.waitForTimeout(300)
    const ok = await panel().evaluate((el) => {
      const rows = Array.from(el.querySelectorAll<HTMLElement>('button'))
      // classList.contains 而不是 className.includes：后者会把 `hover:bg-surface-100`
      // 一起认成高亮（第一版就因此抓到第 0 行，误判成"高亮滚出视野"）
      const hl = rows.find((r) => r.classList.contains('bg-surface-100'))
      if (!hl) return { found: false }
      const pr = el.getBoundingClientRect()
      const rr = hl.getBoundingClientRect()
      return { found: true, inView: rr.top >= pr.top - 1 && rr.bottom <= pr.bottom + 1, index: rows.indexOf(hl) }
    })
    expect(ok.found, '找不到高亮行').toBe(true)
    expect(ok.inView, `高亮到第 ${ok.index} 行却滚出视野了 = 键盘选不到尾部标签`).toBe(true)
  })
})
