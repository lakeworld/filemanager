/**
 * 渲染层视觉红线清单门禁（v2.5.8 精致化 D6 固化，2026-09-10）
 *
 * 守五件事（都是本轮读码/改码时真实踩到或差点踩到的坑，写成常驻断言而不是一次性 grep 取证）：
 *   1. **玻璃卡点位**：`card-glass` 出现的文件与次数 === 基线（PLAN §四「高基数 × blur = 内存/滚动炸弹」
 *      只有显式更新基线才能扩散，防「顺手给列表卡加个玻璃」）。
 *   2. **高基数硬白名单**：Images / FileBrowserView / Search / InvoiceCards / InboundCards 玻璃计数**必须为 0**。
 *   3. **材质单点**：`backdrop-filter` 只允许出现在 index.css，任何 .tsx/.ts 里写它都是绕过令牌。
 *   4. **控件与动效红线**：药丸内联串 / `hover:shadow-card-hover` / `transition-all` / `type="date"` 全清零；
 *      `type="number"` 只允许在非金额语义的白名单文件里（金额一律走 MoneyInput，D8 收 6 处）。
 *   5. **读字表面豁免**：`.modal-panel` / `.dlg-*` 必须实底——禁 `backdrop-filter`、禁半透明白底/白描边、
 *      禁头尾分隔线与 ✕ 关闭钮回潮（2026-09-10 弹窗材质回退，PLAN §四；变异验证已确认本条能抓）。
 *
 * 机制与 tests/unit/winBranchInventory.test.ts 同构（同一套 UPDATE / BREAK 环境变量约定）。
 * 背景：PLAN §三 批 2 原句「台账卡基数低 → 玻璃化」的前提已被 v2.5.5 卡片化推翻（现走 VirtualGrid），
 *      这类「文档口径与代码现状漂移」正是本门禁要拦的（见 assets/v2.5.8/D6-类名定位预扫描.md）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')
const BASELINE_PATH = path.join(ROOT, 'tests', 'unit', '__baselines__', 'ui-inventory.md')

const UIINV_UPDATE = process.env.UIINV_UPDATE === '1'
const UIINV_BREAK = process.env.UIINV_BREAK === '1'
const UIINV_BREAK_REASON = process.env.UIINV_BREAK_REASON || ''

/** 高基数面（VirtualGrid 逐行渲染 / 结果数无上限）：玻璃计数必须恒为 0 */
const ZERO_GLASS_FILES = [
  'pages/Images.tsx',
  'pages/Search.tsx',
  'components/FileBrowserView.tsx',
  'pages/invoices/InvoiceCards.tsx',
  'pages/invoices/InboundCards.tsx',
]

/** `type="number"` 例外白名单（非金额语义）：v2.5.8 D8 已把 6 处金额筛选收进 MoneyInput，
 *  本表随之收窄到只剩批量重命名序号步进器一条——再加金额语义的 number input 会被本门禁拦下。 */
const NUMBER_INPUT_ALLOW: Record<string, number> = {
  'components/BatchRenameDialog.tsx': 1, // 批量重命名序号步进器，非金额
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p))
    else if (/\.(tsx?|css)$/.test(ent.name)) out.push(p)
  }
  return out
}

/** 去注释（块注释整段删；行注释仅在 `//` 不是 `://` 的一部分时删——防把协议 URL 之后整行吃掉） */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n')
}

function rel(p: string): string {
  return path.relative(SRC, p).split(path.sep).join('/')
}

/** 文件 → 代码（去注释）中某串的命中次数 */
function countByFile(pattern: string, files: string[]): Record<string, number> {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  const map: Record<string, number> = {}
  for (const f of files) {
    const hits = stripComments(fs.readFileSync(f, 'utf8')).match(re)?.length ?? 0
    if (hits > 0) map[rel(f)] = hits
  }
  return map
}

function codeFiles(): string[] {
  return walk(SRC).filter((f) => /\.tsx?$/.test(f))
}

function serialize(map: Record<string, number>): string {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, c]) => `- ${f}:${c}`)
    .join('\n')
}

function readBaseline(): Record<string, number> {
  if (!fs.existsSync(BASELINE_PATH)) return {}
  const out: Record<string, number> = {}
  for (const line of fs.readFileSync(BASELINE_PATH, 'utf8').split('\n')) {
    const m = /^- (.+):(\d+)$/.exec(line.trim())
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

function writeBaseline(map: Record<string, number>): void {
  fs.writeFileSync(
    BASELINE_PATH,
    `# 渲染层玻璃卡点位基线（tests/unit/uiInventory.test.ts 自动维护，勿手改数值）\n` +
      `# 更新：UIINV_UPDATE=1 npx vitest run tests/unit/uiInventory.test.ts\n` +
      `# 语义：文件路径:card-glass 命中数（已去注释）。新增点位 = 给该页加玻璃材质，必须先确认它不是高基数面（PLAN §四）。\n\n` +
      serialize(map) +
      `\n`,
  )
}

describe('渲染层视觉红线清单（v2.5.8 D6 固化）', () => {
  const glassMap = countByFile('card-glass', codeFiles())

  it('玻璃卡点位与基线完全一致（增删点位都要显式更新基线）', () => {
    if (UIINV_UPDATE) {
      writeBaseline(glassMap)
      return
    }
    const base = readBaseline()
    if (UIINV_BREAK) {
      // 与 winBranchInventory 同一约定：显式声明破坏理由才放行，且必须是「计数变小」这类改进
      expect(UIINV_BREAK_REASON.length, 'UIINV_BREAK=1 必须同时给 UIINV_BREAK_REASON').toBeGreaterThan(0)
      const added = Object.keys(glassMap).filter((f) => (glassMap[f] ?? 0) > (base[f] ?? 0))
      expect(added, `破坏门禁但仍是新增玻璃点位：${added.join(', ')}`).toEqual([])
      return
    }
    expect(Object.keys(base).length, '基线文件缺失或为空——先跑 UIINV_UPDATE=1 生成').toBeGreaterThan(0)
    expect(serialize(glassMap), 'card-glass 点位漂移').toBe(serialize(base))
  })

  it('高基数面玻璃计数恒为 0（VirtualGrid / 无上限结果集）', () => {
    for (const f of ZERO_GLASS_FILES) {
      expect(glassMap[f] ?? 0, `${f} 是高基数面，出现 ${glassMap[f] ?? 0} 处 card-glass`).toBe(0)
    }
  })

  it('backdrop-filter 只住在 index.css（.tsx/.ts 里写它 = 绕过材质令牌）', () => {
    const hits = countByFile('backdrop-filter', codeFiles())
    expect(Object.entries(hits), `散落的 backdrop-filter：${JSON.stringify(hits)}`).toEqual([])
  })

  it('内联药丸串已收敛到 .chip，不再新造第二套', () => {
    const bad: string[] = []
    for (const f of codeFiles()) {
      const t = stripComments(fs.readFileSync(f, 'utf8'))
      if (/text-xs\s+px-2\s+py-0\.5\s+rounded-full/.test(t) || /rounded-full\s+px-2\s+py-0\.5/.test(t)) bad.push(rel(f))
    }
    expect(bad, `仍手写药丸串（改用 .chip）：${bad.join(', ')}`).toEqual([])
  })

  it('卡片不挂 hover:shadow-card-hover（它会覆盖 .card:hover 的内亮边）', () => {
    const hits = countByFile('hover:shadow-card-hover', codeFiles())
    expect(Object.entries(hits), `hover 阴影重复定义：${JSON.stringify(hits)}`).toEqual([])
  })

  it('动效红线：transition-all 零命中（v2.5.1 T1 纪律）', () => {
    const hits = countByFile('transition-all', codeFiles())
    expect(Object.entries(hits), `transition-all 回归：${JSON.stringify(hits)}`).toEqual([])
  })

  it('控件红线：type="date" 清零、type="number" 只允许白名单内的非金额语义', () => {
    const files = [...codeFiles(), path.join(SRC, 'index.css')]
    expect(Object.entries(countByFile('type="date"', files)), '原生 date input 回归').toEqual([])
    const numbers = countByFile('type="number"', codeFiles())
    for (const [f, c] of Object.entries(numbers)) {
      expect(NUMBER_INPUT_ALLOW[f], `${f} 出现 ${c} 处 type="number"，不在白名单（金额请走 MoneyInput）`).toBeDefined()
      expect(c, `${f} 的 type="number" 计数超过白名单登记值`).toBeLessThanOrEqual(NUMBER_INPUT_ALLOW[f])
    }
    // 白名单里已清零的条目要显式清理，防「白名单越拖越长」
    for (const [f, c] of Object.entries(NUMBER_INPUT_ALLOW)) {
      expect((numbers[f] ?? 0) > 0 || c === 0, `白名单条目 ${f} 已无命中，请从 NUMBER_INPUT_ALLOW 删除`).toBe(true)
    }
  })

  it('选中态单点：旧的两套手写选中串不再回潮（统一 .card-selected）', () => {
    const hits = countByFile('border-primary-500 bg-primary-50', codeFiles())
    expect(Object.entries(hits), `选中态又各写一套：${JSON.stringify(hits)}`).toEqual([])
  })

  it('弹窗表面必须实底（.modal-panel / .dlg-* 禁透明材质、禁头尾分隔线、禁 ✕ 回潮）', () => {
    // 依据 PLAN §四「读字表面豁免」（2026-09-10 用户实拍裁决）：弹窗叠在 bg-black/50 遮罩上，
    // 任何半透明白底都会算成彩度 0 的灰平板（实测 rgb(245,245,245)），半透白描边则使边缘糊死。
    const css = stripComments(fs.readFileSync(path.join(SRC, 'index.css'), 'utf8'))
    const modalTsx = fs.readFileSync(path.join(SRC, 'components', 'ui', 'Modal.tsx'), 'utf8')
    const bad: string[] = []
    const ruleRe = /\.((?:modal-panel|dlg-)[\w-]*)\s*\{([^}]*)\}/g
    for (let m = ruleRe.exec(css); m; m = ruleRe.exec(css)) {
      const who = `.${m[1]}`
      const body = m[2]
      if (/backdrop-filter/.test(body)) bad.push(`${who} 挂了 backdrop-filter`)
      if (/background(?:-color)?\s*:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\./.test(body)) bad.push(`${who} 用了半透明白底`)
      if (/border[^:]*:\s*[^;]*rgb\(\s*255\s+255\s+255\s*\//.test(body)) bad.push(`${who} 用了半透明白描边`)
      // 头尾分隔线：实底白面板上靠字重与留白分层，画线会重现"灰面板"观感
      if ((who === '.dlg-header' || who === '.dlg-footer') && /\bborder-[tb]\b/.test(body)) bad.push(`${who} 又加回了上下分隔线`)
    }
    expect(bad, `弹窗回到玻璃材质（见 PLAN §四 读字表面豁免）：${bad.join('；')}`).toEqual([])
    expect(modalTsx.includes('class="dlg-close"'), '弹窗头部不应重新出现 ✕ 关闭钮').toBe(false)
  })

  it('prefers-reduced-motion 全站单点（动画一处坍缩）', () => {
    const css = stripComments(fs.readFileSync(path.join(SRC, 'index.css'), 'utf8'))
    const n = css.match(/prefers-reduced-motion/g)?.length ?? 0
    expect(n, '减少动画偏好必须集中在一处 media query').toBe(1)
  })
})
