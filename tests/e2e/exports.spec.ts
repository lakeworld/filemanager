import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 导出区（v2.4.8）：
 * - 侧边栏新增「导出」入口 → /exports 页面列出 工作区/导出/ 的压缩分享产物
 * - 删除产物：ConfirmDialog 确认 → 移入回收站 → 列表刷新
 * - 回归：侧边栏不再展示底部「最近产品集」快捷分组（「查看全部 (N)」文本消失）
 */
test.describe('导出区', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-exports-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
    const ps = await page.evaluate(() => (window as any).qihebox.productSets.create({ name: '导出测试集' }))
    expect(ps.success).toBe(true)
    // 往产品集目录放一个文件作为压缩源
    const psDir = path.join(wsDir, '产品集', '导出测试集')
    await fsp.mkdir(psDir, { recursive: true })
    await fsp.writeFile(path.join(psDir, 'hello.txt'), '导出区测试')
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
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  /** 触发一次压缩任务并等待 archive:complete 事件（显式指定 zip 名，便于断言） */
  const compressAndWait = (paths: string[], name: string, token: string) =>
    page.evaluate(({ paths, name, token }) => {
      return new Promise<unknown>((resolve) => {
        const off = (window as any).qihebox.events.on('archive:complete', (d: unknown) => {
          off();
          resolve(d);
        });
        (window as any).qihebox.archive.compress({ paths, name, cancelToken: token });
        setTimeout(() => {
          off();
          resolve({ success: false, error: 'e2e 等待 archive:complete 超时' });
        }, 15000);
      });
    }, { paths, name, token })

  /** 侧边栏「导出」入口进入导出区（先回仪表盘再进入，确保组件重新挂载、列表重新加载） */
  const openExports = async () => {
    await page.getByRole('button', { name: /仪表盘/ }).click()
    await page.getByRole('heading', { name: '仪表盘' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: /导出/ }).first().click()
    await page.getByRole('heading', { name: '导出' }).waitFor({ timeout: 10000 })
  }

  test('压缩产物在导出区可见，侧边栏无「最近产品集」快捷分组', async () => {
    const psDir = path.join(wsDir, '产品集', '导出测试集')
    const complete = await compressAndWait([psDir], 'e2e导出A', `e2e-exp-a-${Date.now()}`) as {
      success: boolean; result: { path: string } | null; error: string | null
    }
    expect(complete.success).toBe(true)
    const zipName = path.basename(complete.result!.path)
    expect(zipName).toBe('e2e导出A.zip')

    await openExports()
    // 列表行可见：文件名 + 大小 + 时间
    await expect(page.getByText(zipName, { exact: true })).toBeVisible()
    await expect(page.getByText(/B · 生成于/)).toBeVisible()

    // 回归：底部「最近产品集」快捷分组已移除（其专属「查看全部 (N)」文本不存在）
    await expect(page.getByText('查看全部 (', { exact: false })).toHaveCount(0)
  })

  test('删除导出文件：确认后列表刷新、产物消失', async () => {
    const psDir = path.join(wsDir, '产品集', '导出测试集')
    const complete = await compressAndWait([psDir], 'e2e导出B', `e2e-exp-b-${Date.now()}`) as {
      success: boolean; result: { path: string } | null; error: string | null
    }
    expect(complete.success).toBe(true)
    const zipName = path.basename(complete.result!.path)

    await openExports()
    await expect(page.getByText(zipName, { exact: true })).toBeVisible()

    // 行内「删除」→ 确认弹窗 → 确认（弹窗内按钮用 exact 文本区分列表行按钮）
    await page.locator('div.card', { hasText: zipName }).getByRole('button', { name: '删除' }).click()
    const dialog = page.locator('.fixed.inset-0.bg-black\\/50')
    await dialog.getByRole('button', { name: '删除', exact: true }).click()

    // 删除后列表刷新：该产物行消失，另一产物（e2e导出A）仍在
    await expect(page.getByText(zipName, { exact: true })).toHaveCount(0)
    await expect(page.getByText('e2e导出A.zip', { exact: true })).toBeVisible()

    // 产物确已移入回收站（可恢复，非物理删除）
    const trash = await page.evaluate(() => (window as any).qihebox.trash.list())
    expect(trash.success).toBe(true)
    expect(trash.data.some((t: { name: string }) => t.name === zipName)).toBe(true)
  })
})
