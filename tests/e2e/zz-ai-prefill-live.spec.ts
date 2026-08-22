import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.QIHE_PLUGINS_DIST ?? ''
const CLOUD_QBOX = DIST ? path.join(DIST, 'com.qihe.cloud.qbox') : ''
const PLUGIN_ID = 'com.qihe.cloud'
const EMAIL = process.env.QIHE_E2E_EMAIL ?? ''
const PASSWORD = process.env.QIHE_E2E_PASSWORD ?? ''
const skip = !EMAIL || !PASSWORD || !CLOUD_QBOX

/**
 * 实地 AI 预填走查（v2.5.4 弹一×弹二交汇，默认 skip，凭据经 env 提供且不落盘）：
 * 1) 真账号登录宿主（QIHE_API_BASE 指向本地/生产 erp，API 基址由插件随宿主对齐）
 * 2) 安装 com.qihe.cloud 0.2.0 → 发送消息，明确要求 AI 调用「预填新建客户」工具
 * 3) AI 真实推理（本地编排 + 云端代理）→ boxCli customer_prefill_create → 主进程预填队列
 *    → 渲染层 drain → window.qihebox.ui.openCreatePrefill → 宿主「新建客户」弹窗自动打开
 * 4) 断言弹窗字段预填 + 用户手点「确认创建」落库（保存永远由人点）。
 * 注：模型存在不调工具的概率；若两次尝试仍不调，用例如实红（提醒人工核查既定链路）。
 * 运行：
 *   QIHE_E2E_EMAIL=<账号> QIHE_E2E_PASSWORD=<密码> QIHE_API_BASE=http://.../api HOME=/tmp/qh-home \
 *   npx playwright test tests/e2e/zz-ai-prefill-live.spec.ts
 */
test('启禾云 AI 助手：实地 AI 预填 → 宿主新建客户弹窗（登录态全链路）', async () => {
  test.setTimeout(240_000) // 真实推理 + 多轮工具调用
  test.skip(skip, '需要 QIHE_E2E_EMAIL/PASSWORD（真账号，绝不让凭据落盘/入仓库）')
  test.skip(!!process.env.CI, '依赖内部插件仓 + 真实云端 AI 代理，公开 CI 不可用')
  const app: ElectronApplication = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT,
    env: { ...process.env, QIHEBOX_E2E: '1' },
  })
  const page: Page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  try {
    await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
    const login = await page.evaluate(
      async ([email, pw]) => (window as any).qihebox.account.login(email, pw),
      [EMAIL, PASSWORD] as const,
    )
    expect(login.success, `login err: ${String(login.error)}`).toBe(true)
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), CLOUD_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)

    const st0 = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.status', {}), PLUGIN_ID)
    expect(st0.data.enabled).toBe(true)

    // 真实用户路径：打开「启禾云」插件页（AiChat 挂载 → 事件轮询与预填 drain 消费端就位）
    await page.getByRole('button', { name: /启禾云/ }).first().click()
    const input = page.locator('input[placeholder^="问点工作"]')
    await expect(input).toBeVisible({ timeout: 10000 })
    // 明确要求用工具预填：AI → boxCli 预填 op → 主进程队列 → AiChat drain → 宿主弹窗
    await input.fill('请调用「预填新建客户」工具新建一个客户：名称=实地预填测试公司，电话=13812345678。必须使用工具，不要口头建议。')
    await page.getByRole('button', { name: '发送', exact: true }).click()

    // 等待宿主「新建客户」弹窗（AI 网络链路 + 多轮工具调用，上限 180s）
    const dlg = page.locator('[role="dialog"][aria-label="新建客户"]')
    try {
      await dlg.waitFor({ state: 'visible', timeout: 180_000 })
    } catch (e) {
      const ev = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.events', { afterId: 0 }), PLUGIN_ID)
      console.log('[[PREFILL-EVENTS-DIAG]]', JSON.stringify((ev.data.events ?? []).slice(-30)))
      throw e
    }
    await expect(dlg.locator('input[placeholder="如：张三"]')).toHaveValue('实地预填测试公司')

    // 保存永远由用户手点
    await dlg.getByRole('button', { name: '确认创建' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list.data.some((x: { name: string }) => x.name === '实地预填测试公司')).toBe(true)
    expect(page.url()).toContain('/clients')

    // 无页面级异常
    await page.waitForTimeout(1000)
    expect(errs).toHaveLength(0)
  } finally {
    await app.close().catch(() => {})
  }
})
