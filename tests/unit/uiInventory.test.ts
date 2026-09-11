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

/**
 * 「刻意异几何」的输入点豁免表（文件 → 命中数基线）。
 *
 * 判据只认「class 里同时出现 `border-surface-200` 与 `px-3`/`py-2`」= `.input` 骨架被重述，
 * 所以真正需要豁免的**只有 Header 全局搜索一处**：它要 `py-2` 撑高度，但左内缩 `pl-9` 给
 * 绝对定位的搜索图标让位、底色是 `bg-surface-100`（嵌在顶栏里，不是白底表单字段）——
 * 换成 `ui/Input` 会同时改掉几何与底色，属趁重构改版式（本卡 §五.2 禁止），故登记放行。
 *
 * 其余几处在判据下天然不命中，无需登记（列在这里反而会让门禁虚设）：
 *  - `pages/Search.tsx:211` hero 大输入 `py-3 rounded-xl text-lg shadow-sm`
 *  - `components/PdfPreview.tsx:210` 工具条微控件 `px-2 py-1 rounded text-xs`
 *  - `pages/Clients.tsx:541` / `pages/ProductSets.tsx:505` / `pages/Settings.tsx:765,878`
 *    小筛选与内联重命名 `px-2 py-1 rounded`（注意是 `rounded` 不是 `rounded-lg`）
 *
 * 新增豁免必须同时写清「为什么不是同配方」，否则视为绕过。
 */
const INPUT_GEOMETRY_EXEMPT: Record<string, number> = {
  'components/Header.tsx': 1,
}

/**
 * 扫「手写在 `<input>` / `<textarea>` 标签上的 `.input` 材质串」。
 *
 * 必须**引号/花括号感知**地取整个标签：`[^>]*?>` 这类写法会停在
 * `onKeyDown={(e) => ...}` 的 `>` 上把标签截断（本仓 codemod 首跑实测漏掉一个点位）。
 * 命中判据：class 里同时有 `border-surface-200` 与（`px-3` 或 `py-2`）——
 * 即 `.input` 的骨架（`h-9 px-3 rounded-lg border border-surface-200 bg-white text-sm`）被重述。
 */
function inputMaterialHits(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of codeFiles()) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    let n = 0
    for (const m of src.matchAll(/<(input|textarea)\b/g)) {
      const end = scanTag(src, m.index ?? 0, m[1])
      if (end < 0) continue
      const tag = src.slice(m.index, end)
      const cls = /class="([^"]*)"/.exec(tag)?.[1]
      if (!cls) continue
      if (cls.includes('border-surface-200') && (/(^|\s)px-3(\s|$)/.test(cls) || /(^|\s)py-2(\s|$)/.test(cls))) n++
    }
    if (n > 0) out[rel(f)] = n
  }
  return out
}

/** 从 `<input` / `<textarea` 起点扫到该标签结束下标（不含）；引号与花括号内不判边界 */
function scanTag(s: string, i: number, name: string): number {
  let j = i + name.length + 1
  let depth = 0
  let q: string | null = null
  while (j < s.length) {
    const c = s[j]
    if (q) {
      if (c === '\\') j += 2
      else if (c === q) q = null
    } else if (c === '"' || c === "'" || c === '`') q = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 0 && c === '/' && s[j + 1] === '>') return j + 2
    else if (depth === 0 && c === '>') return j + 1
    j++
  }
  return -1
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

  /**
   * v2.5.8 D9（W4 控件统一 II）：渲染层原生 `<select>` 元素清零，唯一合法归宿 = `ui/Select.tsx` 底座。
   * 依据 = 调研 §五.1「清单内已有同语义组件的一律使用」+ §五.2「缺能力补组件 props，不绕开」。
   * D9 已把 34 处调用点（含最后一处 `ui/Select` 包装调用点）全量换 `SearchSelect`，
   * 底座保留但**零调用点**——所以这里把它自己的命中数也钉死为 1：
   * 谁删了底座、或往页面里塞回原生 select，这条都会红。
   * 计数走 `countByFile`（已去注释），注释里写「原生 select」不会被误判。
   */
  it('控件红线：原生 select 元素清零（只准住在 ui/Select 底座）', () => {
    const hits = countByFile('<select', codeFiles())
    const offenders = Object.entries(hits).filter(([f]) => f !== 'components/ui/Select.tsx')
    expect(
      offenders,
      `页面/弹窗里又出现原生 select，请改用 ui/SearchSelect（能力不够就给它补 props）：${JSON.stringify(offenders)}`,
    ).toEqual([])
    expect(hits['components/ui/Select.tsx'] ?? 0, 'ui/Select 底座里的原生 select 元素数量变了（连带更新本门禁）').toBe(1)
  })

  /**
   * v2.5.8 D9（W4 控件统一 II）第二步：`.input` 配方**材质串**不得在页面里手写重述。
   *
   * 为什么按「元素 + 材质串」扫而不是按文件 grep：`border border-surface-200 rounded-lg` 这一串
   * 被大量 div/button 当通用边框复用（实测 49 行命中），按文件数会把无关命中一起算进来；
   * 只有住在 `<input>` / `<textarea>` 标签上的那一份才是「绕过 `ui/Input` 重写材质」，才是要拦的。
   *
   * 拦的判据 = 材质 token 命中 `px-3` 或 `py-2` 且带 `border-surface-200`（= `.input` 的骨架）。
   * 刻意不同几何的写法**不在此列**，走显式豁免表：左内缩让位搜索图标的 `pl-9 pr-4`、
   * hero 大输入 `py-3 rounded-xl text-lg`、工具条微控件 `px-2 py-1 rounded text-xs`、
   * 内联重命名 `px-2 py-1 rounded`——它们本来就不是 `.input` 那一档，
   * 收进来等于趁重构改版式（本卡 §五.2 明令禁止），故登记后放行。
   */
  it('控件红线：手写 .input 材质串清零（异几何走豁免表，其余必须用 ui/Input）', () => {
    const hits = inputMaterialHits()
    const offenders = Object.entries(hits).filter(([f]) => !(f in INPUT_GEOMETRY_EXEMPT))
    expect(
      offenders,
      `页面里又手写了 .input 材质串，请改用 ui/Input / ui/Textarea（缺 props 就补，别绕开底座）：${JSON.stringify(offenders)}`,
    ).toEqual([])
    // 豁免表里的条目命中数也要钉死：谁「顺手」给异几何输入框补回标准材质，或清空了豁免，都会红
    for (const [f, c] of Object.entries(INPUT_GEOMETRY_EXEMPT)) {
      expect(hits[f] ?? 0, `豁免点位 ${f} 的命中数变了（现 ${hits[f] ?? 0}，基线 ${c}）——改版式请显式改本表`).toBe(c)
    }
  })

  /**
   * v2.5.8 D9：原生 `<textarea>` 与 `<select>` 同理清零，唯一归宿 = `ui/Textarea.tsx` 底座。
   * 底座自身命中数钉死为 1（与 select 那条同一口径，防「删底座」蒙过门禁）。
   */
  it('控件红线：原生 textarea 元素清零（只准住在 ui/Textarea 底座）', () => {
    const hits = countByFile('<textarea', codeFiles())
    const offenders = Object.entries(hits).filter(([f]) => f !== 'components/ui/Textarea.tsx')
    expect(
      offenders,
      `页面/弹窗里又出现原生 textarea，请改用 ui/Textarea：${JSON.stringify(offenders)}`,
    ).toEqual([])
    expect(hits['components/ui/Textarea.tsx'] ?? 0, 'ui/Textarea 底座里的 textarea 元素数量变了').toBe(1)
  })

  /**
   * v2.5.8 D9（W4 控件统一 II）：`.input` / `.select` / `.input-compact` 是底座的**内部实现**，
   * 页面只准用组件（`ui/Input`、`ui/Textarea`、`SearchSelect`），不准直接挂组件类。
   * 这一条管的是「看起来已经统一、其实绕过了底座」那一类：挂 `class="input …"` 的裸 `<input>`
   * 材质与 `ui/Input` 相同，但 error 态 / disabled 态 / 未来改档都要各点自己维护——
   * D9 实测这类点位有 14 个，全部收进 `ui/Input` 后此处钉为 0。
   * 底座自己（`components/ui/`）与 SearchSelect 面板内搜索框（同组件内部）不在此列。
   */
  it('控件红线：页面不得直接挂 .input/.select 组件类（类属底座内部）', () => {
    const hits: Record<string, number> = {}
    for (const f of codeFiles()) {
      if (rel(f).startsWith('components/ui/')) continue
      const src = stripComments(fs.readFileSync(f, 'utf8'))
      let n = 0
      for (const m of src.matchAll(/<(input|textarea|select)\b/g)) {
        const end = scanTag(src, m.index, m[1])
        if (end < 0) continue
        const cls = /class="(input|select|input-compact)(\s|")/.exec(src.slice(m.index, end))
        if (cls) n++
      }
      if (n > 0) hits[rel(f)] = n
    }
    expect(
      hits,
      `页面里又有裸元素直接挂组件类，请改用 ui/Input / ui/Textarea / SearchSelect：${JSON.stringify(hits)}`,
    ).toEqual({})
  })

  /**
   * v2.5.8 D9 踩坑固化：`ui/Input` / `ui/Textarea` 用**显式透传**（Solid 1.9 无 `omitKeys`，
   * spread 会把 `class`/`children` 一起灌进原生元素），所以调用点写了底座没接的属性时，
   * **构建不报错、运行静默丢**。更糟的是 TypeScript 对**连字符属性**（`aria-label`、`data-*`）
   * 走 JSX 特例放行，`tsc` 也抓不到——本晚 `RenameDialog` 换 `<Input>` 后 e2e 立刻找不到
   * `getByLabel('新文件名')`，就是这么来的（原生 `aria-label` 被吞）。
   * 这条把「组件标签上的连字符属性必须在底座 props 里有声明」钉成机器检查。
   */
  it('底座透传红线：ui/Input / ui/Textarea 调用点不得出现底座未声明的连字符属性', () => {
    const bases = { Input: 'components/ui/Input.tsx', Textarea: 'components/ui/Textarea.tsx' }
    const declared: Record<string, Set<string>> = {}
    for (const [name, file] of Object.entries(bases)) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8')
      // 只认 interface 声明的 camelCase prop。**不能**把底座内部 JSX 上写的属性名
      // （如 `aria-label={props.ariaLabel}`）算进「已声明」——调用点传 `aria-label` 依然会被
      // 显式透传的底座吞掉，那正是本条要抓的形态（反向实验第一版就漏在这一句上）。
      declared[name] = new Set([...src.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]))
    }
    const bad: string[] = []
    for (const f of codeFiles()) {
      const src = stripComments(fs.readFileSync(f, 'utf8'))
      for (const m of src.matchAll(/<(Input|Textarea)\b/g)) {
        const end = scanTag(src, m.index, '<' + m[1])
        const tag = src.slice(m.index, end < 0 ? src.length : end)
        for (const a of tag.matchAll(/[\s]([a-z][\w]*-[\w-]*)=/g)) {
          if (!declared[m[1]].has(a[1])) {
            bad.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length} <${m[1]} ${a[1]}>`)
          }
        }
      }
    }
    expect(
      bad,
      `连字符属性会被显式透传的底座静默丢弃且 tsc 不报（TS 对带 - 的 JSX 属性放行），请改用 camelCase prop：${bad.join(' | ')}`,
    ).toEqual([])
  })

  /**
   * v2.5.8 D10（精致化 W5）：多选浮条全站单点。
   * 收口前「已选择 …」这条横条在 7 个地方各写一份（FileBrowserView / Images / Certs /
   * Notes / Invoices 发票与入库 / Quotes），材质与量词各自漂移；Notes 那份先改成底部悬浮后，
   * 「内嵌条插入把列表整体下移 → 第二次点击落到计数行 → 双击开编辑丢失」这个坑
   * 只在其余六页存在（Notes.tsx 原注释里 e2e 事件轨迹抓实的那一条）。
   * 断言口径 = **代码**（去注释）里「已选择」只准出现在 `lib/selectionBar.ts` 的文案组法一处；
   * 组件与页面上的提法都活在注释里，不参与计数。
   */
  it('控件红线：多选浮条全站单点（"已选择" 只准住在 lib/selectionBar 一处）', () => {
    const hits = countByFile('已选择', codeFiles())
    expect(
      hits,
      `多选条又被手写了一份，请改用 ui/SelectionBar（加动作传 actions 数组即可）：${JSON.stringify(hits)}`,
    ).toEqual({ 'lib/selectionBar.ts': 1 })
  })

  /**
   * v2.5.8 D11（W7）：应用级设置的两条单点红线。
   *
   * ① **默认值只准住在 `src/shared/appSettings.ts` 一处**——这些开关的默认值就是「该项开关化之前的
   *    现行行为」，第二处再写一份 `closeToTray: true` 就会出现「磁盘没落键、UI 显示另一套」的漂移，
   *    而且老用户升级即刻中招（他们的 json 里根本没有这些键）。
   * ② **设置键名不得扩散到白名单之外**——新增消费点必须显式登记，防止「第五处开始自己认默认值」。
   *
   * 扫描范围是整个 `src/`（本文件其余断言只看渲染层，W7 的双源风险横跨 main/shared/renderer/preload）。
   */
  it('控件红线：应用级设置键名与默认值全站单点（W7 防双源）', () => {
    const PREF_KEYS = ['closeToTray', 'autoUpdateCheck', 'selectionBar', 'clipboardGuard', 'certReminder']
    const SRC_ALL = path.join(ROOT, 'src')
    const relAll = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/')
    const ALLOWED = new Set([
      'src/shared/appSettings.ts', // 形状 + 默认值表（唯一真相）
      'src/main/settings.ts', // 落盘读写
      'src/main/index.ts', // 主进程消费点（关窗/更新/提醒）
      'src/preload/index.ts', // IPC 桥（内部 appSettings 命名空间，不属插件可见面）
      'src/renderer/src/qihebox.d.ts', // 渲染层契约声明
      'src/renderer/src/stores/appSettings.ts', // 渲染层镜像
      'src/renderer/src/components/ui/SelectionBar.tsx', // 消费：浮条显隐
      'src/renderer/src/components/FileBrowserView.tsx', // 消费：剪贴板守卫
      'src/renderer/src/pages/Settings.tsx', // 设置页开关
    ])
    const strays: string[] = []
    const dupDefaults: string[] = []
    for (const f of walk(SRC_ALL).filter((x) => /\.tsx?$/.test(x))) {
      const r = relAll(f)
      const code = stripComments(fs.readFileSync(f, 'utf8'))
      for (const k of PREF_KEYS) {
        if (!ALLOWED.has(r) && new RegExp(`\\b${k}\\b`).test(code)) strays.push(`${r}:${k}`)
      }
      if (r !== 'src/shared/appSettings.ts') {
        for (const m of code.matchAll(
          /\b(closeToTray|autoUpdateCheck|selectionBar|clipboardGuard|certReminder)\s*[:=]\s*(?:true|false)\b/g,
        )) {
          dupDefaults.push(`${r}:${m[0]}`)
        }
      }
    }
    expect(
      strays,
      `W7 设置键名出现在白名单之外（新消费点请登记进本表白名单并说明理由）：${strays.join(' | ')}`,
    ).toEqual([])
    expect(
      dupDefaults,
      `W7 设置默认值被抄到 shared 之外（默认值 = 现行行为，只准一处）：${dupDefaults.join(' | ')}`,
    ).toEqual([])
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
