#!/usr/bin/env node
/**
 * 宿主 UI 截图走查（精致化轮，PLAN §5.2）：起真应用（QIHEBOX_E2E=1 + 独立 userdata）→
 * 种最小数据 → 逐路由截图，交人工目视裁决。首批只覆盖壳层可见场景（D4 硬停点素材），
 * 后续里程碑（D5/D6）逐批扩到 §5.2 的 ≥10 场景。
 *
 * 用法：node scripts/ui-preview/shot.mjs [输出目录]
 *   输出目录缺省 docs/INTERNAL/assets/v2.5.8/D4-壳层对比/after
 * 前置：先 npm run build（out/renderer）；node_modules 含 @playwright/test（e2e 环境自带）。
 * 退出码：0 全部截图完成；1 有失败；2 前置缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SELF, '..', '..')
const OUT = path.resolve(ROOT, process.argv[2] ?? 'docs/INTERNAL/assets/v2.5.8/D4-壳层对比/after')

const indexHtml = path.join(ROOT, 'out', 'renderer', 'index.html')
if (!fs.existsSync(indexHtml)) {
  console.error('✗ out/renderer/index.html 不存在，先 npm run build')
  process.exit(2)
}
const pwEntry = path.join(ROOT, 'node_modules', '@playwright', 'test', 'index.mjs')
if (!fs.existsSync(pwEntry)) {
  console.error(`✗ 未找到 @playwright/test（${pwEntry}）`)
  process.exit(2)
}
const { _electron: electron } = await import(pathToFileURL(pwEntry).href)

fs.mkdirSync(OUT, { recursive: true })
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'
// 与素材库基线（1022×1040，_旧版_v2.5.6/截图_启禾文件管理_20260828*）同机位分辨率
const VIEWPORT = { width: 1022, height: 1040 }

const ROUTES = [
  ['dashboard', '/'],
  ['product-sets', '/product-sets'],
  ['clients', '/clients'],
  ['invoices', '/invoices'],
  ['certs', '/certs'],
  ['settings', '/settings'],
]

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: ROOT,
  env: {
    ...process.env,
    QIHEBOX_E2E: '1',
    QIHEBOX_E2E_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-ui-preview-')),
  },
})
const page = await app.firstWindow()
await page.setViewportSize(VIEWPORT)
await page.waitForLoadState('domcontentloaded')
await page.waitForFunction(() => !!window.qihebox, null, { timeout: 10000 })

// 种最小数据：工作区 + 产品集 + 客户（壳层对比只看材质，不追基线的数据量）
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-ui-ws-'))
await page.evaluate(async (dir) => window.qihebox.workspace.create(dir), wsDir)
await page.evaluate(async () => {
  await window.qihebox.productSets.create({ name: '走查系列' })
  await window.qihebox.clients.create({ name: '走查客户' })
})

// 与 probe-render-shots 同款导航：goto 后 pushState + popstate（zoom 不重放——本脚本固定 1 倍）
const goto = async (url) => {
  await page.goto(INDEX_URL)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.qihebox, null, { timeout: 10000 })
  await page.evaluate((u) => {
    window.history.pushState({}, '', u)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, url)
  await page.waitForTimeout(700)
}

let failures = 0
for (const [key, route] of ROUTES) {
  try {
    await goto(route)
    await page.screenshot({ path: path.join(OUT, `${key}.png`), timeout: 12000 })
    console.log(`✓ ${key} ${route}`)
  } catch (err) {
    failures++
    console.log(`✗ ${key} ${route}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
}

console.log(`截图输出：${OUT}`)
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {})
process.exit(failures === 0 ? 0 : 1)
