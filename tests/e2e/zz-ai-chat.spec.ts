import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.QIHE_PLUGINS_DIST ?? ''
const CLOUD_QBOX = DIST ? path.join(DIST, 'com.qihe.cloud.qbox') : ''
const PLUGIN_ID = 'com.qihe.cloud'

/** 找本机残留的 pi-worker 进程（零常驻冷态门禁用） */
function workerProcs(): string[] {
  try {
    const out = execFileSync('pgrep', ['-af', 'pi-worker'], { encoding: 'utf8' }).trim()
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []
  } catch {
    return [] // pgrep 无匹配 → 退出码 1 → 视为零进程
  }
}

// 本地验证用（依赖内部插件仓 .qbox，不纳入公开 CI）：启禾云页——AI 助手未登录门控 +
// IPC 契约形状冒烟（ai.status / ai.chat 拒绝 / ai.events）+ 冷态零 worker 门禁。
// 登录态全链路由插件侧 ai-real 真推理测试覆盖（zz-ai-chat-live 为部署后验收）。
test('启禾云 AI 助手：未登录门控 + IPC 冒烟', async () => {
  test.skip(!!process.env.CI || !CLOUD_QBOX, '依赖内部插件仓 .qbox 产物，公开 CI 不可用——本地验证需 QIHE_PLUGINS_DIST')
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
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const ins = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), CLOUD_QBOX)
    expect(ins.success, `install err: ${String(ins.error)}`).toBe(true)

    // IPC 契约冒烟（未登录）
    const status = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.status', {}), PLUGIN_ID)
    expect(status.success).toBe(true)
    expect(status.data.enabled).toBe(false)
    expect(status.data.active).toBe(false)
    expect(typeof status.data.model).toBe('string')
    const chat = await page.evaluate(
      async (id) => (window as any).qihebox.plugins.call(id, 'ai.chat', { message: '你好' }),
      PLUGIN_ID,
    )
    expect(chat.success).toBe(true)
    expect(chat.data.accepted).toBe(false) // 未登录拒绝
    expect(chat.data.error).toContain('登录')
    const events = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.events', { afterId: 0 }), PLUGIN_ID)
    expect(events.success).toBe(true)
    expect(Array.isArray(events.data.events)).toBe(true)
    const drain = await page.evaluate(async (id) => (window as any).qihebox.plugins.call(id, 'ai.drainPrefill', {}), PLUGIN_ID)
    expect(drain.success).toBe(true)
    expect(drain.data.item).toBeNull()

    // 页面渲染（未登录门控横幅 → AI 输入禁用提示）
    await page.evaluate(() => {
      window.history.pushState({}, '', '/plugin/cloud')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByText(/登录后可用/).first()).toBeVisible({ timeout: 15000 })

    // Q-AI-4 冷态门禁：进过 AI 页、仅触发 IPC（未发消息）→ 宿主零 worker 进程（零常驻）
    const workers = workerProcs()
    expect(workers, `冷态不应有 pi-worker 进程：${workers.join(',')}`).toEqual([])
  } finally {
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    await app.close()
  }
})
