import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.QIHE_PLUGINS_DIST ?? ''
const CLOUD_QBOX = DIST ? path.join(DIST, 'com.qihe.cloud.qbox') : ''
const PLUGIN_ID = 'com.qihe.cloud'
const EMAIL = process.env.QIHE_E2E_EMAIL ?? ''
const PASSWORD = process.env.QIHE_E2E_PASSWORD ?? ''
const skip = !EMAIL || !PASSWORD || !CLOUD_QBOX

// 登录态全链路走查 + Q-AI-4 热态基线（用户放行服务端部署后跑）：
// 1) 真账号登录宿主 → 2) 安装 cloud 0.2.0 → 3) 打开 AI 面板发消息 →
//    4) 走真实链路（插件本地网关 → 启禾云端 /api/ai/v1/chat/completions → 阶跃）→
//    5) 断言 assistant 回复 + 工具 info（缺省不跑，凭据经 env 提供，不落盘）。
// 前置要求：云端 AI 代理已部署（ai_proxy.go）且服务器配置 STEPFUN_API_KEY。
// 运行：
//   QIHE_E2E_EMAIL=<账号> QIHE_E2E_PASSWORD=<密码> HOME=/tmp/qh-home \
//   npx playwright test tests/e2e/zz-ai-chat-live.spec.ts
test('启禾云 AI 助手：登录态全链路（云端代理）', async () => {
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
    // 登录（我的 → 账号）
    const login = await page.evaluate(
      async ([email, pw]) => (window as any).qihebox.account.login(email, pw),
      [EMAIL, PASSWORD] as const,
    )
    expect(login.success, `login err: ${String(login.error)}`).toBe(true)
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), CLOUD_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)

    // 登录态 ai.status：enabled=true，且冷态（尚未发消息）无 worker 进程
    const st0 = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.status', {}), PLUGIN_ID)
    expect(st0.data.enabled).toBe(true)
    expect(st0.data.active).toBe(false)

    // Q-AI-4 热态基线：记录 main 进程 RSS（发消息前）
    const rssBefore = await page.evaluate(async () => (window as any).qihebox.app?.memoryUsage?.() ?? null)

    // 发送消息，轮询 events 等 settled（上限 120s）
    const sent = await page.evaluate(
      async (id) => (window as any).qihebox.plugins.call(id, 'ai.chat', { message: '查一下客户总数（用工具），一句话回答' }),
      PLUGIN_ID,
    )
    expect(sent.data.accepted).toBe(true)
    let lastId = 0
    let finalText = ''
    let settled = false
    let toolInfo = false
    const t0 = Date.now()
    while (!settled && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 700))
      const ev = await page.evaluate(
        async ([id, after]) => (window as any).qihebox.plugins.call(id, 'ai.events', { afterId: after }),
        [PLUGIN_ID, lastId] as const,
      )
      settled = ev.data.settled
      for (const e of ev.data.events) {
        lastId = Math.max(lastId, e.id)
        if (e.type === 'assistant') finalText += e.text
        if (e.type === 'info') toolInfo = true
      }
    }
    expect(settled, '120s 内未 settled').toBe(true)
    // 失败诊断：无 assistant 文本时把事件尾部打出来（工具信息/错误一目了然）
    if (finalText.trim().length === 0) {
      const evEnd = await page.evaluate(
        async ([id, after]) => (window as any).qihebox.plugins.call(id, 'ai.events', { afterId: after }),
        [PLUGIN_ID, 0] as const,
      )
      console.log('[[LIVE-EVENTS-DIAG]]', JSON.stringify((evEnd.data.events ?? []).slice(-10)))
    }
    expect(finalText.trim().length).toBeGreaterThan(0)
    expect(toolInfo).toBe(true) // 至少一次工具动作（客户总数查询）

    // Q-AI-4：发消息后主进程 RSS 增量（热态）——热态增量应显著小于 worker 本身（worker 是独立子进程）
    if (rssBefore) {
      const rssAfter = await page.evaluate(async () => (window as any).qihebox.app?.memoryUsage?.() ?? null)
      console.log(`[[Q-AI-4]] main-rss-before=${rssBefore} main-rss-after=${rssAfter}`)
    }
  } finally {
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    await app.close()
  }
})

// 辅助：查本机真实 Pi worker RSS（供 QA-4 参考数据；不走宿主）
test('Q-AI-4 参考：Pi worker 独立 RSS（node 直测）', async () => {
  const CLI = process.env.QIHE_PI_CLI ?? ''
  test.skip(!CLI, '需要 QIHE_PI_CLI（pi 代理 cli 路径，仅本地）')
  const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', timeout: 30000 })
  expect(out.length).toBeGreaterThan(0)
})
