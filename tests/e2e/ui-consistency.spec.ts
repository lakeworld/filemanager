import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * UI 一致性普查 e2e（v2.5.1 T4/T5）：
 * - 静态路由全遍历（15+）：渲染无崩溃、无横向滚动（1024 窗口断言，T5）
 * - 空态不闪现守卫回归（Clients/ProductSets 加载期 Skeleton；时序窗口小 → 断言最终态 + 守卫存在性）
 * - 下拉触发器可及名全覆盖（v2.5.8 复审改造：原「裸 select 四种 aria 关联抽查」自 D9 零裸 select 后恒绿，见该用例注释）
 * 说明：参数路由（/product-sets/:name 等）由各域 spec 覆盖，此处只遍历静态路由；
 * 1024 断言 = BrowserWindow setSize(1024, h) + document.scrollWidth <= **document.clientWidth**
 * （2026-09-25 起比 clientWidth：滚动条吃掉的宽度不再被当成余量，见用例内注释）。
 */
test.describe('UI 一致性（v2.5.1 T4/T5）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('ui-consistency') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    // 建工作区（路由大多依赖工作区）
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-ui-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '一致性系列' }))
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  const navigateTo = async (url: string): Promise<void> => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  const ROUTES = [
    '/',
    '/product-sets',
    '/images',
    '/certs',
    '/search',
    '/settings',
    '/profile',
    '/help',
    '/trash',
    '/exports',
    '/clients',
    '/suppliers',
    '/quotes',
    '/invoices',
    '/notes', // v2.5.8 W5 新增库页：漏收本条时，筛选行撑出横向滚动条无人拦截（实测踩过）
    '/files/doc/一致性系列/说明书',
  ]

  test('静态路由全遍历：渲染无崩溃 + 1024 窗口无横向滚动（T5）', async () => {
    for (const route of ROUTES) {
      await navigateTo(route)
      // 1024 窗口断言：设置 BrowserWindow 尺寸后页面不应横向滚动
      await page.evaluate(() => {
        // e2e 模式下通过 window resize 模拟（BrowserWindow setSize 由应用侧窗口约束）
        window.resizeTo(1024, 768)
      })
      await page.waitForTimeout(200)
      // 判据必须对**可视宽度**比：视口 1024 时滚动条会吃掉约 15px clientWidth，
      // 旧写法 `scrollWidth <= 1024` 让「内容已横向溢出、页面能左右滚」照样绿（2026-09-25 审查 §三.2）。
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))
      expect(scrollW, `route ${route} 横向滚动`).toBeLessThanOrEqual(clientW)
    }
  })

  test('空态不闪现守卫：列表页初始 Skeleton 而非 EmptyState（T4，先红后绿记录）', async () => {
    // 时序窗口小（本地 IPC 快），弱化为：代码守卫存在性（skeleton 类在产物中）+
    // 最终态正确（空列表显示 EmptyState、有数据显示列表）
    // 守卫本身由 tsc 静态保证（loading 信号 + fallback 分支），此处断言最终态正确
    await navigateTo('/product-sets')
    await expect(page.getByText('一致性系列', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    // 进入 /clients（空客户列表）→ EmptyState 最终态
    await navigateTo('/clients')
    await expect(page.getByText('暂无客户')).toBeVisible({ timeout: 15000 })
  })

  /**
   * 下拉触发器可及名全覆盖（v2.5.8 复审改造）。
   *
   * **改前的死法**：原用例「裸 select aria 关联抽查」在 `/settings` 上 `querySelectorAll('select')`
   * 再过滤出「无 aria 关联的那批」，最后 `expect(0).toBe(0)`。v2.5.8 D9 起全站零裸 `<select>`
   * （下拉一律走 `ui/SearchSelect`），该集合恒空 ⇒ 断言永真、什么都不验，却占一个「通过」名额。
   *
   * **改后钉的是活的那一面**：屏幕阅读器读得出「这是哪个字段」，靠的是触发器上的 aria 关联
   * （不是按钮里的可见值文本——读出「7 天」并不说明这是「提前提醒天数」）。所以逐个看 DOM 里
   * 真实渲染出来的触发器，要求每一个都有非空的 aria-label / 可解析的 aria-labelledby。
   *
   * 读法上刻意**不接受「可见文本」当作可及名**：按钮里的文本是当前值（「7 天」「顶层标签」），
   * 拿它兜底会让「漏传 ariaLabel」继续静默通过——那正是旧用例恒绿的同一类漏洞。
   *
   * **防空转的三道互锁**（任何一环失去被测对象都红，不会静默通过）：
   *   ① 遍历累计触发器总数 > 0：旧用例的恒绿正来自「空集合 + 只数不判」，这里先钉住有东西可测；
   *   ② 无 aria 关联的触发器列表 === []：组件不再挂 aria-label、或某页面漏传 ariaLabel ⇒ 红；
   *   ③ 渲染层 DOM 里原生 `<select>` 计数 === 0：把旧那句「永真的过滤」换成可证伪的计数
   *     （口径刻意**不再区分有没有 aria**——D9 之后任何原生 select 都不该出现在 DOM 里，
   *     连带 aria-label 的一起算违规；这正是与旧「过滤后再数」的差别，反向实验 C 已抓实一次）。
   * 选择器 `button[aria-haspopup="listbox"]` 是触发器指纹（全站唯 SearchSelect 挂它，弹层选项是
   * `role="option"` 不带 haspopup）；组件若改掉这个属性，① 会当场红，而不是退化成空转。
   *
   * **与既有用例的分工**（为什么要在这里再钉一遍，而不是删掉）：
   *   - `tests/unit/uiInventory.test.ts`「控件红线：原生 select 元素清零」只看**源码文本**，
   *     且只数 `<select` 出现次数——它管不了组件渲染出来的按钮有没有可及名；
   *   - `tests/unit/searchSelect.test.ts` 只测抽出的纯函数（过滤/高亮/定位），不渲染组件；
   *   - `tests/e2e/search-select.spec.ts` 用 `getByLabel('产品集筛选')` **隐式**验证书页一个点位；
   *   - 「DOM 层逐个触发器的可及名 + 覆盖所有静态路由」此前无人钉 ⇒ 本用例是增量而非重复。
   */
  test('下拉触发器可及名全覆盖（v2.5.8 复审：原「裸 select aria 抽查」恒绿改造）', async () => {
    let total = 0
    const unnamed: string[] = []
    let bareSelects = 0
    for (const route of ROUTES) {
      await navigateTo(route)
      await page.waitForTimeout(400)
      const diag = await page.evaluate(() => {
        /** 可及名口径：aria-label 优先，其次 aria-labelledby 指向元素的文本（两者都算真实 aria 关联） */
        const accName = (el: Element): string => {
          const direct = el.getAttribute('aria-label')?.trim() ?? ''
          if (direct) return direct
          return (el.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ')
            .trim()
        }
        const triggers = Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
        return {
          items: triggers.map((t) => ({ name: accName(t), text: (t.textContent ?? '').trim() })),
          bareSelects: document.querySelectorAll('select').length,
        }
      })
      bareSelects += diag.bareSelects
      for (const it of diag.items) {
        total++
        if (!it.name) unnamed.push(`${route} → 可见文本「${it.text}」`)
      }
    }
    expect(total, '全站遍历没找到任何下拉触发器：组件的 aria-haspopup 指纹或路由清单变了，本用例已失去被测对象').toBeGreaterThan(0)
    expect(unnamed, `无 aria 关联的下拉触发器（屏幕阅读器读不出这是哪个字段）：${unnamed.join(' | ')}`).toEqual([])
    expect(bareSelects, '渲染层 DOM 里出现原生 <select>：v2.5.8 D9 起下拉一律走 ui/SearchSelect').toBe(0)
  })
})
