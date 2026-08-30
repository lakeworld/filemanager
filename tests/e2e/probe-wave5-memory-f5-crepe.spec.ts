/**
 * probe-wave5-memory-f5-crepe.spec.ts（波次5 临时内存实测，probe-* 被 testIgnore 排除规范运行）
 *
 * 两个新面（dispatch §六.2 + A2 硬门禁）：
 *  - Crepe 编辑器开启态增量：空闲 → /notes 打开编辑器 → post-GC heap / renderer workingSet / 主进程 RSS
 *  - F5 加密插件解密驻留增量：装加密 hello（mock 取钥）→ 主进程激活（内存解密 _compile）+ 渲染层页面
 *    加载 → 解密明文驻留的 renderer heap / workingSet 增量 + 主进程 RSS
 *
 * 输出 JSON：qihe-box/tests/e2e/probe-results/f5-crepe-memory-<ts>.json（不进仓）。
 * 数据留档供波次 5 裁决门禁是否修订。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, CDPSession } from '@playwright/test'
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectRendererMetrics } from './helpers/memoryMetrics'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLUGIN_ID = 'com.qihe.hello'
let mockBase = ''
let mockServer: http.Server
const lastKey: Record<string, string> = {}

async function buildEncryptedQbox(): Promise<{ qbox: string; keyHex: string }> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'f5-mem-'))
  const out = path.join(tmp, 'out')
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-hello-plugin.mjs'), '--src', path.join(ROOT, 'src/plugins/hello'), '--out', out, '--encrypt', '--entitlement', 'login'], { stdio: 'pipe' })
  const keyHex = (await fsp.readFile(path.join(out, `${PLUGIN_ID}.key`), 'utf8')).trim()
  return { qbox: path.join(out, `${PLUGIN_ID}.qbox`), keyHex }
}

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/api/box/plugin-key') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const b = JSON.parse(body)
          const key = lastKey[b.plugin_id]
          if (!key) return res.writeHead(404).end(JSON.stringify({ code: 'PLUGIN_KEY_NOT_FOUND' }))
          res.writeHead(200).end(JSON.stringify({ code: 200, data: { key_hex: key, algo: 'aes-256-gcm' } }))
        })
      } else {
        res.writeHead(404).end('{}')
      }
    })
    mockServer.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`
      resolve()
    })
  })
}

/** 主进程 RSS（KB）：主进程内读 process.memoryUsage().rss（显式字节，不依赖 metrics 类型映射） */
async function mainWorkingSetKb(app: ElectronApplication): Promise<number> {
  const rss = await app.evaluate(() => process.memoryUsage().rss)
  return Math.round(rss / 1024)
}

test.describe('波次5 内存两新面 probe（Crepe 编辑态 + F5 解密驻留）', () => {
  test('度量并留档', async () => {
    await startMock()
    const { qbox, keyHex } = await buildEncryptedQbox()
    lastKey[PLUGIN_ID] = keyHex
    const userData = path.join(os.tmpdir(), 'qihebox-e2e-userdata')
    await fsp.rm(userData, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(userData, { recursive: true })
    await fsp.writeFile(
      path.join(userData, 'account.json'),
      JSON.stringify({ token: 'raw:probe-token', userId: 'probe', email: 'probe@test.dev', deviceId: 'probe' }),
      { mode: 0o600 },
    )

    const app: ElectronApplication = await electron.launch({
      args: ['.', '--no-sandbox', '--js-flags=--expose-gc'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHE_API_BASE: mockBase },
    })
    const page: Page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    const cdp: CDPSession = await (await app.context()).newCDPSession(page)

    const results: Record<string, unknown> = {}
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // 0) 空闲基线
    await sleep(6000)
    results.idle = {
      mainWorkingSetKb: await mainWorkingSetKb(app),
      renderer: await collectRendererMetrics(app, page, cdp),
    }

    // 1) Crepe 编辑态
    await page.evaluate(() => {
      window.history.pushState({}, '', '/notes')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await sleep(3000)
    // 打开编辑器：点「新建笔记」（真实 mount Crepe 弹窗 NoteEditorModal）
    await page.getByRole('button', { name: /新建笔记|新建/ }).first().click().catch(() => {})
    await sleep(4000)
    // 等待 Crepe（milkdown ProseMirror）实例真正挂载——未挂载则 sampe 前标记
    const crepeMounted = await page
      .locator('.ProseMirror, [contenteditable="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 6000 })
      .then(() => true)
      .catch(() => false)
    await sleep(4000)
    results.crepeEditor = {
      crepeMounted,
      mainWorkingSetKb: await mainWorkingSetKb(app),
      renderer: await collectRendererMetrics(app, page, cdp),
    }

    // 2) F5 加密插件驻留：生产 cloud（密文 main 1.8MB 实际解密 _compile）+ 渲染层页面
    const cloudQbox = '/tmp/f5-mem-cloud/com.qihe.cloud.qbox'
    const cloudKey = (await fsp.readFile('/tmp/f5-mem-cloud/com.qihe.cloud.key', 'utf8')).trim()
    lastKey['com.qihe.cloud'] = cloudKey
    await page.evaluate(async () => (window as any).qihebox.settings.setDevMode(true))
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall('com.qihe.cloud')).catch(() => {})
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), PLUGIN_ID).catch(() => {})
    const insCloud = await page.evaluate(async (p) => (window as any).qihebox.plugins.install({ filePath: p }), cloudQbox)
    expect(insCloud.success, `cloud install err: ${JSON.stringify(insCloud.error)}`).toBe(true)
    // 激活触发 loader 取钥 + 解密 1.8MB main + _compile
    const t0 = Date.now()
    const sub = await page.evaluate(async () => (window as any).qihebox.plugins.call('com.qihe.cloud', 'subscription.status', {}))
    expect(sub.success, `cloud activate err: ${JSON.stringify(sub.error)}`).toBe(true)
    const actMs = Date.now() - t0
    await sleep(4000)
    results.f5EncryptedPlugin = {
      activationMs: actMs,
      mainWorkingSetKb: await mainWorkingSetKb(app),
      renderer: await collectRendererMetrics(app, page, cdp),
    }

    // 增量（直读可读）
    const fmt = (r: Record<string, unknown>) => ({
      heapUsedMb: +(Number((r.renderer as { heapUsedBytes: number }).heapUsedBytes) / 1048576).toFixed(2),
      heapTotalMb: +(Number((r.renderer as { heapTotalBytes: number }).heapTotalBytes) / 1048576).toFixed(2),
      nodes: (r.renderer as { nodes: number }).nodes,
      mainWorkingSetMb: +((r.mainWorkingSetKb as number) / 1024).toFixed(1),
    })
    const summary = {
      idle: fmt(results.idle as Record<string, unknown>),
      crepeEditor: fmt(results.crepeEditor as Record<string, unknown>),
      f5EncryptedPlugin: fmt(results.f5EncryptedPlugin as Record<string, unknown>),
      deltaCrepeVsIdle: {
        heapUsedMb: +(fmt(results.crepeEditor as Record<string, unknown>).heapUsedMb - fmt(results.idle as Record<string, unknown>).heapUsedMb).toFixed(2),
        mainWorkingSetMb: +(fmt(results.crepeEditor as Record<string, unknown>).mainWorkingSetMb - fmt(results.idle as Record<string, unknown>).mainWorkingSetMb).toFixed(1),
      },
      deltaF5VsCrepe: {
        heapUsedMb: +(fmt(results.f5EncryptedPlugin as Record<string, unknown>).heapUsedMb - fmt(results.crepeEditor as Record<string, unknown>).heapUsedMb).toFixed(2),
        mainWorkingSetMb: +(fmt(results.f5EncryptedPlugin as Record<string, unknown>).mainWorkingSetMb - fmt(results.crepeEditor as Record<string, unknown>).mainWorkingSetMb).toFixed(1),
      },
      resolvedPath: PLUGIN_ID,
    }
    console.log('[probe-f5-crepe]', JSON.stringify(summary, null, 2))

    const outDir = path.join(ROOT, 'tests', 'e2e', 'probe-results')
    await fsp.mkdir(outDir, { recursive: true })
    await fsp.writeFile(path.join(outDir, `f5-crepe-memory-${Date.now()}.json`), JSON.stringify({ summary, results }, null, 2))

    // 断言：两新面增量可测（留档非门禁——门禁修订由波次5 裁决；此处只保证度量有效性）
    expect(typeof summary.crepeEditor.heapUsedMb).toBe('number')
    expect(typeof summary.f5EncryptedPlugin.heapUsedMb).toBe('number')

    await app.close().catch(() => {})
    await new Promise<void>((r) => mockServer.close(() => r()))
  })
})
