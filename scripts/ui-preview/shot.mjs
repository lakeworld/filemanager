#!/usr/bin/env node
/**
 * 宿主 UI 截图走查（精致化轮，PLAN §5.2）：起真应用（QIHEBOX_E2E=1 + 独立 userdata）→
 * 种最小数据 → 逐路由截图，交人工目视裁决。首批只覆盖壳层可见场景（D4 硬停点素材），
 * 后续里程碑（D5/D6）逐批扩到 §5.2 的 ≥10 场景。
 *
 * 用法：node scripts/ui-preview/shot.mjs [输出目录]
 *   输出目录缺省 docs/INTERNAL/assets/v2.5.8/D4-壳层对比/after
 *   QIHE_SHOT_BASELINE=1 → 只抓路由态，跳过改造后才存在的交互点位（抓「改前」基线用）
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
  ['notes', '/notes'], // v2.5.8 W5：笔记库库页化（对标图包/证书）
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

// —— 种数据：工作区 + 8 产品集（凑够 >5 让搜索下拉出搜索框）+ 客户/供应商 + 证书 PDF + 三域笔记 ——
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-ui-ws-'))
await page.evaluate(async (dir) => window.qihebox.workspace.create(dir), wsDir)
await page.evaluate(async () => {
  for (let i = 1; i <= 8; i++) await window.qihebox.productSets.create({ name: `走查系列${i}` })
  await window.qihebox.clients.create({ name: '走查客户' })
  await window.qihebox.suppliers.create({ name: '走查供应商' })
})

const put = async (rel, content) => {
  const abs = path.join(wsDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}
// 证书：3 份 PDF（信息封面档 → 扩展名字标 + 到期徽标），其中一份临期
const pdf = (t) => `%PDF-1.4\n% ${t}\n`
const c1 = await put('产品集/走查系列1/证书/3C/强制认证.pdf', pdf('cert'))
await put('产品集/走查系列1/证书/质检/出厂检验报告.pdf', pdf('cert'))
// 注意：证书库只聚合 `workspaceConfig().cert_subfolders`（默认 3C/质检/专利）里配置的子目录，
// 放进未配置的目录（如「跨境」）不会出现在本页——样本必须落在配置内的目录。
const c2 = await put('产品集/走查系列2/证书/专利/外观专利证书.pdf', pdf('cert'))
// 三域笔记各一篇（笔记库对标的核心场景）
await put('产品集/走查系列1/文档/笔记/产品纪事.md', '# 产品纪事\n\n系列1 的认证与打样记录。\n')
await put('客户/走查客户/笔记/拜访纪要.md', '# 拜访纪要\n\n客户沟通结论与后续动作。\n')
await put('供应商/走查供应商/笔记/采购备忘.md', '# 采购备忘\n\n交期与来料检验口径。\n')
const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
// 元数据 update 是**全量覆盖**（契约见 shared/types.ts 注释）：四字段必须一次传齐，
// 分两次打会让后一次把前一次的到期日清空——样本一开始就这么写，徽标莫名消失，实为调用姿势错。
await page.evaluate(async (a) => {
  await window.qihebox.metadata.update({
    file_path: a.p, cert_type: '强制认证', expiry_date: a.d, tags: ['走查', '认证'], notes: '',
  })
  await window.qihebox.metadata.update({
    file_path: a.q, cert_type: '', expiry_date: a.d2, tags: [], notes: '',
  })
}, { p: c1, q: c2, d: plus(9), d2: plus(120) })

// 导航：合入 hotfix/2.5.8-file-routing 后 file:// 走 HashRouter，路由值住 `#/…`。
// 原脚本的 pushState + popstate 在 HashRouter 下不再改变路由（且 file:// 上换 path 会被拒），
// 一律改走 hash——顺带覆盖「深链冷启动」这条真实路径。
const goto = async (url) => {
  await page.goto(`${INDEX_URL}#${url}`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!window.qihebox, null, { timeout: 10000 })
  await page.waitForTimeout(900)
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

// v2.5.8（D5）：弹窗打开态——新建客户（modal-panel 玻璃化走查素材）；Esc 关闭后确认 overlay 归零
try {
  await goto('/clients')
  await page.getByRole('button', { name: '新建客户' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'modal-create.png'), timeout: 12000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  console.log('✓ modal-create /clients')
} catch (err) {
  failures++
  console.log(`✗ modal-create: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
}

// v2.5.8（W4/W5 本批）：SearchSelect 弹层、笔记库网格与多选浮条、筛选无结果空态。
// QIHE_SHOT_BASELINE=1 时整段跳过——用于抓「改造前」基线，那些点位改造前根本不存在。
if (!process.env.QIHE_SHOT_BASELINE) {
  const shots = [
    ['searchselect-open', async () => {
      await goto('/certs')
      await page.getByLabel('产品集筛选').click()
      await page.waitForTimeout(400)
    }],
    ['notes-grid', async () => {
      await goto('/notes')
    }],
    ['notes-filter-open', async () => {
      await goto('/notes')
      // 筛选行的下拉（「归属实体」是新建弹窗里那个的标签，此处要用筛选口径）
      await page.getByLabel('归属实体筛选').click()
      await page.waitForTimeout(400)
    }],
    ['notes-selected', async () => {
      await goto('/notes')
      await page.locator('[data-note-card]').first().click()
      await page.waitForTimeout(400)
    }],
    ['notes-nomatch', async () => {
      await goto('/notes')
      await page.getByPlaceholder('搜索标题或归属…').fill('zzz不存在')
      await page.waitForTimeout(400)
    }],
  ]
  for (const [key, act] of shots) {
    try {
      await act()
      await page.screenshot({ path: path.join(OUT, `${key}.png`), timeout: 12000 })
      console.log(`✓ ${key}`)
    } catch (err) {
      failures++
      console.log(`✗ ${key}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }
}

console.log(`截图输出：${OUT}`)
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {})
process.exit(failures === 0 ? 0 : 1)
