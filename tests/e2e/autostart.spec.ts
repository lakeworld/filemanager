import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * S4 开机自启 e2e（v2.4.9）：
 * 1. 设置页「通用」开关：开 → $XDG_CONFIG_HOME/autostart/启禾文件管理.desktop 生成
 *    （Exec 含全量参数 + --autostart）+ isAutoLaunch true；关 → 文件删除 + false
 * 2. --autostart 启动分支（env 注入 QIHEBOX_AUTOSTART=1）：不建窗 + 托盘就绪 + 诊断日志；
 *    second-instance 触发 ensureMainWindow 建窗
 * 3. Win/mac 平台分支仅单测 mock（Playwright _electron 无法 mock 主进程），e2e 不覆盖
 */

/** e2e 日志目录（index.ts 的 QIHEBOX_E2E 分支隔离到 tmp，S6-2 已实现） */
const LOGS_DIR = path.join(os.tmpdir(), 'qihebox-e2e-userdata', 'logs')
/** 本 spec 专用自启目录：注入 XDG_CONFIG_HOME 使 autostart 落到临时目录，不碰真实 autostart */
const XDG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-autostart-e2e-'))
const DESKTOP_ENTRY = path.join(XDG_DIR, 'autostart', '启禾文件管理.desktop')
/** Exec 应含的全量参数（与 core/autoLaunch.ts AUTOSTART_ARGS 逐字一致；三处同步已由单测静态锚定） */
const EXPECTED_EXEC_ARGS =
  '--no-zygote --no-sandbox --disable-gpu --in-process-gpu --js-flags=--max-old-space-size=768 --autostart'

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

/** e2e 模式收尾：SIGKILL 进程组 + close 带 5s 超时（同既有 spec 模式） */
async function killApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return
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

test.describe('S4 开机自启：设置页开关', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    // 清空历史 e2e 日志，保证断言从干净状态开始
    await fsp.rm(LOGS_DIR, { recursive: true, force: true }).catch(() => {})
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', XDG_CONFIG_HOME: XDG_DIR },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    await killApp(app)
  })

  /** 设置页「通用」card 内的开机自启 checkbox（按 card 文本定位，避免与其他 checkbox 混淆） */
  const autoLaunchCheckbox = () =>
    page.locator('div.card', { hasText: '开机自启' }).getByRole('checkbox')

  const isAutoLaunch = () =>
    page.evaluate(
      () =>
        (window as any).qihebox.app.isAutoLaunch() as Promise<{ success: boolean; data: boolean }>,
    )

  test('开关开 → desktop 生成（Exec 全量参数）且 isAutoLaunch true；关 → 文件删除、false', async () => {
    await page.getByRole('button', { name: /设置/ }).click()
    await page.getByRole('heading', { name: '设置' }).waitFor({ timeout: 10000 })
    const cb = autoLaunchCheckbox()
    await expect(cb).toBeVisible({ timeout: 10000 })
    // 初始态：无 desktop 文件 → 回填后未勾选
    await expect(cb).not.toBeChecked()
    expect(fs.existsSync(DESKTOP_ENTRY)).toBe(false)

    // 开：desktop 文件生成，内容含全量参数 + --autostart
    await cb.check()
    await expect.poll(() => fs.existsSync(DESKTOP_ENTRY), { timeout: 10000 }).toBe(true)
    const content = await fsp.readFile(DESKTOP_ENTRY, 'utf8')
    expect(content).toContain('Type=Application')
    expect(content).toContain('Name=启禾文件管理')
    expect(content).toContain('X-GNOME-Autostart-enabled=true')
    expect(content).toContain('Exec="')
    expect(content).toContain(EXPECTED_EXEC_ARGS)
    const r1 = await isAutoLaunch()
    expect(r1.success && r1.data).toBe(true)

    // 关：文件删除，isAutoLaunch false
    await cb.uncheck()
    await expect.poll(() => !fs.existsSync(DESKTOP_ENTRY), { timeout: 10000 }).toBe(true)
    const r2 = await isAutoLaunch()
    expect(r2.success && r2.data === false).toBe(true)
  })
})

test.describe('S4 开机自启：--autostart 启动分支（QIHEBOX_AUTOSTART=1）', () => {
  let app: ElectronApplication

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_AUTOSTART: '1', XDG_CONFIG_HOME: XDG_DIR },
    })
  })

  test.afterAll(async () => {
    await killApp(app)
  })

  test('自启态：不建窗 + 诊断日志（命中来源/托盘初始化/延迟建窗）；second-instance 触发建窗；isTrayReady true', async () => {
    // 1) 等待主进程 whenReady 完成（托盘初始化日志落盘 = setupTray 已执行、tray 非空）
    await expect
      .poll(async () => (await readAllLogs()).includes('autostart: 托盘初始化完成'), {
        timeout: 20000,
      })
      .toBe(true)

    // 2) 自启态不建窗（延迟建窗——本任务新稳态：无窗口、托盘常驻）
    const winCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(winCount).toBe(0)

    // 3) 诊断日志：命中来源（env 注入）+ 延迟建窗
    const text = await readAllLogs()
    expect(text).toContain('autostart 模式命中（来源: env）')
    expect(text).toContain('autostart: 延迟建窗，等待托盘/激活触发')

    // 4) second-instance → 既有 ensureMainWindow() 兜底建窗
    await app.evaluate(({ app: eApp }) => eApp.emit('second-instance'))
    await expect
      .poll(
        async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0)
    // 触发点诊断日志
    await expect
      .poll(async () => (await readAllLogs()).includes('autostart: second-instance 触发建窗'), {
        timeout: 10000,
      })
      .toBe(true)

    // 5) 建窗后经渲染层验证 isTrayReady 通道（托盘常驻态持续有效）
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const trayReady = await page.evaluate(
      () =>
        (window as any).qihebox.app.isTrayReady() as Promise<{ success: boolean; data: boolean }>,
    )
    expect(trayReady.success && trayReady.data).toBe(true)
  })
})
