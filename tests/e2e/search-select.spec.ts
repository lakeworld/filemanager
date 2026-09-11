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
 * SearchSelect（搜索下拉）e2e（v2.5.8 W4 提前投产，PLAN §三 W4 验收项）。
 *
 * 载体选证书库页面：它和笔记库是本组件的首批使用者，且证书页天然有「多产品集 + 子文件夹 + 标签 + 排序」
 * 四族下拉，能同时验到两件事——
 *   ① 组件本体：>5 项出搜索框、输入即过滤、无匹配空态、选中回填、Esc 走层栈关闭；
 *   ② 页面接线：筛选值真的作用于列表计数（不是只改了显示）。
 * ≤5 项自动隐藏搜索框的分支由单测覆盖（tests/unit/searchSelect.test.ts），此处不重复。
 */
test.describe('SearchSelect 与证书库筛选（v2.5.8）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('search-select') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => { window.location.hash = decodeURIComponent(u) }, url)
  }

  /** 建 7 个产品集（>5 ⇒ 触发搜索框）；系列3 放 2 张证书、系列1 放 1 张（其中一张带 10 天后到期） */
  const setup = async (): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-ss-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    for (let i = 1; i <= 7; i++) {
      await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), `系列${i}`)
    }
    const put = async (ps: string, sub: string, file: string) => {
      const dir = path.join(wsDir, '产品集', ps, '证书', sub)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, file), '%PDF-1.4\n% e2e fixture\n')
      return path.join(dir, file)
    }
    const c1 = await put('系列3', '3C', '甲证书.pdf')
    await put('系列3', '3C', '乙证书.pdf')
    const c2 = await put('系列1', '质检', '丙报告.pdf')
    // 到期日：甲 +10 天（≤30 ⇒ urgent 红徽标）、丙 +90 天（非 urgent）
    const plus = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    await page.evaluate(async (a) => (window as any).qihebox.metadata.update({ file_path: a.p, expiry_date: a.d }), { p: c1, d: plus(10) })
    await page.evaluate(async (a) => (window as any).qihebox.metadata.update({ file_path: a.p, expiry_date: a.d }), { p: c2, d: plus(90) })
    return wsDir
  }

  test('搜索过滤 → 选中 → 值与列表计数都正确；无匹配出空态；Esc 关闭弹层', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/certs')
      await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 20000 })
      // 三个文件全在（网格卡数 = 列表口径）
      await expect(page.getByText('3 个文件')).toBeVisible({ timeout: 20000 })

      const trigger = page.getByLabel('产品集筛选')
      await trigger.click()
      const panel = page.locator('[data-search-select]')
      await expect(panel).toBeVisible({ timeout: 5000 })
      // >5 项 ⇒ 搜索框在位
      const input = panel.locator('[data-search-input]')
      await expect(input).toBeVisible()

      await input.fill('系列3')
      // 只剩命中项（「全部产品集」不含该子串，应被滤掉）
      await expect(panel.locator('[role="option"]')).toHaveCount(1)
      await panel.locator('[data-option="系列3"]').click()

      // ① 触发器回填选中值 ② 筛选真的作用到列表
      await expect(trigger).toContainText('系列3')
      await expect(panel).toHaveCount(0)
      await expect(page.getByText('2 个文件')).toBeVisible({ timeout: 10000 })

      // 无匹配 → 空态（不回全量）
      await trigger.click()
      await page.locator('[data-search-select] [data-search-input]').fill('zzz不存在')
      await expect(page.getByText('无匹配结果')).toBeVisible()
      // Esc 关闭（层栈语义）
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-search-select]')).toHaveCount(0)
      // 关闭后筛选值不变（Esc 只关弹层，不吞掉已选值）
      await expect(trigger).toContainText('系列3')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('面板内滚动不自杀；点空白处仍正常关闭', async () => {
    // 回归由来：捕获阶段的「滚动即关」会收到全站任意滚动容器的事件。实测两处误关——
    // 选项 >7 条时翻页关自己、搜索框 focus 触发 overflow-hidden 外壳 scroll-into-view 关自己
    // （后者表现为 fill 偶发性让整层消失，即本 spec 第 99 行的那条竞态失败）。
    const wsDir = await setup()
    try {
      // 再多建 5 个产品集（共 13 项可滚）——必须在导航前建，产品集 store 只在页面挂载时拉一次。
      // 之后先确认列表**真的溢出**才滚：不溢出则 scrollTop 设不上去、事件不发，
      // 用例会退化成空转（第一版就是这么假绿的，靠变异测试才抓出来）。
      for (let i = 8; i <= 12; i++) {
        await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), `系列${i}`)
      }
      await navigateTo('/certs')
      await expect(page.getByText('3 个文件')).toBeVisible({ timeout: 20000 })
      await page.getByLabel('产品集筛选').click()
      const panel = page.locator('[data-search-select]')
      await expect(panel).toBeVisible()
      const list = panel.locator('.vscroll')
      await expect
        .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 5000 })
        .toBeGreaterThan(20)
      await list.evaluate((el) => {
        el.scrollTop = 40
      })
      await expect(panel).toBeVisible({ timeout: 2000 })
      await expect(panel.locator('[role="option"]').first()).toBeVisible()
      // 点面板与触发器之外的空白处 ⇒ 该关还得关
      await page.mouse.click(6, 6)
      await expect(panel).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('证书库信息封面卡：图片/PDF 分档 + 到期徽标随筛选可见', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/certs')
      await expect(page.getByText('3 个文件')).toBeVisible({ timeout: 20000 })
      // 首载不得有残留选中态（多选条不该在没有一次点击的情况下出现——排查白屏探针时见过可疑痕迹，此处钉死）
      await expect(page.getByText(/已选择 \d+ 个文件/)).toHaveCount(0)
      // 徽标文案口径（expiryInfo：剩余天数 / 已过期），urgent（≤30 天）出红档
      await expect(page.getByText(/剩 \d+ 天/).first()).toBeVisible({ timeout: 20000 })
      // 封面卡形态：三张 PDF 证书都出扩展名字标（信息封面档，不是缩略图档）
      await expect(page.getByText('PDF', { exact: true })).toHaveCount(3)
      // 子文件夹筛选（≤5 项 ⇒ 无搜索框，走自动隐藏分支的页面侧表现）
      await page.getByLabel('子文件夹筛选').click()
      await expect(page.locator('[data-search-select] [data-search-input]')).toHaveCount(0)
      await page.locator('[data-search-select] [data-option="质检"]').click()
      await expect(page.getByText('1 个文件')).toBeVisible({ timeout: 10000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
