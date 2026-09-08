import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { extractZip } from '../../src/main/core/archive'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 笔记工作台 + 整包压缩勾选 e2e（v2.5.7 A2）：
 * - 三域「笔记」子文件夹出现且删除钮隐藏
 * - /notes 工作台聚合（三域最近笔记）+ 点击行深链跳文件区并开编辑
 * - 新建笔记（选归属）→ 落盘 → 开编辑
 * - 整包压缩：无笔记不出现勾选；有笔记出现（默认不勾）→ zip 不含笔记；勾选 → zip 含笔记
 */
test.describe('笔记工作台与整包勾选（v2.5.7 A2）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('notes-workbench') } })
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
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  const setup = async (): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-noteslib-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '系列A' }))
    // 产品集文档区笔记 + 客户笔记
    const psNoteDir = path.join(wsDir, '产品集', '系列A', '文档', '笔记')
    await fsp.mkdir(psNoteDir, { recursive: true })
    await fsp.writeFile(path.join(psNoteDir, '产品纪事.md'), '# 产品纪事\n\n正文')
    const custDir = path.join(wsDir, '客户')
    await fsp.mkdir(path.join(custDir, '张三', '笔记'), { recursive: true })
    await fsp.writeFile(path.join(custDir, '张三', '笔记', '拜访纪要.md'), '# 拜访纪要\n\n客户沟通')
    return wsDir
  }

  test('文档区「笔记」子文件夹出现且删除钮隐藏', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/files/doc/系列A/文档')
      // 精确匹配文档区 tab 按钮（侧边栏「📝 笔记」不参与）
      await expect(page.getByRole('button', { name: '笔记', exact: true })).toBeVisible({ timeout: 15000 })
      await page.getByRole('button', { name: '笔记', exact: true }).click()
      // 删除当前类型按钮隐藏（内建不可删）
      await expect(page.getByRole('button', { name: /删除当前文档类型/ })).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('/notes 笔记库：三域聚合 + 双击卡片开编辑器（v2.5.8 库页化）', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/notes')
      await expect(page.getByRole('heading', { name: '笔记库' })).toBeVisible({ timeout: 20000 })
      await expect(page.locator('[data-note-card]').filter({ hasText: '产品纪事' })).toBeVisible({ timeout: 20000 })
      await expect(page.locator('[data-note-card]').filter({ hasText: '拜访纪要' })).toBeVisible({ timeout: 20000 })
      // 库页交互模型与图包/证书一致：单击 = 选择，双击 = 打开（md → 预览弹窗内嵌 NoteEditorModal）
      await page.locator('[data-note-card]').filter({ hasText: '产品纪事' }).click()
      await expect(page.getByText('已选择 1 篇笔记')).toBeVisible({ timeout: 5000 })
      await page.locator('[data-note-card]').filter({ hasText: '产品纪事' }).dblclick()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('[data-note-editor] [contenteditable="true"]')).toContainText('产品纪事', { timeout: 20000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('/notes 笔记库：搜索与归属域筛选（对标其他库的筛选行）', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/notes')
      await expect(page.locator('[data-note-card]')).toHaveCount(2, { timeout: 20000 })
      // 关键词搜索：命中标题
      await page.getByPlaceholder('搜索标题或归属…').fill('拜访')
      await expect(page.locator('[data-note-card]')).toHaveCount(1)
      await expect(page.locator('[data-note-card]').filter({ hasText: '拜访纪要' })).toBeVisible()
      await page.getByPlaceholder('搜索标题或归属…').fill('')
      // 归属域筛选：只看客户 → 只剩拜访纪要（产品集那条被滤掉）
      await page.getByLabel('归属域筛选').click()
      await page.locator('[data-search-select] [data-option="customer"]').click()
      await expect(page.locator('[data-note-card]')).toHaveCount(1)
      // 计数行随筛选结果变化（全选当前结果只作用于筛出的集合）
      await expect(page.getByText('1 篇笔记')).toBeVisible()
      await page.getByRole('button', { name: '全选当前结果' }).click()
      await expect(page.getByText('已选择 1 篇笔记')).toBeVisible()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('/notes 笔记库：右键「在文件区中打开」保留 v2.5.7 深链链路', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/notes')
      const card = page.locator('[data-note-card]').filter({ hasText: '拜访纪要' })
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.click({ button: 'right' })
      await page.getByText('在文件区中打开').click()
      // 跳到客户文件区的「笔记」子文件夹并直开编辑器（?note= 深链，与 v2.5.7 同一条链路）
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      expect(page.url()).toContain('/files/customer/')
      expect(decodeURIComponent(page.url())).toContain('笔记')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('新建笔记（归属取正式实体列表）→ 落盘 → 开编辑', async () => {
    const wsDir = await setup()
    try {
      // 供应商归属——实体目录须先存在（v2.5.8：归属下拉取 suppliers 正式列表，
      // 不再是「从已有笔记反推」的可手输 datalist；先建目录再挂载页面才进得了候选）
      const spDir = path.join(wsDir, '供应商', '李四', '笔记')
      await fsp.mkdir(spDir, { recursive: true })
      await navigateTo('/notes')
      await expect(page.locator('[data-note-card]').filter({ hasText: '产品纪事' })).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: /新建笔记/ }).click()
      // kind 选择按钮在弹窗内（精确匹配，避开侧边栏/列表）
      await page.locator('.p-6').getByRole('button', { name: '供应商', exact: true }).click()
      // 归属实体 = SearchSelect（点触发器 → 点选项），替代旧的手输 input + datalist
      // 精确匹配：筛选行还有一个「归属实体筛选」，用包含匹配会同时命中两个 aria-label
      await page.getByLabel('归属实体', { exact: true }).click()
      await page.locator('[data-search-select] [data-option="李四"]').click()
      const titleInput = page.locator('input[placeholder="笔记标题（保存为 .md）"]')
      await titleInput.fill('采购备忘')
      await page.getByRole('button', { name: /创建并编辑/ }).click()
      // 直开编辑器（站内预览弹窗内嵌）
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      // 落盘
      await page.waitForTimeout(1500)
      expect(await fsp.stat(path.join(spDir, '采购备忘.md')).then((s) => s.size).catch(() => 0)).toBeGreaterThan(0)
      // 工作台刷新后可见
      await navigateTo('/notes')
      await expect(page.locator('[data-note-card]').filter({ hasText: '采购备忘' })).toBeVisible({ timeout: 20000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  /** 解压 zip（Node 侧直呼 core extractZip，避开 UI 内 async 竞态）并递归列出目标目录文件 */
  const unzipList = async (zipPath: string): Promise<string[]> => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-noteslib-unzip-'))
    await fsp.mkdir(path.join(tmp, 'out'), { recursive: true })
    await extractZip(zipPath, path.join(tmp, 'out'))
    const acc: string[] = []
    const collect = async (dir: string, base: string) => {
      let es: string[] = []
      try {
        es = await fsp.readdir(dir)
      } catch {
        return
      }
      for (const e of es) {
        const full = path.join(dir, e)
        const st = await fsp.stat(full).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) await collect(full, `${base}/${e}`)
        else acc.push(`${base}/${e}`)
      }
    }
    await collect(path.join(tmp, 'out'), '')
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    return acc
  }

  /** UI 点「打包此图包」→ 处理确认勾选 → 等待 archive:complete 事件。返回是否点击了勾选（随包附带笔记） */
  const compressViaUi = async (checkInclude: boolean): Promise<{ success: boolean; resultPath?: string }> => {
    const done = page.evaluate(
      () =>
        new Promise<unknown>((resolve) => {
          const off = (window as any).qihebox.events.on("archive:complete", (d: unknown) => {
            const p = d as { success?: boolean; result?: { path?: string } }
            // 只收「压缩成功」事件（unzipList 的 extract 也会发 complete——按 .zip 结果路径区分）
            if (p.success && p.result?.path?.endsWith?.(".zip")) {
              off();
              resolve(d);
            }
          });
          setTimeout(() => {
            off();
            resolve({ success: false, error: "e2e 等待 archive:complete 超时" });
          }, 20000);
        }),
    );
    await page.getByRole("button", { name: /打包此图包/ }).first().click()
    await expect(page.getByText("随包附带笔记")).toBeVisible({ timeout: 10000 })
    if (checkInclude) {
      await page.locator('[data-testid="compress-include-notes"]').check()
    }
    await page.getByRole("button", { name: "打包", exact: true }).click()
    const d = (await done) as { success: boolean; result?: { path: string }; error?: string }
    // 关闭成功态进度弹窗（点「关闭」按钮——Esc 可能被 layerStack 拦截）
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await expect(page.locator(".modal-overlay")).toHaveCount(0, { timeout: 10000 })
    return { success: d.success, resultPath: d.result?.path }
  }

  test('整包压缩勾选：有笔记出现（默认不勾）→ 不带笔记；勾选 → 带笔记', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/product-sets/系列A')
      await expect(page.getByText('打包此图包')).toBeVisible({ timeout: 15000 })

      // 第一次：默认不勾 → 打包（zip 不含 文档/笔记）
      const r1 = await compressViaUi(false)
      expect(r1.success).toBe(true)
      expect(r1.resultPath).toBeTruthy()
      const names1 = await unzipList(r1.resultPath!)
      expect(names1.some((n) => n.includes('文档/笔记'))).toBe(false)

      // 第二次：勾选随包附带笔记 → 打包（zip 含 文档/笔记）
      const r2 = await compressViaUi(true)
      expect(r2.success).toBe(true)
      const names2 = await unzipList(r2.resultPath!)
      expect(names2.some((n) => n.includes('文档/笔记'))).toBe(true)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})
