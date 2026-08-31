import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * v2.5.7 发布轮渲染守卫（L3 渲染零缺陷专项的常驻部分）。
 *
 * 本仓此前**没有任何**视觉/异常守卫（`toHaveScreenshot` 零命中、无 pageerror 断言面），
 * 本版却新增了三块大面渲染（Crepe 编辑器、标签业务域分组、统一表单控件）——
 * 快照基线跨机抖动会造出永久 flaky，故这里只固化两类可长期稳定的断言：
 *   ① 新面遍历期间零未捕获异常（pageerror）与零 console.error（渲染崩溃的硬信号）；
 *   ② 发布日修掉的三处真实缺陷的 UI 级回归守卫（默认落点、旧档标签不隐身、侧边栏笔记库位置）。
 * 布局像素级走查不在此处（由发布轮多分辨率截图走查承担，见 动作-2026-08-31-发布v2.5.7）。
 */
test.describe('v2.5.7 渲染守卫（异常零容忍 + 新面回归）', () => {
  let app: ElectronApplication
  let page: Page
  let pageErrors: string[] = []
  let consoleErrors: string[] = []
  let wsDir = ''

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`)
    })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-render-guard-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      await (window as any).qihebox.productSets.create({ name: '守卫系列A' })
      await (window as any).qihebox.clients.create({ name: '守卫客户' })
    })
    // 旧档场景：磁盘上残留已废除域值（ledger）与未知域值——渲染层不得因此让标签隐身
    await fsp.writeFile(
      path.join(wsDir, '.qihefilemanager', 'tags.json'),
      JSON.stringify({
        _migrated_builtin: { color: '' },
        旧台账标: { color: '#111111', scope: 'ledger' },
        未来域标: { color: '#222222', scope: 'future_domain' },
      }),
    )
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
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
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, url)
  }

  test('新面遍历零未捕获异常与零 console.error', async () => {
    pageErrors = []
    consoleErrors = []
    // 笔记库工作台 / 设置页（标签域分组 + 子文件夹管理）/ 客户详情（文件区 tab）/ 产品集详情 / 发票台账（表单控件）
    for (const route of ['/notes', '/settings', '/clients/守卫客户', '/product-sets/守卫系列A', '/invoices']) {
      await navigateTo(route)
      await expect(page.getByRole('main')).toBeVisible({ timeout: 15000 })
      // 给懒加载路由与异步数据一个落定窗口（异常都在此窗口内抛出）
      await page.waitForTimeout(800)
    }
    expect(pageErrors, `新面遍历期间不得出现未捕获异常：\n${pageErrors.join('\n')}`).toHaveLength(0)
    expect(consoleErrors, `新面遍历期间不得出现 console.error：\n${consoleErrors.join('\n')}`).toHaveLength(0)
  })

  test('客户文件区：「笔记」排最左但默认落点在「报价」（显示顺序≠默认落点）', async () => {
    await navigateTo('/clients/守卫客户')
    await expect(page.getByRole('button', { name: '笔记', exact: true })).toBeVisible({ timeout: 15000 })
    // 子文件夹 tab 条：首个应为内建「笔记」（用户拍板 2026-08-30 显示顺序）
    const tabs = page.locator('button[class*="py-2"][class*="rounded-md"]')
    await expect(tabs.first()).toHaveText('笔记')
    // 选中态（bg-white shadow-sm）必须落在「报价」——发布日缺陷正是默认落点沿用首位而落到笔记
    const active = page.locator('button[class*="shadow-sm"][class*="rounded-md"]')
    await expect(active).toHaveText('报价', { timeout: 15000 })
    // 内建笔记不写进 config（渲染层并集显示，配置文件零污染）
    const folders = await page.evaluate(async () => {
      const cfg = await (window as any).qihebox.config.get()
      return (cfg as { data?: { customer_subfolders?: string[] } }).data?.customer_subfolders ?? []
    })
    expect(folders).not.toContain('笔记')
  })

  test('旧档非法域标签在设置页可见（归全域，不隐身）', async () => {
    await navigateTo('/settings')
    await expect(page.getByText('标签管理')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('旧台账标', { exact: true })).toBeVisible()
    await expect(page.getByText('未来域标', { exact: true })).toBeVisible()
    // 域下拉当前值必须是「全域」（而不是空分组）
    const scopes = await page.evaluate(async () => {
      const r = await (window as any).qihebox.tags.list()
      const list = (r.data ?? []) as { name: string; scope?: string }[]
      return list.filter((t) => t.name === '旧台账标' || t.name === '未来域标').map((t) => t.scope)
    })
    expect(scopes).toEqual(['general', 'general'])
  })

  test('侧边栏「笔记库」入口在「证书库」下方（用户拍板 2026-08-30）', async () => {
    await navigateTo('/')
    const notes = page.getByText('笔记库', { exact: true }).first()
    const cert = page.getByText('证书库', { exact: true }).first()
    await expect(notes).toBeVisible({ timeout: 15000 })
    await expect(cert).toBeVisible()
    const nb = await notes.boundingBox()
    const cb = await cert.boundingBox()
    expect(nb).not.toBeNull()
    expect(cb).not.toBeNull()
    expect(nb!.y).toBeGreaterThan(cb!.y)
  })

  test('Crepe 渲染矩阵与保存往返保真（所见即所得不丢结构）', async () => {
    const md = [
      '# 一级标题',
      '',
      '正文含**加粗**与`行内码`。',
      '',
      '## 二级标题',
      '',
      '- 无序项一',
      '- 无序项二',
      '',
      '1. 有序项一',
      '2. 有序项二',
      '',
      '- [ ] 待办未完成',
      '- [x] 待办已完成',
      '',
      '> 引用段落',
      '',
      '| 列甲 | 列乙 |',
      '| --- | --- |',
      '| 单元1 | 单元2 |',
      '',
      '---',
      '',
      '结束段。',
      '',
    ].join('\n')
    const noteDir = path.join(wsDir, '产品集', '守卫系列A', '文档', '笔记')
    await fsp.mkdir(noteDir, { recursive: true })
    const noteFile = path.join(noteDir, '渲染矩阵.md')
    await fsp.writeFile(noteFile, md)

    pageErrors = []
    consoleErrors = []
    // 深链直达编辑态（/files/doc/<集>/笔记?note=<文件>，Notes.tsx 同款路由）
    await navigateTo(`/files/doc/${encodeURIComponent('守卫系列A')}/笔记?note=${encodeURIComponent('渲染矩阵.md')}`)
    const editor = page.locator('.ProseMirror').first()
    await expect(editor).toBeVisible({ timeout: 20000 })

    // 渲染侧：各结构真的成了对应元素（Crepe 的 list-item 用 node-view 包裹 li，故不能用 `ul > li` 直接子选择器）
    await expect(editor.locator('h1')).toHaveText(/一级标题/)
    await expect(editor.locator('h2')).toHaveText(/二级标题/)
    await expect(editor.locator('strong')).toHaveText('加粗')
    await expect(editor.locator('code')).toContainText('行内码')
    expect(await editor.locator('ul li').count()).toBeGreaterThanOrEqual(4) // 无序 2 + 任务 2
    expect(await editor.locator('ol li').count()).toBeGreaterThanOrEqual(2)
    await expect(editor.locator('blockquote')).toContainText('引用段落')
    expect(await editor.locator('table th').count()).toBeGreaterThanOrEqual(2)
    expect(await editor.locator('table td').count()).toBeGreaterThanOrEqual(2)
    expect(await editor.locator('hr').count()).toBeGreaterThanOrEqual(1)
    // 任务列表两态都渲染出文本来（Crepe 用自绘 label，不用原生 input[type=checkbox]——见缺陷台账 P2）
    const liTexts = await editor.locator('li').allTextContents()
    expect(liTexts.join('|')).toContain('待办未完成')
    expect(liTexts.join('|')).toContain('待办已完成')

    // 保存侧：Ctrl+S 立即保存后，磁盘上的 md 仍保有全部结构（往返不丢语义）
    await editor.click()
    await page.keyboard.press('Control+s')
    await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 10000 })
    const back = await fsp.readFile(noteFile, 'utf-8')
    // Crepe 序列化会做 CommonMark 规范化（列表符号 `-` → `*`、表格列宽补空格），语义不丢；
    // 故断言按「标记无关」的结构匹配，并显式钉住规范化事实（对外文档口径见动作记录）。
    for (const re of [
      /^# 一级标题$/m,
      /^## 二级标题$/m,
      /\*\*加粗\*\*/,
      /`行内码`/,
      /^[-*] 无序项一$/m,
      /^[-*] 无序项二$/m,
      /^1\. 有序项一$/m,
      /^2\. 有序项二$/m,
      /^[-*] \[ \] 待办未完成$/m,
      /^[-*] \[[xX]\] 待办已完成$/m,
      /^> 引用段落$/m,
      /结束段。/,
    ]) {
      expect(back, `保存后丢失结构 ${re}；实际内容：\n${back}`).toMatch(re)
    }
    // 表格与分割线：列名/单元与水平线都须仍在
    expect(back).toMatch(/列甲[\s\S]*列乙/)
    expect(back).toMatch(/单元1[\s\S]*单元2/)
    expect(back).toMatch(/(^|\n)(---|\*\*\*)(\s|$)/)

    expect(pageErrors, `编辑与保存期间不得出现未捕获异常：\n${pageErrors.join('\n')}`).toHaveLength(0)
    expect(consoleErrors, `编辑与保存期间不得出现 console.error：\n${consoleErrors.join('\n')}`).toHaveLength(0)
  })

  test('关闭笔记编辑器后 Crepe 真卸载（DOM 移除 + 节点数回落，红线：订阅必 dispose）', async () => {
    const noteDir = path.join(wsDir, '产品集', '守卫系列A', '文档', '笔记')
    await fsp.mkdir(noteDir, { recursive: true })
    const noteFile = path.join(noteDir, '卸载探针.md')
    await fsp.writeFile(noteFile, ['# 卸载探针', '', '- 项一', '- 项二', '', '正文段落用于撑出编辑区结构。', ''].join('\n'))

    // 基线：同一文件所在文件夹视图（未开编辑器）
    await navigateTo(`/files/doc/${encodeURIComponent('守卫系列A')}/笔记`)
    await expect(page.getByText('卸载探针.md')).toBeVisible({ timeout: 15000 })
    const nodesBefore = await page.evaluate(() => document.getElementsByTagName('*').length)
    expect(await page.locator('.ProseMirror').count()).toBe(0)

    // 开编辑器（深链）→ Crepe 挂载，节点数必须显著上升（证明这一步真的在测编辑器，不是空转）
    await navigateTo(`/files/doc/${encodeURIComponent('守卫系列A')}/笔记?note=${encodeURIComponent('卸载探针.md')}`)
    const editor = page.locator('.ProseMirror').first()
    await expect(editor).toBeVisible({ timeout: 20000 })
    const nodesOpen = await page.evaluate(() => document.getElementsByTagName('*').length)
    expect(nodesOpen).toBeGreaterThan(nodesBefore + 50)

    // 关闭预览（Escape = FilePreviewModal 既有语义，md-preview.spec 同款）
    await page.keyboard.press('Escape')
    await expect(page.locator('.ProseMirror')).toHaveCount(0, { timeout: 10000 })

    // 卸载判据：DOM 节点必须回落到「打开前 + 懒加载模块常驻」量级（阈值 100，远大于一次性模块缓存抖动、
    // 远小于一整棵编辑器 DOM 常驻）；连续开关 3 次后仍须保持，排除逐轮累积。
    let nodesAfter = await page.evaluate(() => document.getElementsByTagName('*').length)
    expect(
      nodesAfter,
      `关闭后 DOM 未回落（开前 ${nodesBefore} / 开中 ${nodesOpen} / 关后 ${nodesAfter}）——编辑器或其在建监听未随卸载释放`,
    ).toBeLessThanOrEqual(nodesBefore + 100)

    for (let i = 0; i < 3; i++) {
      await navigateTo(`/files/doc/${encodeURIComponent('守卫系列A')}/笔记?note=${encodeURIComponent('卸载探针.md')}`)
      await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20000 })
      await page.keyboard.press('Escape')
      await expect(page.locator('.ProseMirror')).toHaveCount(0, { timeout: 10000 })
      nodesAfter = await page.evaluate(() => document.getElementsByTagName('*').length)
    }
    expect(
      nodesAfter,
      `反复开关 3 次后 DOM 累积（开前 ${nodesBefore} / 末次关后 ${nodesAfter}）——每次挂载都有残留`,
    ).toBeLessThanOrEqual(nodesBefore + 150)
  })

  test('任务列表可访问性（D-08）：role=checkbox + 键盘勾选走编辑器事务并落盘', async () => {
    const noteDir = path.join(wsDir, '产品集', '守卫系列A', '文档', '笔记')
    await fsp.mkdir(noteDir, { recursive: true })
    const noteFile = path.join(noteDir, '任务项.md')
    await fsp.writeFile(noteFile, ['# 任务', '', '- [ ] 未完成任务甲', '- [x] 已完成任务乙', '', ''].join('\n'))
    await navigateTo(`/files/doc/${encodeURIComponent('守卫系列A')}/笔记?note=${encodeURIComponent('任务项.md')}`)
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 20000 })

    const wrappers = page.locator('.milkdown-list-item-block .label-wrapper')
    await expect(wrappers).toHaveCount(2, { timeout: 10000 })
    // ① 每个任务项都是可聚焦的 checkbox 语义（读屏拿得到状态）
    const roles = await page.evaluate(() => {
      const ws = Array.from(document.querySelectorAll<HTMLElement>('.milkdown-list-item-block .label-wrapper'))
      return ws.map((w) => ({
        role: w.getAttribute('role'),
        checked: w.getAttribute('aria-checked'),
        tabindex: w.getAttribute('tabindex'),
        label: w.getAttribute('aria-label') ?? '',
      }))
    })
    expect(roles).toHaveLength(2)
    for (const r of roles) {
      expect(r.role, '每个任务项必须有 role=checkbox').toBe('checkbox')
      expect(r.tabindex, '任务项必须可聚焦（tabindex=0）').toBe('0')
      expect(r.label, '任务项须有可读名称').toContain('任务')
    }
    expect(roles.map((r) => r.checked).sort(), '两个任务项状态一真一假').toEqual(['false', 'true'])

    // ② 键盘勾选：聚焦未完成项 → 空格 → 走 PM 事务（aria 翻转）
    await wrappers.nth(0).press(' ')
    await expect(wrappers.nth(0)).toHaveAttribute('aria-checked', 'true', { timeout: 5000 })

    // ③ 鼠标勾选仍可用（原 pointerdown 交互不被破坏）
    await wrappers.nth(1).click()
    await expect(wrappers.nth(1)).toHaveAttribute('aria-checked', 'false', { timeout: 5000 })

    // ④ 两处修改都经 markdownUpdated 落盘（Ctrl+S 立即保存）
    await page.keyboard.press('Control+s')
    await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 10000 })
    const back = await fsp.readFile(noteFile, 'utf-8')
    expect(back, `键盘勾选未落盘；实际内容：\n${back}`).toMatch(/^[-*] \[[xX]\] 未完成任务甲$/m)
    expect(back, `鼠标勾选未落盘；实际内容：\n${back}`).toMatch(/^[-*] \[ \] 已完成任务乙$/m)

    expect(pageErrors, `任务项操作期间不得出现未捕获异常：\n${pageErrors.join('\n')}`).toHaveLength(0)
    expect(consoleErrors, `任务项操作期间不得出现 console.error：\n${consoleErrors.join('\n')}`).toHaveLength(0)
  })
})
