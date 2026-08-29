import { test, expect, _electron as electron } from '@playwright/test'
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
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
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
    await page.goto(INDEX_URL)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.history.pushState({}, '', u)
      window.dispatchEvent(new PopStateEvent('popstate'))
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

  test('/notes 工作台：三域聚合 + 点击行深链开编辑', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/notes')
      await expect(page.getByText('产品纪事')).toBeVisible({ timeout: 20000 })
      await expect(page.getByText('拜访纪要')).toBeVisible({ timeout: 20000 })
      // 点击产品集笔记行 → 深链开编辑器
      await page.locator('[data-note-row]').filter({ hasText: '产品纪事' }).click()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      await expect(page.locator('[data-note-editor] [contenteditable="true"]')).toContainText('产品纪事', { timeout: 20000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('新建笔记（选归属）→ 落盘 → 开编辑', async () => {
    const wsDir = await setup()
    try {
      await navigateTo('/notes')
      await expect(page.getByText('产品纪事')).toBeVisible({ timeout: 20000 })
      // 供应商归属——建供应商实体（目录须真实存在，create 会建 dir）
      await page.getByRole('button', { name: /新建笔记/ }).click()
      // kind 选择按钮在弹窗内（精确匹配，避开侧边栏/列表）
      await page.locator('.p-6').getByRole('button', { name: '供应商', exact: true }).click()
      const spDir = path.join(wsDir, '供应商', '李四', '笔记')
      await fsp.mkdir(spDir, { recursive: true })
      const supplierInputs = page.locator('input[placeholder="供应商名称"]')
      await supplierInputs.fill('李四')
      const titleInput = page.locator('input[placeholder="笔记标题（保存为 .md）"]')
      await titleInput.fill('采购备忘')
      await page.getByRole('button', { name: /创建并编辑/ }).click()
      // 落盘
      await page.waitForTimeout(1500)
      expect(await fsp.stat(path.join(spDir, '采购备忘.md')).then((s) => s.size).catch(() => 0)).toBeGreaterThan(0)
      // 工作台刷新后可见
      await navigateTo('/notes')
      await expect(page.getByText('采购备忘')).toBeVisible({ timeout: 20000 })
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
