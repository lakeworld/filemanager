import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** hello 示例插件构建产物（scripts/build-hello-plugin.mjs 生成；pretest:e2e 钩子自动构建） */
const HELLO_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')
const HELLO_ID = 'com.qihe.hello'
/** hello 发布版插件版本（随 manifest 动态断言，防再绑死——2026-08-14 编排审查补） */
const HELLO_VERSION = JSON.parse(
  await fsp.readFile(path.join(ROOT, 'src', 'plugins', 'hello', 'manifest.json'), 'utf-8'),
).version as string

/**
 * 插件宿主 e2e（v2.5，PLAN §八 + 侧载收紧 §3.5）：
 * - devMode 门控：默认关 → 直调 install IPC 被拒（DEV_MODE_REQUIRED）；开启后侧载全链路可走
 * - hello 侧载全链路：安装 → 清单/页面渲染/IPC 调用 → 禁用 → 启用 → 卸载（清单清空、调用报未安装）
 * - 插件管理页 UI：风险横幅 / 开发者模式开关（无侧载入口 ↔ 有入口）/ 安装确认框文案（含"系统权限"告知语）/
 *   已安装清单展示（版本动态断言）
 * - 重启持久化：devMode 开关重启后保持
 * 说明：右键命令触发（hello.greet）不在此处 UI 触发（loader 命令路由有单测覆盖），本 spec 覆盖协议全链路 + 管理页可观测面。
 * QIHEBOX_E2E=1 隔离 userData，但跨运行持久——每用例前置清场（卸载 + devMode 关回），从空态开始。
 * 注意：page.evaluate 回调是字符串化到浏览器执行的，外层常量（HELLO_ID 等）必须作参数传入，不得在回调内引用。
 */
test.describe('插件宿主 e2e（v2.5）', () => {
  let app: ElectronApplication
  let page: Page

  const launchApp = async (): Promise<void> => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  }

  const killApp = async (): Promise<void> => {
    if (!app) return
    try {
      process.kill(-app.process().pid!, 'SIGKILL')
    } catch {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch { /* 已退出 */ }
    }
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
  }

  test.beforeAll(async () => {
    await launchApp()
  })

  test.afterAll(async () => {
    // 清场：卸载插件 + devMode 关回（跨 spec 残留防护，r2-测试P1-5）
    try {
      await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), HELLO_ID)
      await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(false))
    } catch { /* 应用可能已退出 */ }
    await killApp()
  })

  const gotoRoute = (route: string) =>
    page.evaluate((r) => {
      window.history.pushState({}, '', r)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, route)

  const uninstallAll = () => page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), HELLO_ID)

  const setDevMode = (enabled: boolean) =>
    page.evaluate(async (v) => (window as any).qihebox.settings.setDevMode(v), enabled)

  test('侧载收紧：devMode 关闭时 install 被拒（DEV_MODE_REQUIRED）；开启后 hello 全链路', async () => {
    // 前置：hello 构建产物存在（pretest:e2e 钩子构建，见 PLAN §七）
    await expect(fsp.stat(HELLO_QBOX)).resolves.toBeTruthy()
    // 清场：e2e userData 跨运行持久，先卸载 + devMode 关回（忽略不存在），保证从空态开始
    await uninstallAll()
    await setDevMode(false)

    // 0. devMode 关闭 → 直调 install IPC 被拒（PLAN §3.5 IPC 层强制）
    const denied = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), HELLO_QBOX)
    expect(denied.success).toBe(false)
    expect(String(denied.error)).toContain('DEV_MODE_REQUIRED')
    const list0 = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    expect(list0.data.some((p: any) => p.id === HELLO_ID)).toBe(false)

    // 0.5 开启开发者模式（userData 持久化）
    expect(await setDevMode(true)).toBe(true)

    // 1. 侧载安装（JSON Schema + SHA-256 校验在宿主侧）
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), HELLO_QBOX)
    expect(ins.success).toBe(true)
    expect(ins.data.id).toBe(HELLO_ID)

    // 2. 清单含 hello 且默认启用（manifest.enabled=true）；版本与 manifest 动态一致
    const list1 = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    const hello = list1.data.find((p: any) => p.id === HELLO_ID)
    expect(hello).toBeTruthy()
    expect(hello.state).toBe('enabled')
    expect(hello.version).toBe(HELLO_VERSION)

    // 3. IPC 调用（懒加载触发 + 回显）
    const ping = await page.evaluate(
      async (id) => (window as any).qihebox.plugins.call(id, 'ping', { text: 'e2e-ping' }),
      HELLO_ID,
    )
    expect(ping.success).toBe(true)
    expect(ping.data.echo).toBe('e2e-ping')
    expect(ping.data.count).toBe(1)

    // 4. 插件页面渲染（协议 URL 动态 import；侧边栏插件分组 + 路由）
    await gotoRoute('/plugin/hello')
    await expect(page.getByRole('heading', { name: '👋 Hello 示例插件' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '调用 ping IPC' }).click()
    await expect(page.getByText(/回声：你好，插件！/)).toBeVisible({ timeout: 10000 })
    // 累计计数：页面点击前 step 3 已直接 ping 过一次（主进程实例级计数），故不锁死具体数字
    await expect(page.getByText(/累计调用 \d+ 次/)).toBeVisible()

    // 5. 禁用（保留代码与状态）→ 路由移除（页面不可达）
    const off = await page.evaluate(async (id) => (window as any).qihebox.plugins.setEnabled(id, false), HELLO_ID)
    expect(off.success).toBe(true)
    const list2 = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    expect(list2.data.find((p: any) => p.id === HELLO_ID).state).toBe('disabled')

    // 6. 重新启用（实例重激活）
    const on = await page.evaluate(async (id) => (window as any).qihebox.plugins.setEnabled(id, true), HELLO_ID)
    expect(on.success).toBe(true)
    const list3 = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    expect(list3.data.find((p: any) => p.id === HELLO_ID).state).toBe('enabled')

    // 7. 卸载（删除代码与状态）→ 清单清空；二次调用报未安装
    const rm = await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), HELLO_ID)
    expect(rm.success).toBe(true)
    const list4 = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    expect(list4.data.some((p: any) => p.id === HELLO_ID)).toBe(false)
    const after = await page.evaluate(
      async (id) => (window as any).qihebox.plugins.call(id, 'ping', {}),
      HELLO_ID,
    )
    expect(after.success).toBe(false)
  })

  test('插件管理页 UI：风险横幅 / devMode 门控（入口出现与隐藏）/ 确认框文案 / 清单展示', async () => {
    // 清场 + 确保 devMode 关闭（默认态）
    await uninstallAll()
    await setDevMode(false)

    // 1. 默认关 → 管理页无侧载导入入口 + 风险横幅可见
    await gotoRoute('/settings/plugins')
    await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/插件未经过官方审查，安装需自行承担风险/)).toBeVisible()
    await expect(page.getByRole('heading', { name: '侧载导入' })).toHaveCount(0)

    // 2. 开启开发者模式 → 侧载导入入口出现
    await page.getByRole('switch').click()
    await expect(page.getByRole('heading', { name: '侧载导入' })).toBeVisible()

    // 3. 安装确认框文案断言（含"系统权限"告知语，PLAN §3.5）——
    //    原生文件对话框不可自动化，主进程 patch dialog.showOpenDialog 返回固定路径
    await app.evaluate(async ({ dialog }, qboxPath) => {
      // 只 patch openFile 场景：返回 hello .qbox 路径
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () =>
        ({ canceled: false, filePaths: [qboxPath] }) as never
    }, HELLO_QBOX)
    await page.getByRole('button', { name: '导入本地插件包 (.qbox)' }).click()
    await expect(page.getByText(/此插件将获得与启禾文件管理同等的系统权限/)).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/插件未经过官方审查。仅安装你信任来源的插件。确认安装？/)).toBeVisible()
    // 取消（不安装，保持清单空态）
    await page.getByRole('button', { name: '取消' }).click()

    // 4. 走正式安装（IPC）→ 清单展示 id 与版本（动态断言 manifest.version）
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), HELLO_QBOX)
    expect(ins.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.plugins.list())
    await gotoRoute('/settings/plugins')
    await expect(page.getByText(HELLO_ID)).toBeVisible()
    await expect(page.getByText(`v${HELLO_VERSION}`)).toBeVisible()

    // 5. 重启持久化：devMode 开关重启后保持开启（settings.json 落盘 userData）
    await killApp()
    await launchApp()
    const devModeAfterRestart = await page.evaluate(async () => (window as any).qihebox.settings.getDevMode())
    expect(devModeAfterRestart).toBe(true)
    // 重启后管理页入口仍在（依赖持久化开关）
    await gotoRoute('/settings/plugins')
    await expect(page.getByRole('heading', { name: '侧载导入' })).toBeVisible({ timeout: 15000 })

    // 清理：卸载 + devMode 关回（避免残留影响其他 spec 的清单断言与默认态）
    await uninstallAll()
    await setDevMode(false)
    const list = await page.evaluate(async () => (window as any).qihebox.plugins.list())
    expect(list.data.some((p: any) => p.id === HELLO_ID)).toBe(false)
  })
})
