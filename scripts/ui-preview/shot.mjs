#!/usr/bin/env node
/**
 * 宿主 UI 截图走查（精致化轮，内部设计文档 §5.2）：起真应用（QIHEBOX_E2E=1 + 独立 userdata）→
 * 种最小数据 → 逐路由截图，交人工目视裁决。首批只覆盖壳层可见场景（D4 硬停点素材），
 * 后续里程碑（D5/D6）逐批扩到 §5.2 的 ≥10 场景。
 *
 * 用法：node scripts/ui-preview/shot.mjs [输出目录]
 *   输出目录缺省内部证据归档（不进公开仓）
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
  // v2.5.8 精致化 D6：把批 2 / 批 3 改到的页面全部纳入同机位走查（此前只 7 页，改完看不见全貌）
  ['quotes', '/quotes'], // 台账骨架卡玻璃 + .chip 药丸 + 金额 tabular-nums
  ['product-set-detail', '/product-sets/' + encodeURIComponent('走查系列1')], // 三域卡 + 关联空态虚线
  ['images', '/images'], // 高基数豁免面：应无玻璃且 hover 保内亮边
  ['search', '/search'], // 结果卡实底（基数不可控）
  ['exports', '/exports'], // 小列表玻璃卡（≥200 条分支走实底，此处为小列表态）
  // v2.5.9 A7 整页化（2026-09-22 深夜）：计算页空态（三条历史与选中高亮见下方 calc-filled/calc-selected）
  ['calc', '/calc'],
  ['trash', '/trash'],
  ['profile', '/profile'], // 未走 .card 体系（D6 登记为 D9 债，此处留基线照）
  ['help', '/help'],
  // v2.5.8 D12：插件管理页（素材库 8 张基线里第 6 张拍的是插件 LAN 聊天内页，
  // 现行同侧栏入口落在插件管理页——补这条场景才凑得齐「8 组同机位对比」，配对关系在对比档里注明）
  ['plugins', '/settings/plugins'],
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
/**
 * 关掉当前叠在页面上的弹窗/菜单。
 * 必要性：hash 路由下 goto() 只是同文档片段跳转、**不重载文档**，上一张截图留下的弹窗会一直开着，
 * 把下一个场景的目标挡住（实测 dlg-rename-supplier 因此 30s 等不到右键目标）。
 */
const closeAnyDialog = async () => {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
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
    // —— v2.5.8 弹窗专项：逐个改版弹窗的 framed 形态取证（Modal 头部/页脚 + .dlg-field 排版）——
    ['dlg-create-ps', async () => {
      await goto('/product-sets')
      await closeAnyDialog()
      await page.getByRole('button', { name: /新建产品集/ }).first().click()
      await page.waitForTimeout(400)
    }],
    ['dlg-create-supplier', async () => {
      await goto('/suppliers')
      await closeAnyDialog()
      await page.getByRole('button', { name: /新建供应商/ }).first().click()
      await page.waitForTimeout(400)
    }],
    ['dlg-rename-supplier', async () => {
      await goto('/suppliers')
      await closeAnyDialog()
      // 重命名入口在卡片右键菜单（副标题那句「关联入库单引用同步更新」是本次要留证的重点提示）
      // 右键目标取卡片内的名称文本（照 suppliers.spec.ts:161 已验证口径；点 .card 容器实测不弹菜单）
      await page.getByText('走查供应商', { exact: true }).click({ button: 'right' })
      await page.getByRole('button', { name: /重命名/ }).click()
      await page.waitForTimeout(400)
    }],
    ['dlg-create-note', async () => {
      await goto('/notes')
      await closeAnyDialog()
      await page.getByRole('button', { name: /新建笔记/ }).first().click()
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

// ══════════════════════════════════════════════════════════════════════════
// v2.5.8 D12（执行卡 §七.2）：三类补齐 —— ① 第 5 个 framed 弹窗 ② 空态 ③ 窄窗三档 + 高基数滚动中态
// 场景清单从 25 条扩到 40 条（实跑产物 40 张全 png，逐张点数核过）。窄窗与空态是「精致化改造后有没有把非默认窗口尺寸/无数据形态
// 改崩」的唯一图证来源（e2e 只跑 1280/1920 两档，且不核看空态排版）。
// 对外口径（2026-09-12 D14 校正，复审 r2 P2-7）：40 是**产物张数**，不同画面只有 **38 个**——
// `empty-trash`（:252）与 `ROUTES.trash`（:53）、`notes-grid`（:169）与 `ROUTES.notes`（:45）两对函数体都只是
// 同一句 `goto`，全脚本没有任何删除/切视图动作，各自与常规走查重复。
// 灰度像素比对（sharp，对 `D12-终审包/after` 实跑产物）：`notes` vs `notes-grid` 均值差 0.006、仅 0.032% 像素不同，
// 而 `trash` vs `empty-trash` 差 0.295 —— 该值与 `search` vs `empty-search`、`images` vs `images-scrolling`
// **完全同值**，即早晚两次抓拍之间的底噪，不是真差异画面的信号。
// 「回收站空态」「笔记宫格态」这两个本该覆盖的形态因此**是缺口**，本轮按用户拍板只改口径文字、不动场景（另立）。
// ══════════════════════════════════════════════════════════════════════════
const extraShots = [
  // ① framed 弹窗第 5 个：文件区内建「笔记」视图的新建笔记（其余 4 个已在 dlg-* / modal-create）
  ['dlg-create-note-fb', async () => {
    await goto('/files/doc/' + encodeURIComponent('走查系列1') + '/' + encodeURIComponent('笔记'))
    await closeAnyDialog()
    await page.getByRole('button', { name: /新建笔记/ }).first().click()
    await page.waitForTimeout(400)
  }],
  // ② 空态三处：空子文件夹 / 搜索无结果 / 回收站（无数据形态的卡壳与文案重叠都在这里露）
  ['empty-folder', async () => {
    await goto('/files/doc/' + encodeURIComponent('走查系列1') + '/' + encodeURIComponent('空文件夹没有'))
    await page.waitForTimeout(400)
  }],
  ['empty-search', async () => {
    await goto('/search')
    await page.getByPlaceholder(/搜索/).first().fill('zzz一定不存在的东西')
    await page.waitForTimeout(700)
  }],
  ['empty-trash', async () => {
    await goto('/trash')
  }],
  // ③ 高基数页滚动中态（VirtualGrid 面：滚动中不应出现玻璃/白块/空栅格）
  ['images-scrolling', async () => {
    await goto('/images')
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(600)
  }],
]
for (const [key, act] of extraShots) {
  try {
    await act()
    await page.screenshot({ path: path.join(OUT, `${key}.png`), timeout: 12000 })
    console.log(`✓ ${key}`)
  } catch (err) {
    failures++
    console.log(`✗ ${key}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }
}

// v2.6.1 B15 容器化（2026-09-25 深夜）：计算页走查改新形态——左栏 = **容器列表**（点行切容器）、
// 右栏 = 当前容器的记录流。两本容器：①「报价核算」两条（含标题/备注，其中一条打「已标记」）；
// ②「装箱毛重」一条。空态已在 ROUTES.calc 抓过；这里抓①有数据态 ②点左栏第二本（换容器 + 看得见「已标记」chip）。
try {
  await page.evaluate(async () => {
    const mk = async (name) => (await window.qihebox.calcs.createContainer({ name }))?.data?.id
    const a = await mk('报价核算')
    const b = await mk('装箱毛重')
    const mid = await window.qihebox.calcs.add({
      expression: '(3200 + 380) × 1.15', result: '4,117.00', resultKind: 'number',
      title: '新款装箱报价', note: '含 15 个点毛利，XX 客户', container_id: a,
    })
    await window.qihebox.calcs.add({ expression: '2026-09-16 + 60', result: '2026-11-15', resultKind: 'date', container_id: a })
    await window.qihebox.calcs.add({
      expression: '13800 ÷ 1.13 × 0.13', result: '1,589.38', resultKind: 'number', container_id: b,
    })
    // 「已标记」chip 是两态唯一视觉差异，走查要看得见
    if (mid?.data?.id) await window.qihebox.calcs.update({ id: mid.data.id, saved: true })
  })
  await goto('/calc')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, 'calc-filled.png'), timeout: 12000 })
  console.log('✓ calc-filled /calc')
  // 点左栏第二本容器 ⇒ 右栏整栏换成该容器的记录（新形态的"选中"就是这个切换动作）
  await page.locator('[data-calc-side="container"]').nth(1).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, 'calc-selected.png'), timeout: 12000 })
  console.log('✓ calc-selected /calc')
} catch (err) {
  failures++
  console.log(`✗ calc-filled/calc-selected: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
}

// ④ 窄窗三档（1024 / 900 / 768）× 三个代表页：筛选行最密的证书库、卡片+表单混排的设置页、
//    带浮条与网格的笔记库。取这三页的理由：各自的横向挤压模式不同，一页能代表一类。
const NARROW_PAGES = [
  ['certs', '/certs'],
  ['settings', '/settings'],
  ['notes', '/notes'],
]
for (const w of [1024, 900, 768]) {
  for (const [key, route] of NARROW_PAGES) {
    try {
      await page.setViewportSize({ width: w, height: 900 })
      await goto(route)
      await page.screenshot({ path: path.join(OUT, `narrow-${w}-${key}.png`), timeout: 12000 })
      console.log(`✓ narrow-${w}-${key}`)
    } catch (err) {
      failures++
      console.log(`✗ narrow-${w}-${key}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }
}
// 复位到素材库同机位，保证后面的产物与前序场景口径一致
await page.setViewportSize(VIEWPORT)

console.log(`截图输出：${OUT}`)
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {})
process.exit(failures === 0 ? 0 : 1)
