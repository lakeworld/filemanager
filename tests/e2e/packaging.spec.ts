import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 一键打包链路（v2.4.7 F9）：压缩分享主进程链路 + 产品集目录路径契约。
 * 背景：评审 P0 修复——产品集目录实为 工作区/产品集/<名>/（非 工作区/<名>/），
 * 打包路径错误会导致功能 100% 失败，空名时甚至可能压缩整个工作区。
 * 本 spec 直接调 archive.compress 验证路径契约（UI 拼接 `${ws}/产品集/${name}` 由渲染层
 * 实现，tsc + 代码审查保障），产物断言落 工作区/导出/。
 */
test.describe('一键打包链路', () => {
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

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-pack-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
    const ps = await page.evaluate(() => (window as any).qihebox.productSets.create({ name: '打包测试集' }))
    expect(ps.success).toBe(true)
    // 往产品集目录放一个文件（产品集目录 = 工作区/产品集/打包测试集/）
    const psDir = path.join(wsDir, '产品集', '打包测试集')
    await fsp.mkdir(psDir, { recursive: true })
    await fsp.writeFile(path.join(psDir, 'hello.txt'), '打包链路测试')
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

  /** 触发一次压缩任务并等待 archive:complete 事件（compress 异步走事件收口） */
  const compressAndWait = (paths: string[], token: string) =>
    page.evaluate(({ paths, token }) => {
      return new Promise<unknown>((resolve) => {
        const off = (window as any).qihebox.events.on('archive:complete', (d: unknown) => {
          off();
          resolve(d);
        });
        (window as any).qihebox.archive.compress({ paths, cancelToken: token });
        // 15s 兜底，防事件丢失挂死
        setTimeout(() => {
          off();
          resolve({ success: false, error: 'e2e 等待 archive:complete 超时' });
        }, 15000);
      });
    }, { paths, token })

  test('产品集目录正确路径 → 产物落 工作区/导出/ 且可读', async () => {
    const psDir = path.join(wsDir, '产品集', '打包测试集')
    const complete = await compressAndWait([psDir], `e2e-pack-${Date.now()}`) as {
      success: boolean; cancelled: boolean; error: string | null; result: { path: string; count: number; size: number } | null;
    }
    expect(complete.success).toBe(true)
    expect(complete.result).not.toBeNull()
    const zipPath = complete.result!.path
    // 产物必须在 工作区/导出/ 下
    expect(path.dirname(zipPath)).toBe(path.join(wsDir, '导出'))
    expect(path.extname(zipPath)).toBe('.zip')
    // 产物文件真实存在且非空
    const st = await fsp.stat(zipPath)
    expect(st.size).toBeGreaterThan(0)
    expect(complete.result!.count).toBeGreaterThan(0)
  })

  test('错误路径（工作区根下同名目录不存在）→ 压缩失败而非误压', async () => {
    // P0 场景：旧实现 `${ws}/打包测试集`（漏「产品集/」段）——该目录不存在，应报错
    const badPath = path.join(wsDir, '打包测试集')
    const complete = await compressAndWait([badPath], `e2e-bad-${Date.now()}`) as {
      success: boolean; cancelled: boolean; error: string | null;
    }
    expect(complete.success).toBe(false)
    expect(complete.error).toMatch(/不存在|不可读|失败/)
  })
})
