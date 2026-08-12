import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * e2e 日志目录：index.ts 的 QIHEBOX_E2E 分支把 logs 与 userData 一并隔离到
 * <tmpdir>/qihebox-e2e-userdata/logs（与生产 ~/.config/启禾文件管理/logs 完全隔离）。
 */
const LOGS_DIR = path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'logs')

/**
 * S6 日志系统（v2.4.9，PLAN §3.6.3 / §3.6.4）：
 * 1. 「我的」页日志卡片：导出日志按钮可见（2026-08-12 用户反馈：不再提供打开日志目录）
 * 2. 导出日志：保存对话框（e2e 打桩）→ 确认 → 路径存在且为 zip
 * 3. 渲染进程 console.error/warn 注入 → main-*.log 含 [renderer] 行（info 不转发）
 */
test.describe('S6 日志系统', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    // 清空历史 e2e 日志（共享 tmp 目录可能残留上次运行产物），保证断言从干净状态开始
    await fsp.rm(LOGS_DIR, { recursive: true, force: true }).catch(() => {})
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护——
    // 进程已死时 close 应快速返回（关闭 Playwright 内部句柄，避免 worker teardown 等待）；
    // 极端情况 close 内部卡住时 race 兜底，不让 afterAll 拖到 90s。
    if (app) {
      try {
        // 杀整个进程组（主进程 + Chromium 子进程）：仅杀主进程会残留 renderer/gpu，
        // Playwright worker teardown 会等待残留进程退出而超时 90s
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  /** 进入「我的」页 → 点开「日志」卡片（菜单项 accessible name 含描述文案，精确定位） */
  const openLogCard = async () => {
    await page.getByRole('button', { name: /我的/ }).click()
    await page.getByRole('heading', { name: '我的' }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: /日志文件用于诊断/ }).click()
    await page.getByRole('heading', { name: '日志' }).waitFor({ timeout: 10000 })
  }

  test('「我的」页日志卡片：导出日志按钮可见', async () => {
    await openLogCard()
    // 2026-08-12 用户反馈：不需要打开日志目录，仅保留导出
    await expect(page.getByRole('button', { name: '导出日志' })).toBeVisible()
    await expect(page.getByRole('button', { name: '打开日志目录' })).toHaveCount(0)
  })

  test('导出日志：保存对话框确认 → 路径存在且为 zip', async () => {
    await openLogCard()
    const zipPath = path.join(os.tmpdir(), `qihebox-logs-e2e-${Date.now()}.zip`)
    // 主进程 dialog.showSaveDialog 打桩：返回固定保存路径（e2e 不弹真实系统对话框）。
    // app.evaluate 约定：pageFunction(electron, arg)，electron 模块为第一实参。
    await app.evaluate(
      async (electron, p) => {
        ;(electron.dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: p })
      },
      zipPath,
    )

    await page.getByRole('button', { name: '导出日志' }).click()
    // 导出成功 → 卡片内提示保存路径（此时 zip 已由 compressToZip 写完）
    await expect(page.getByText(zipPath)).toBeVisible({ timeout: 15000 })

    const st = await fsp.stat(zipPath)
    expect(st.size).toBeGreaterThan(0)
    // zip 魔数 PK\x03\x04（v2.4.4 core archive.compressToZip 产物）
    const head = Buffer.alloc(4)
    const fh = await fsp.open(zipPath, 'r')
    await fh.read(head, 0, 4, 0)
    await fh.close()
    expect(head.toString('latin1')).toBe('PK\x03\x04')
    await fsp.rm(zipPath, { force: true }).catch(() => {})
  })

  test('渲染 console.error/warn 注入 → main-*.log 含 [renderer] 行（info 不转发）', async () => {
    // 注入发生在窗口已就绪之后（beforeAll 已启动窗口，console-message 监听随窗口创建已挂上）
    await page.evaluate(() => {
      console.error('e2e-renderer-error')
      console.warn('e2e-renderer-warn')
      console.info('e2e-renderer-info')
    })

    // 转发落盘为异步写（FileLogger writeLine），轮询等待 [renderer] 行出现
    let text = ''
    for (let i = 0; i < 40; i++) {
      text = await readAllLogs()
      if (text.includes('[error] [renderer] e2e-renderer-error') && text.includes('[warn] [renderer] e2e-renderer-warn')) {
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(text).toContain('[error] [renderer] e2e-renderer-error')
    expect(text).toContain('[warn] [renderer] e2e-renderer-warn')
    // 只转 error/warn：info 级不得落盘（防噪音红线）
    expect(text).not.toContain('[renderer] e2e-renderer-info')
  })
})

/** 读取 logs 目录全部 main-YYYY-MM-DD.log 拼接文本（与 core FileLogger 同口径） */
async function readAllLogs(): Promise<string> {
  let names: string[]
  try {
    names = await fsp.readdir(LOGS_DIR)
  } catch {
    return ''
  }
  const logs = names.filter((f) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  const parts = await Promise.all(
    logs.map((f) => fsp.readFile(path.join(LOGS_DIR, f), 'utf8').catch(() => '')),
  )
  return parts.join('\n')
}
