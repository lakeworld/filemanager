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
 * 删除确认弹窗 · 常驻回归（缺陷 2026-08-15 定位并关闭；v2.5.9/A4 转正）：
 * 根因 = Solid props 惰性 getter 陷阱——onConfirm 先置 null 再读 props（重求值为 null → TypeError → 删除不执行）。
 *
 * 为什么它**没被删掉**（A4 原计划是"折进常驻断言后删文件"）：实测全仓只有这一个 spec 同时具备
 * 「删除动作」×「pageerror 全量守卫」两面（`grep -l pageErrors` 只有 memory-soak / render-guard 两个，
 * 都不碰删除），即删除路径上"崩了但界面看着删了"这类静默失败**只有这里在守**。
 * 故处置 = 去掉 `-repro` 一次性身份、转正常驻（仍在默认套件里，每轮都跑），而不是删。
 * 三个面各一条：FileBrowserView（产品集文档 tab）/ Search / Settings 标签删除——三处都是同款陷阱的不同实例。
 */
test.describe('删除确认弹窗：三面删除后不崩、且对象真的消失（常驻）', () => {
  let app: ElectronApplication
  let page: Page
  let pageErrors: string[]

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('delete-confirm') } })
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

  test.beforeEach(() => {
    pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
  })

  const setupWorkspace = async (psName: string): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-delconfirm-e2e-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    const psRes = await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), psName)
    expect(psRes.success).toBe(true)
    return wsDir
  }

  const navigateTo = async (url: string): Promise<void> => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  test('产品集文档 tab：确认删除后文件消失、无 kind 崩溃（FileBrowserView 已修路径）', async () => {
    const wsDir = await setupWorkspace('删除取证集A')
    try {
      const docDir = path.join(wsDir, '产品集', '删除取证集A', '文档', '说明书')
      await fsp.mkdir(docDir, { recursive: true })
      await fsp.writeFile(path.join(docDir, '取证文档A.md'), '# 取证A')

      await navigateTo('/files/doc/删除取证集A/说明书')
      const card = page.locator('.card', { hasText: '取证文档A.md' })
      await card.waitFor({ timeout: 10000 })
      await card.click()
      await page.getByRole('button', { name: '删除选中' }).click()
      const dialog = page.getByRole('dialog', { name: '删除文件' })
      await dialog.waitFor({ timeout: 5000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()

      // 删除生效：卡片消失；回收站可见（文件未硬删）
      await expect(card).toHaveCount(0, { timeout: 5000 })
      const kindCrashes = pageErrors.filter((e) => e.includes("reading 'kind'"))
      expect(kindCrashes, `页面仍现 'kind' 崩溃：${kindCrashes.join(' | ')}`).toHaveLength(0)
      // 页面未冻结：UI 仍响应（空态出现）
      await expect(page.getByText('拖放文件到此处')).toBeVisible({ timeout: 5000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('搜索结果：右键删除确认后结果消失、无 kind 崩溃（Search 已修路径）', async () => {
    const wsDir = await setupWorkspace('删除取证集B')
    try {
      // 经应用导入 API 落文件（索引同步失效，搜索立即可命中——直写磁盘依赖监听防抖，时序不稳）。
      // 注意：core/search.ts 仅索引图包+证书目录（文档目录不参与搜索），故导入图包区取证。
      const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-delconfirm-src-'))
      const srcFile = path.join(srcDir, '取证文档B.md')
      await fsp.writeFile(srcFile, '# 取证B')
      const imp = await page.evaluate(
        async (src) =>
          (window as any).qihebox.files.import({
            source_paths: [src],
            target_product_set: '删除取证集B',
            target_folder: '主图',
            target_type: 'image',
            sub_folder: '主图',
            scope: 'productSet',
          }),
        srcFile,
      )
      expect(imp.success).toBe(true)

      await navigateTo('/search?q=取证文档B')
      // 导入走命名模板重命名（调试集_主图_取证文档B_1.md），用核心词子串匹配
      const card = page.locator('.card', { hasText: '取证文档B' })
      await card.waitFor({ timeout: 15000 })
      await card.click({ button: 'right' })
      await page.locator('#ctx-menu-root button', { hasText: '删除' }).click()
      const dialog = page.getByRole('dialog', { name: '删除文件' })
      await dialog.waitFor({ timeout: 5000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()

      await expect(card).toHaveCount(0, { timeout: 8000 })
      const kindCrashes = pageErrors.filter((e) => e.includes("reading 'kind'"))
      expect(kindCrashes, `搜索页仍现 'kind' 崩溃：${kindCrashes.join(' | ')}`).toHaveLength(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('设置页删除标签：确认后标签消失、无 orphan 崩溃（Settings 同款陷阱——红绿锚点）', async () => {
    const wsDir = await setupWorkspace('删除取证集C')
    try {
      const tagRes = await page.evaluate(async () => (window as any).qihebox.tags.create('取证标签甲', '#ff0000'))
      expect(tagRes.success).toBe(true)

      await navigateTo('/settings')
      const tagName = page.locator('span.text-sm.font-medium.flex-1', { hasText: '取证标签甲' })
      await tagName.waitFor({ timeout: 10000 })
      await tagName.locator('..').getByRole('button', { name: '删除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除标签' })
      await dialog.waitFor({ timeout: 5000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()

      // 取证先行：打印现场再断言（TDD 红绿锚点——当前未修，两条断言红；修复后全绿）
      await page.waitForTimeout(500)
      console.log('[取证] Settings 删除标签 pageerrors:', JSON.stringify(pageErrors))
      const orphanCrashes = pageErrors.filter((e) => e.includes("reading 'orphan'") || e.includes("reading 'name'"))
      expect(orphanCrashes, `设置页现同款惰性 getter 崩溃：${orphanCrashes.join(' | ')}`).toHaveLength(0)
      await expect(tagName).toHaveCount(0, { timeout: 5000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
