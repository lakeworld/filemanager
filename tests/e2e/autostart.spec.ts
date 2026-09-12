import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
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
const LOGS_DIR = path.join(os.tmpdir(), e2eUserDataDirName('autostart'), 'logs')
/** 本 spec 专用自启目录：注入 XDG_CONFIG_HOME 使 autostart 落到临时目录，不碰真实 autostart */
const XDG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-autostart-e2e-'))
const DESKTOP_ENTRY = path.join(XDG_DIR, 'autostart', '启禾文件管理.desktop')
/** Exec 应含的全量参数（与 core/autoLaunch.ts AUTOSTART_ARGS 逐字一致；三处同步已由单测静态锚定） */
const EXPECTED_EXEC_ARGS =
  '--no-zygote --no-sandbox --disable-gpu --in-process-gpu --js-flags=--max-old-space-size=768 --autostart'

/**
 * 启动期「文件索引就绪」信号文案。
 * 出处 `src/main/index.ts` `setupWorkspaceIndex()`：build 分支打「文件索引已构建：N 个目录」、
 * load 分支打「文件索引已加载（N 个目录已重建）」，两条分支在候选会话 commit 后都固定打这一条
 * （`:612`，常量串、不含可变的目录数）⇒ 只锚它，不锚带数字的那两句。
 */
const INDEX_READY_LOG = '文件索引已就绪（候选提交）'
/** 上述文案在已落盘日志里出现的次数（本 spec 两个 describe 共用一个日志目录，故按次数比对基线） */
async function countIndexReadyLogs(): Promise<number> {
  return (await readAllLogs()).split(INDEX_READY_LOG).length - 1
}

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
      // QIHEBOX_AUTOSTART_FORCE：e2e 跑的是未打包实例（`electron .`），v2.5.8 起未打包实例**拒绝**
      // 写自启项（写了就是「登录弹 Electron 空窗」那个缺陷）。本 spec 要验的是「设置页开关 → IPC →
      // .desktop 内容」这条链，故显式旁路放行；拒写行为本身由 tests/unit/autoLaunch.test.ts 负例覆盖。
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('autostart'), QIHEBOX_AUTOSTART_FORCE: '1', XDG_CONFIG_HOME: XDG_DIR },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    await killApp(app)
  })

  /**
   * 设置页「通用」卡内的开机自启 checkbox。
   * v2.5.8 D11（W7）前该卡只有一条开关，按「卡文本含 开机自启」定位即唯一；W7 把这张卡扩成
   * 6 条开关后同一张卡里有 6 个 checkbox（strict mode 直接歧义）。定位意图未变——仍要那条
   * 开机自启开关——只是将收窄层级从「卡」下移到「本条目的 label」，与 `app-settings.spec.ts`
   * 的 `toggleOf()` 同一口径。
   */
  const autoLaunchCheckbox = () =>
    page.locator('label', { hasText: '开机自启' }).first().getByRole('checkbox')

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
  /**
   * 开跑前已在盘上的「文件索引已就绪」条数。必须先记基线再 launch：本 describe 与上一个 describe
   * 共用 `LOGS_DIR`（同名 `e2eUserDataDirName('autostart')`），上个实例启动时打过的那条还在文件里，
   * 直接 `includes` 会被旧日志瞬间满足 ⇒ 前置等待形同虚设、竞态照旧。
   */
  let indexReadyBaseline = 0

  test.beforeAll(async () => {
    indexReadyBaseline = await countIndexReadyLogs()
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('autostart'), QIHEBOX_AUTOSTART: '1', XDG_CONFIG_HOME: XDG_DIR },
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

    // 【前置等待·非编号步骤】启动期文件索引让出主线程后，才允许本 describe 第一次打主进程的
    // app.evaluate。缺陷（v2.5.8 D13，待拍板卡 2026-09-12 方案 A）：上面第 1 步的托盘日志在
    // whenReady 同步段即落盘，而索引 build 在其后才完成（本机实测 02:24:03.492 托盘 →
    // 02:24:04.101 就绪，差 ~0.6s）；在这个窗口里打 evaluate 会撞上主进程繁忙，Playwright 报
    // 「electronApplication.evaluate: Resulting promise was garbage collected.」。
    // 只加前置等待，以下各断言的结论一字未动。
    await expect
      .poll(countIndexReadyLogs, { timeout: 20000 })
      .toBeGreaterThan(indexReadyBaseline)

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
