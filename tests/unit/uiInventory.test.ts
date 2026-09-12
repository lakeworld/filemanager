/**
 * 渲染层视觉红线清单门禁（v2.5.8 精致化 D6 固化，2026-09-10）
 *
 * 守六件事（都是本轮读码/改码时真实踩到或差点踩到的坑，写成常驻断言而不是一次性 grep 取证）：
 *   1. **玻璃卡点位**：`card-glass` 出现的文件与次数 === 基线（PLAN §四「高基数 × blur = 内存/滚动炸弹」
 *      只有显式更新基线才能扩散，防「顺手给列表卡加个玻璃」）。
 *   2. **高基数硬白名单**：Images / FileBrowserView / Search / InvoiceCards / InboundCards 玻璃计数**必须为 0**。
 *   3. **材质单点**：`backdrop-filter` 只允许出现在 index.css，任何 .tsx/.ts 里写它都是绕过令牌。
 *   4. **控件与动效红线**：药丸内联串 / `hover:shadow-card-hover` / `transition-all` / `type="date"` 全清零；
 *      `type="number"` 只允许在非金额语义的白名单文件里（金额一律走 MoneyInput，D8 收 6 处）。
 *   5. **读字表面豁免**：`.modal-panel` / `.dlg-*` 必须实底——禁 `backdrop-filter`、禁半透明白底/白描边、
 *      禁头尾分隔线与 ✕ 关闭钮回潮（2026-09-10 弹窗材质回退，PLAN §四；变异验证已确认本条能抓）。
 *   6. **按钮面棘轮（v2.5.8 D13 新增，2026-09-12）**：裸 `<button>` 的材质口径三条——
 *      贴组件档**基态**底色却不**裸挂** `.btn-*` 五档 / 形状具名档 = 单向向下棘轮（D14 压到 0）、
 *      真欠账逐文件基线（手写且未走任何统一档，两张表同存 `__baselines__/ui-button-material.md`；
 *      现值一律以基线文件为准，本注释不抄数——抄一次就漂移一次）、
 *      「整条抄 `.btn-primary`」复刻点位只准缩短（现 3——卡上假设的 0 不成立，见 BTN_PRIMARY_CLONE_EXEMPT 注释）。
 *      判据口径 = `scripts/scan-ui-inventory.mjs` 的标签体解析（本文件不自写第二套扫描），
 *      推理与边界见下文「按钮面棘轮」段注释。
 *
 * 机制与 tests/unit/winBranchInventory.test.ts 同构（同一套 UPDATE / BREAK 环境变量约定）。
 * 背景：PLAN §三 批 2 原句「台账卡基数低 → 玻璃化」的前提已被 v2.5.5 卡片化推翻（现走 VirtualGrid），
 *      这类「文档口径与代码现状漂移」正是本门禁要拦的（见 assets/v2.5.8/D6-类名定位预扫描.md）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')
const BASELINE_PATH = path.join(ROOT, 'tests', 'unit', '__baselines__', 'ui-inventory.md')

const UIINV_UPDATE = process.env.UIINV_UPDATE === '1'
const UIINV_BREAK = process.env.UIINV_BREAK === '1'
const UIINV_BREAK_REASON = process.env.UIINV_BREAK_REASON || ''

/** 高基数面（VirtualGrid 逐行渲染 / 结果数无上限）：玻璃计数必须恒为 0 */
/** 高基数面（VirtualGrid 逐行渲染）：`.card-glass` 计数必须恒为 0。
 *  ⚠ 复审 r2 补两条：`pages/Certs.tsx` 早在 `AGENTS.md` §一.7 就被列为高基数五面之一，
 *  但**本表一直没有它** ⇒ 谁给证书卡加 blur 不会被拦（又一例"文档声称有、机器没钉"）；
 *  `pages/Notes.tsx` 同形（也用 VirtualGrid，页内注释自禁 blur）。两处的 `card-glass` 字样
 *  都只出现在注释里，而 `countByFile` 先去注释再计数 ⇒ 入册零成本。
 *  反例提醒：`Clients`/`Invoices`/`Quotes`/`Suppliers`/`Trash`/`Exports` 计数 >0 且都在**页面骨架**
 *  （非行卡）上，按 09-10「台账行保持实底、骨架卡可上玻璃」的拍板口径**不能**照抄入册，会立刻红。 */
const ZERO_GLASS_FILES = [
  'pages/Images.tsx',
  'pages/Certs.tsx',
  'pages/Notes.tsx',
  'pages/Search.tsx',
  'components/FileBrowserView.tsx',
  'pages/invoices/InvoiceCards.tsx',
  'pages/invoices/InboundCards.tsx',
]

/**
 * 允许挂 `.glass-panel`（blur 16 + 内亮边）的**全部**点位，逐文件钉死（复审 r2 A-3 走 a 路线的机器面）。
 * 这三处是 PLAN §四 显式划进「一眼掠过的面」的浮层/壳层：侧栏、悬浮多选条、下拉弹层。
 * 想往别处（尤其高基数列表卡）再加一处 = 先回 PLAN §四 改红线，再改本表——顺序反过来说明在想绕门禁。
 */
const OVERLAY_GLASS_POINTS: Record<string, number> = {
  'components/Sidebar.tsx': 1,
  'components/ui/SelectionBar.tsx': 1,
  'components/ui/SearchSelect.tsx': 1,
}

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

/* ------------------------------------------------------------------ *
 * 输入框面棘轮（v2.5.8 D14 收口，2026-09-12）——四面逐个指名，没有第五面
 *
 * 为什么改靶子：D13 立项时这条盯的是「手写 .input 材质串」（上面那张表），口径窄到放过了
 * 「描边色 + 圆角」的**非 .input 档**手搓框（7 处真欠账全都从这条旁边溜过去过）。
 * D14 把 7 处收进 `ui/Input`（为此给底座补了 `compact` 与 `autoFocus`）之后，判据换成
 * 清点器的四分类：`debt` 归硬零，其余三面各有一条白名单钉着，谁想混进去都得先改表。
 * 口径纪律：判据必须**枚举式**（读分类），不许退回单条 `grep border-` —— 本卡开头就记着
 * 「只 grep `type="text"` 也恰好得 7」那次两个反向偏差互相抵消的教训。
 * ------------------------------------------------------------------ */

/** 合法持有原生 `<input>` 的底座三处（数 = 每文件命中数，加文件要显式改这张表） */
const INPUT_BASE_INTERNAL: Record<string, number> = {
  'components/ui/Input.tsx': 1,
  'components/ui/SearchSelect.tsx': 1,
  'components/MoneyInput.tsx': 1,
}
/** 显式豁免：文件 → 判据绑的 `id`（改 id = 换点位，本条即红） */
const INPUT_EXEMPT_IDS: Record<string, string> = {
  'components/Header.tsx': 'global-search-input',
}
/** 原生 checkbox 现状基数（站里没有 Switch/Checkbox 底座，收它属另立一批：只准缩，不准涨） */
const INPUT_CHECKBOX_BASE = 12

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

/* ===================================================================== *
 * 按钮面棘轮（v2.5.8 D13，2026-09-12）
 * ===================================================================== */

/**
 * 「挂组件档底色却不走 `.btn-*`」为什么是可机检的**可见缺陷**，而不是结构洁癖：
 *
 * `.btn-primary / .btn-secondary / .btn-danger / .btn-ghost / .btn-ghost-danger` 五档
 * **类定义自带 `active:scale-95`**（`index.css:78-83` + `:184-191`，v2.5.8 W4/D8 那次统一按压节奏，
 * 原注释「原本挂 `active:scale-95` 却只 transition-colors，按压是瞬移」）。于是：
 *  - 走 `btn-*` 的 123 处按钮 **100% 有按压缩放反馈**（反馈住在类定义里，不在调用点 class 上，
 *    所以清点器的 `hasPress` 对这一档取 0 是预期的，别误读成「统一档也没反馈」）；
 *  - 手写串的 147 处 **0 处**有 `active:scale`，其中 79 处连 `transition` 都没挂。
 * 即同一应用里近一半按钮按下去毫无反应。「贴了组件档底色 = 作者想让它长得像主/次/危险按钮」
 * 这个意图，恰好就把缺失的按压反馈一起暴露出来 ⇒ 「底色 ⇒ 必须走 `btn-*`」是一条精准拦真缺陷的判据。
 */

/** 按钮面棘轮基线（与玻璃点位分开一份文件：语义不同、下调节奏也不同） */
const BTN_BASELINE_PATH = path.join(ROOT, 'tests', 'unit', '__baselines__', 'ui-button-material.md')

/**
 * 按钮面的「底座内部」白名单（与输入框面 `INPUT_BASE_INTERNAL` 同一设计，2026-09-12 D14 收口时定）。
 *
 * 为什么需要这一格：`ui/Button` 的 class 是 `${VARIANT_MAP[...]}` 拼出来的、`ui/SearchSelect` 的
 * 选项行与触发器、`ui/SelectionBar` 的 `SELECTION_*_CLASS` 常量表——**底座自己就得写材质**，
 * 把它们算进「页面真欠账」会让 D14 的出口（欠账清零）永远达不成，也会让棘轮表里常年挂着 5 行改不掉的数。
 * 反面风险也明摆着：整目录放行 = 一张空白支票。所以判据照「原生 `<select>` 只准住在 ui/Select」那条：
 * **点名文件 + 钉死每文件计数**，新增/减少都要显式改表；目录前缀只由清点器用来打 `inBase` 标，
 * 本表负责把"到底哪几处"锁住（两处任一漂移即红）。
 */
const BTN_BASE_INTERNAL: Record<string, number> = {
  'components/ui/Button.tsx': 1,
  'components/ui/SearchSelect.tsx': 2,
  'components/ui/SelectionBar.tsx': 2,
}

/**
 * 「把 `.btn-primary` 整条抄进页面」的判据 = 同一条 class 里同时出现
 * 组件档底色 `bg-primary-600` + 尺寸档 `px-4` + `py-2`（`index.css:78-79` 的 md 档规格）。
 *
 * 卡上「现在就为 0」的前提**当时不成立**：立项实测 3 处，全在 `pages/Profile.tsx`
 * （`:186` / `:290` / `:375`——`bg-primary-600 px-4 py-2 … hover:bg-primary-700` 且只挂
 * `transition-colors`，正是「按下去没反应」那一类）。硬零判据一旦被「按现状钉成 3」就失去意义，
 * 所以当时登记成**只准缩短的显式债务表**。
 *
 * **v2.5.8 D14 收口：3 处已全部改挂 `.btn-primary`，本表清空、上限归 0 ⇒ 判据回到真·硬零。**
 * 表和上限这两个声明留着不删，是为了让"将来某处确有正当理由要豁免"时有一条显式、可审的路；
 * 任何往里加条目 = 必须先过主线程，且同时要调 `BTN_PRIMARY_CLONE_TOTAL_CAP`（两处一起动才不红）。
 */
const BTN_PRIMARY_CLONE_EXEMPT: Record<string, number> = {}

/**
 * 债务表总量上限。**只准缩向 0，禁止调大**——把 `BTN_PRIMARY_CLONE_EXEMPT` 改大来「凑现值」
 * 是唯一还能绕过①的方式，这里一并红掉（要调大需主线程拍板并在此行上方留理由）。
 * 现值 0 = 卡上原本要求的硬零。
 */
const BTN_PRIMARY_CLONE_TOTAL_CAP = 0

/** 棘轮方向提示的收集器：数变小 = 改进，但基线**不自动跟码漂移**，最后一条用例据此要求显式落账 */
const RATCHET_STALE: string[] = []

/** 清点器返回值的类型面（与 tests/unit/uiScan.test.ts 同一份，那边钉的是计数、这边钉的是点位） */
interface BtnHit {
  file: string
  line: number
  classText: string | null
  category: 'unified' | 'handwritten' | 'noclass' | 'other'
  /** 住在底座目录里（`components/ui/` + `MoneyInput.tsx`）：实现内部，见 `BTN_BASE_INTERNAL` 注释 */
  inBase: boolean
  hasComponentTint: boolean
  tintTokens: string[]
  hasPress: boolean
  hasTransition: boolean
}
interface InputHit {
  file: string
  line: number
  type: string | null
  typeId: string | null
  classText: string | null
  material: boolean
  category: 'checkbox' | 'baseInternal' | 'exempt' | 'debt' | 'other'
}
interface BtnScan {
  buttons: BtnHit[]
  inputs: InputHit[]
  summary: {
    buttons: { total: number; unified: number; handwritten: number; noclass: number }
    inputs: { total: number; checkbox: number; baseInternal: number; debt: number; exempt: number; other: number }
  }
}

/**
 * 口径唯一来源 = `scripts/scan-ui-inventory.mjs` 的 `collectUiInventory`（解析 JSX 标签体：
 * 跨行、引号与花括号感知、先原位剥注释）。本文件**不再自写一套 `<button` 截断扫描**——
 * 按行/在第一个 `>` 处收口的扫描会把 `components/ui/SearchSelect.tsx:211`（class 写在
 * `ref={(el) => { … }}` 的 `>` 之后）误读成「没有 class」，实测正是 146/1 与 147/0 两个口径的唯一差。
 * 非字面量 specifier 的写法同 uiScan.test.ts（清点器是 .mjs，避免 tsc 报 TS7016）。
 */
const scannerUrl = pathToFileURL(path.join(ROOT, 'scripts', 'scan-ui-inventory.mjs')).href
const { collectUiInventory } = (await import(scannerUrl)) as {
  collectUiInventory: (opt?: { root?: string }) => BtnScan
}
const BTN_SRC_PREFIX = 'src/renderer/src/'
/** 全站只解析一次（按钮面与输入框面共用同一份产物，防两套口径） */
const uiscan: BtnScan = collectUiInventory({ root: ROOT })
const btnHits: BtnHit[] = uiscan.buttons
/** 基线里的路径口径与本文件其余断言一致（相对 `src/renderer/src`） */
const btnFile = (b: BtnHit): string => (b.file.startsWith(BTN_SRC_PREFIX) ? b.file.slice(BTN_SRC_PREFIX.length) : b.file)
/** 报错要能直接指到 file:line 与那一处 class 片段——「expected 34 <= 33」这种没有信息量 */
const btnWhere = (b: BtnHit): string =>
  `${btnFile(b)}:${b.line} 「${(b.classText ?? '（无 class）').replace(/\s+/g, ' ').trim().slice(0, 110)}」`
/** 违规清单只列前若干处：超基线时全量倒 35 行会把人淹死，但一条都不能少地可追（完整清单跑清点脚本） */
const head = (list: string[], n = 12): string =>
  list.slice(0, n).join('\n') + (list.length > n ? `\n  …另有 ${list.length - n} 处（完整清单：node scripts/scan-ui-inventory.mjs）` : '')

/**
 * class 里有没有**裸** `btn-*` token。
 * 清点器判 `unified` 用的是 `\bbtn-…`，`hover:btn-primary` 这种「变体前缀后」也算命中——
 * 那等于「只在悬停时套统一档」，照常可以顺手贴一份 `bg-primary-600`，绕过主判据。
 * 本站现在这类写法 0 处（`uiScan.test.ts` 钉的是清点器口径，不改它），但本门禁按**裸 token**收紧：
 * 只有真正挂了五档之一才算统一档。
 */
const BARE_BTN_CLASS = /(^|[\s"'`{])btn-(?:primary|secondary|danger|ghost|ghost-danger)([\s"'`}]|$)/
/**
 * 形状具名档的**裸** token（口径同 `BARE_BTN_CLASS`：变体前缀后不算，防 `hover:icon-btn` 式蹭档）。
 * 挂上这三档 = 颜色本就由调用点给（档只管节奏），此时 tint 判据必须闭嘴：
 * 「基态透明、悬停才上色」是 `.row-btn` / `.link-btn` 唯一合法的贴色方式，不是绕开统一档。
 * 与清点器 `hasComponentTint` 的放宽同步生效——两条缺一条，D14 有约 16 处永远洗不到 0。
 * 不会因此放过真违规：未走任何档的裸底色仍由本条与逐文件手写基线两处抓。
 */
const BARE_SHAPE_CLASS = /(^|[\s"'`{])(?:link-btn|icon-btn|row-btn|seg-item|seg-item-on|chip)([\s"'`}]|$)/
/** 主判据的违规位 = 贴了组件档**基态**底色、既没裸挂五档也没裸挂形状档、且不在底座内部（比清点器的 hasComponentTint 更严一格） */
const isTintViolation = (b: BtnHit): boolean =>
  b.tintTokens.length > 0 && !b.inBase && !BARE_BTN_CLASS.test(b.classText ?? '') && !BARE_SHAPE_CLASS.test(b.classText ?? '')
const tintHits: BtnHit[] = btnHits.filter(isTintViolation)
/**
 * 逐文件棘轮数的必须是**真欠账**（页面/业务组件侧手写且未走任何统一档），不是 `category === 'handwritten'`。
 * 三条收窄，每条都有实测理由：
 *  ① 排除形状具名档：形状档在清点器口径里仍归 handwritten（它确实不是 `btn-*` 五档），照原写法把 141 处
 *     收进 `.link-btn`/`.icon-btn`/`.row-btn` 之后这张表**纹丝不动**，"压到 0"永远达不成——
 *     与 `summary.buttons.debt` 同一判据，量尺才认得出"改好了"；
 *  ② 排除底座内部（`BTN_BASE_INTERNAL` 另有专条逐文件钉死）：底座不写材质就没法给别人提供材质；
 *  ③ 只认**裸** token（`BARE_*`）：`hover:btn-primary` 式蹭档不算已统一。
 */
const handHits = btnHits.filter(
  (b) =>
    b.category === 'handwritten' &&
    !b.inBase &&
    !BARE_BTN_CLASS.test(b.classText ?? '') &&
    !BARE_SHAPE_CLASS.test(b.classText ?? ''),
)
const handwrittenByFile: Record<string, number> = {}
for (const b of handHits) handwrittenByFile[btnFile(b)] = (handwrittenByFile[btnFile(b)] ?? 0) + 1

/** class 里同时出现 `bg-primary-600` 与 `px-4` 与 `py-2` = `.btn-primary` 被整条抄了一份 */
function isBtnPrimaryClone(b: BtnHit): boolean {
  const c = b.classText ?? ''
  return b.tintTokens.includes('bg-primary-600') && /(^|[\s"'`{])px-4([\s"'`}]|$)/.test(c) && /(^|[\s"'`{])py-2([\s"'`}]|$)/.test(c)
}
const cloneHits = btnHits.filter(isBtnPrimaryClone)

interface BtnBaseline {
  tint: number
  hand: Record<string, number>
  tintByFile: Record<string, number>
}
function readBtnBaseline(): BtnBaseline | null {
  if (!fs.existsSync(BTN_BASELINE_PATH)) return null
  let section = ''
  let tint = -1
  const hand: Record<string, number> = {}
  const tintByFile: Record<string, number> = {}
  for (const line of fs.readFileSync(BTN_BASELINE_PATH, 'utf8').split('\n')) {
    const t = line.trim()
    if (/^\[\w+\]$/.test(t)) {
      section = t.slice(1, -1)
      continue
    }
    if (!t || t.startsWith('#') || t.startsWith('<!--')) continue
    const c = /^count:\s*(\d+)$/.exec(t)
    if (c && section === 'tint') {
      tint = Number(c[1])
      continue
    }
    if (section !== 'handwritten') continue
    // 一行一文件两列：`- 文件 | 手写裸 button 数 | 其中贴档底色数`（第三列缺省读 0）
    const m = /^- (.+?)\s*\|\s*(\d+)\s*(?:\|\s*(\d+)\s*)?$/.exec(t)
    if (!m) continue
    hand[m[1]] = Number(m[2])
    tintByFile[m[1]] = Number(m[3] ?? 0)
  }
  return tint < 0 ? null : { tint, hand, tintByFile }
}

/** 落盘：一行一文件、路径升序（明天 D14 逐档下调时 diff 只碰真正变了的那几行） */
function writeBtnBaseline(hand: Record<string, number>, tint: Record<string, number>): void {
  const files = Array.from(new Set([...Object.keys(hand), ...Object.keys(tint)])).sort((a, b) => a.localeCompare(b))
  const body = files.map((f) => `- ${f} | ${hand[f] ?? 0} | ${tint[f] ?? 0}`).join('\n')
  const tintTotal = Object.values(tint).reduce((n, c) => n + c, 0)
  fs.writeFileSync(
    BTN_BASELINE_PATH,
    `<!-- 渲染层按钮面材质棘轮基线（v2.5.8 D13，2026-09-12） -->\n` +
      `<!-- tests/unit/uiInventory.test.ts 读取；更新：UIINV_UPDATE=1 npx vitest run tests/unit/uiInventory.test.ts -->\n` +
      `<!-- 棘轮单向向下：任一文件任一列超基线即红；数变小**不**自动跟码漂移，必须跑上面那条显式落账。终值 = 0 / 空表（D14 逐档收 .btn-*）。 -->\n` +
      `\n[tint]\n` +
      `# 全站：裸 <button> 贴组件档**基态**底色（bg-primary-600 / bg-surface-100 / bg-danger-600）\n` +
      `# 却不裸挂 .btn-* 五档、也不挂形状具名档的处数（变体前缀如 hover:bg-* 不算；底座内部另有 BTN_BASE_INTERNAL 钉死）\n` +
      `count: ${tintTotal}\n` +
      `\n[handwritten]\n` +
      `# 列 = 文件 | 真欠账裸 <button>（既不走 .btn-* 五档、也不走形状具名档）处数 | 其中贴组件档基态底色处数\n` +
      `# 口径 = scripts/scan-ui-inventory.mjs 标签体解析；路径相对 src/renderer/src；清零的文件由 UPDATE 时自动摘掉\n` +
      body +
      `\n`,
  )
}

/** 逐文件贴档底色计数（= 基线第三列；底座内部不计，由 `BTN_BASE_INTERNAL` 那条单独钉死） */
const tintByFile: Record<string, number> = {}
for (const b of tintHits) {
  tintByFile[btnFile(b)] = (tintByFile[btnFile(b)] ?? 0) + 1
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

  /**
   * 浮层玻璃点位基线（v2.5.8 复审 r2 A-3 的处置 = 用户拍的 **a 路线**）。
   *
   * 背景：`.glass-panel`（blur 16 + 内亮边）目前只允许出现在**三处浮层/壳层**上——
   *   侧栏、悬浮多选条、SearchSelect 弹层。PLAN §四 的读字表面红线把这三处显式划在
   *   「一眼掠过的面」一侧（≪30% 视口、不常驻高基数列表上方），所以它们**合法**。
   * 但"合法"此前只在人心里，机器没管：谁能给 VirtualGrid 的卡片再挂一层 glass-panel 不会被拦。
   * 本条把它变成**点名 + 钉死计数**的基线（口径同 ZERO_GLASS_FILES，方向相反：那边是必须为 0，
   * 这边是"只准是这几个、这几个里只准这个数"）。要新增点位 = 必须先回 PLAN §四 改红线再改本表。
   * 附带的第二道闸：`backdrop-filter` 本身仍只准住在 index.css（下一条），本表管的是"谁在用档"。
   */
  it('浮层玻璃（.glass-panel）点位与基线逐文件一致（a 路线：允许三处，防长成大块玻璃）', () => {
    const hits = countByFile('glass-panel', codeFiles())
    expect(hits, `.glass-panel 点位漂移（现 ${JSON.stringify(hits)}，基线 ${JSON.stringify(OVERLAY_GLASS_POINTS)}）——新增浮层玻璃要先改 PLAN §四 红线`).toEqual(OVERLAY_GLASS_POINTS)
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
   * D14 出口判据。四面 = `debt`（硬零）/ `other`（恒零）/ 底座三处（点名）/ 顶栏豁免（绑 id）/
   * checkbox（只准缩）——每一条都读**分类**，不读 grep 命中数，所以「换个写法绕过去」的下一步
   * 一定是先撞进 `other`，而不是静默通过。
   */
  it('输入框面棘轮：页面侧手搓材质文本框清零（debt 硬零），其余四面逐个指名', () => {
    const rel = (p: string): string => (p.startsWith(BTN_SRC_PREFIX) ? p.slice(BTN_SRC_PREFIX.length) : p)
    const inputs = uiscan.inputs
    const where = (x: InputHit): string => `${rel(x.file)}:${x.line} type=${x.type ?? '（省写=text）'} 「${(x.classText ?? '（无 class）').replace(/\s+/g, ' ').trim().slice(0, 90)}」`

    // ① 真欠账 = 硬零（D13 立项 7 处：Settings×3 / Clients / ProductSets / PdfPreview / Search，全部收进 ui/Input）
    const debt = inputs.filter((x) => x.category === 'debt')
    expect(
      debt.map(where).join('\n'),
      '页面/业务组件里又手写了输入框材质（同一条 class 里既重述描边色又重述圆角）——改用 ui/Input / ui/Textarea，缺 props 就补底座（compact 与 autoFocus 就是这么补出来的），别绕开它',
    ).toBe('')

    // ② 口径外恒零：新增任何一类原生 input（radio / range / 裸文本框…）先红在这里，而不是从 debt 旁边溜走
    const other = inputs.filter((x) => x.category === 'other')
    expect(
      other.map(where).join('\n'),
      '出现清点器四分类之外的 <input> 点位：先给 scripts/scan-ui-inventory.mjs 补分类并说明收法，再动产品代码',
    ).toBe('')

    // ③ 底座内部点名（防「换个文件名就把绕过点藏进底座」）
    const baseByFile: Record<string, number> = {}
    for (const x of inputs.filter((i) => i.category === 'baseInternal')) baseByFile[rel(x.file)] = (baseByFile[rel(x.file)] ?? 0) + 1
    expect(baseByFile, `底座内部点位集合变了（现 ${JSON.stringify(baseByFile)}，白名单 ${JSON.stringify(INPUT_BASE_INTERNAL)}）——要加新底座请显式改表`).toEqual(INPUT_BASE_INTERNAL)

    // ④ 唯一显式豁免 = 顶栏搜索框，判据绑 id
    const exempt = inputs.filter((x) => x.category === 'exempt')
    expect(exempt.map((x) => rel(x.file)).sort(), `豁免点位集合漂移（现 ${exempt.map((x) => `${rel(x.file)}:${x.line}`).join(', ')}）`).toEqual(Object.keys(INPUT_EXEMPT_IDS).sort())
    for (const x of exempt) {
      expect(INPUT_EXEMPT_IDS[rel(x.file)], `${rel(x.file)}:${x.line} 的豁免判据是 id=${x.typeId}，与表里 ${INPUT_EXEMPT_IDS[rel(x.file)]} 不符——改了 id 就是换了点位，要重新审视` ).toBe(x.typeId)
    }

    // ⑤ 原生 checkbox 只准缩不准涨（站里没有 Checkbox 底座；收它属另立一批，见 D15 候选）
    const cb = inputs.filter((x) => x.category === 'checkbox')
    expect(cb.every((x) => x.type === 'checkbox'), '归进 checkbox 面的点位必须真写着 type="checkbox"（防借类别混进别的控件）').toBe(true)
    expect(cb.length <= INPUT_CHECKBOX_BASE, `原生 checkbox 从基线 ${INPUT_CHECKBOX_BASE} 涨到 ${cb.length}——要加新形状先立底座，别继续手搓`).toBe(true)
    if (cb.length < INPUT_CHECKBOX_BASE) RATCHET_STALE.push(`[input-checkbox] 原生 checkbox 已降到 ${cb.length}（基线 ${INPUT_CHECKBOX_BASE}）——显式下调 INPUT_CHECKBOX_BASE`)
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

  /* ------------------------------------------------------------------ *
   * 按钮面棘轮（v2.5.8 D13，2026-09-12）——判据设计见上方「按钮面棘轮」段注释
   * ------------------------------------------------------------------ */

  /**
   * 主判据。为什么钉的是「底色」而**不是**「必须用 `ui/Button` 组件」：
   * `ui/Button` 只有 5 个 variant + sm/md 两档尺寸，而站里客观存在**四种本就不该套它的形状**——
   * tab / 侧栏整行 / 图标钮 / chip（强行统一会逼出一次性 props，见调研 §五.2 的反面）。
   * 但「按压反馈缺失」这个真缺陷恰好只发生在**贴了组件档底色**的那批手写按钮上
   * （底色 = 作者想让它长得像主/次/危险按钮），所以「底色 ⇒ 必须走 `.btn-*` 五档」
   * 既拦得住真缺陷、又放过上面那四种形状——这就是判据的边界，收窄一分则漏、放宽一分则误伤。
   * `.btn-*` 是 CSS 类不是组件，所以本条不禁止 `<button class="btn-primary …">` 这种
   * 「裸元素 + 统一档」写法（站里 123 处即此），明天 D14 若换 `ui/Button` 也不与本条冲突。
   */
  it('按钮面棘轮：裸 <button> 贴组件档底色必须走 .btn-* 五档（单向向下，终值 0）', () => {
    if (UIINV_UPDATE) {
      writeBtnBaseline(handwrittenByFile, tintByFile)
      return
    }
    const base = readBtnBaseline()
    expect(base, `按钮面基线缺失或损坏——先跑 UIINV_UPDATE=1 生成 ${path.relative(ROOT, BTN_BASELINE_PATH)}`).not.toBeNull()
    // 底座内部**双向点名**：清点器只按目录前缀打 `inBase` 标记，"到底是哪几处"由这张表锁死——
    // 往 `components/ui/` 里新加一处手写按钮（表里没有）= 红；改掉一处不清表 = 也红。
    // 同「原生 `<select>` 只准住在 ui/Select、计数钉死 1」那条口径。
    const inBaseByFile: Record<string, number> = {}
    for (const b of btnHits) {
      if (
        !b.inBase ||
        b.category !== 'handwritten' ||
        BARE_BTN_CLASS.test(b.classText ?? '') ||
        BARE_SHAPE_CLASS.test(b.classText ?? '')
      )
        continue
      inBaseByFile[btnFile(b)] = (inBaseByFile[btnFile(b)] ?? 0) + 1
    }
    expect(
      inBaseByFile,
      `底座内部手写按钮集合漂移（现 ${JSON.stringify(inBaseByFile)}，白名单 ${JSON.stringify(BTN_BASE_INTERNAL)}）——改底座材质可以，但要显式改这张表并写下理由，别拿目录前缀当通行证`,
    ).toEqual(BTN_BASE_INTERNAL)
    // 基线自身一致性：count 行必须等于逐文件表第三列之和（防手改基线只改了一处 → 两张皮）
    const baseTotal = Object.values(base!.tintByFile).reduce((n, c) => n + c, 0)
    expect(base!.tint, `基线文件自相矛盾：[tint] count=${base!.tint} 而逐文件第三列之和=${baseTotal}——跑 UIINV_UPDATE=1 重生成`).toBe(baseTotal)
    // 逐文件棘轮（不只钉总数：否则「A 页新增一处 + B 页顺手删一处」总数不动就能蒙过去）
    const over = Object.entries(tintByFile).filter(([f, c]) => c > (base!.tintByFile[f] ?? 0))
    const lines: string[] = []
    if (over.length > 0) {
      const curTotal = Object.values(tintByFile).reduce((n, c) => n + c, 0)
      lines.push(
        `贴档底色的裸 <button> 超基线：${over.length} 个文件越线，全站现 ${curTotal} 处 / 基线 ${base!.tint} 处`,
        `请改用 .btn-primary / .btn-secondary / .btn-danger / .btn-ghost / .btn-ghost-danger 之一——五档类定义自带 active:scale-95，手写串按下去没有缩放反馈：`,
      )
      for (const [f, c] of over) {
        lines.push(`  ${f}：${c} 处 > 基线 ${base!.tintByFile[f] ?? 0} 处`)
        lines.push(head(tintHits.filter((b) => btnFile(b) === f).map((b) => '    ' + btnWhere(b))))
      }
    }
    expect(lines.join('\n'), '新增按钮材质违规').toBe('')
    if (over.length === 0) {
      const curTotal = Object.values(tintByFile).reduce((n, c) => n + c, 0)
      if (curTotal < base!.tint) RATCHET_STALE.push(`[tint] 贴档底色已降到 ${curTotal}（基线 ${base!.tint}）——跑 UIINV_UPDATE=1 下调`)
      for (const [f, c] of Object.entries(base!.tintByFile)) {
        if (c > 0 && (tintByFile[f] ?? 0) === 0) RATCHET_STALE.push(`[tint] ${f} 的贴档底色已清零，基线第三列还留着 ${c}——跑 UIINV_UPDATE=1 下调`)
      }
    }
  })

  /**
   * 手写串逐文件基线（D14 逐档下调的工作清单）。
   * 逐文件而不只看全站总数：总数棘轮可以「在 A 页补一个、在 B 页删一个」蒙过去，
   * 按文件钉死后**任何页面新增一个不走五档的裸 `<button>` 都会红**——这才堵住「新页面手搓按钮」。
   * 注：`components/ui/` 下的手写位一并入表（底座本体也要数），只有**底色判据**豁免底座。
   */
  it('按钮面棘轮：手写 .btn-* 之外的裸 button 逐文件不得超基线（D14 工作清单）', () => {
    if (UIINV_UPDATE) {
      writeBtnBaseline(handwrittenByFile, tintByFile)
      return
    }
    const base = readBtnBaseline()
    expect(base, '按钮面基线缺失——先跑 UIINV_UPDATE=1 生成').not.toBeNull()
    const lines: string[] = []
    for (const [f, c] of Object.entries(handwrittenByFile)) {
      const limit = base!.hand[f] ?? 0
      if (c > limit) {
        lines.push(`  ${f}：手写裸 button ${c} 处 > 基线 ${limit} 处`)
        lines.push(head(handHits.filter((b) => btnFile(b) === f).map((b) => '    ' + btnWhere(b))))
      }
    }
    expect(
      lines.join('\n'),
      '新增手写按钮材质（该页请走 .btn-* 五档或 ui/Button；tab / 侧栏整行 / 图标钮 / chip 四种异形状不在本条禁止面内——但贴了组件档底色就被上一条拦住）',
    ).toBe('')
    const curTotal = Object.values(handwrittenByFile).reduce((n, c) => n + c, 0)
    const baseTotal = Object.values(base!.hand).reduce((n, c) => n + c, 0)
    if (curTotal < baseTotal) RATCHET_STALE.push(`[handwritten] 手写按钮已降到 ${curTotal}（基线 ${baseTotal}）——跑 UIINV_UPDATE=1 下调`)
    for (const [f, c] of Object.entries(base!.hand)) {
      if (c > 0 && (handwrittenByFile[f] ?? 0) === 0) {
        RATCHET_STALE.push(`[handwritten] ${f} 已清零，基线表里还留着 ${c}——跑 UIINV_UPDATE=1 摘掉条目`)
      }
    }
  })

  /**
   * 材质复刻判据：`bg-primary-600` + `px-4` + `py-2` 同串 = `.btn-primary` 被整条抄进页面。
   * 见上方 `BTN_PRIMARY_CLONE_EXEMPT` 注释——立项实测 3 处（全在 Profile.tsx）、当时已停下上报，
   * **D14 收口后回到硬零**：命中必须恰好 0 处，登记表与总量上限都是 0。
   */
  it('材质复刻：抄 .btn-primary 整条（bg-primary-600 + px-4 + py-2）= 硬零（D14 已收口，只准 0）', () => {
    const byFile: Record<string, number> = {}
    for (const b of cloneHits) byFile[btnFile(b)] = (byFile[btnFile(b)] ?? 0) + 1
    // ① 判据可机检：命中集合必须**恰好**等于登记表，多一个（新页抄了一份）、少一个（修掉了没清表）都红
    expect(
      Object.entries(byFile).filter(([f]) => !(f in BTN_PRIMARY_CLONE_EXEMPT)),
      `又抄了一份 .btn-primary（走 .btn-primary 即可，五档自带 active:scale-95 按压）：${cloneHits
        .filter((b) => !(btnFile(b) in BTN_PRIMARY_CLONE_EXEMPT))
        .map((b) => btnWhere(b))
        .join(' | ')}`,
    ).toEqual([])
    for (const [f, c] of Object.entries(BTN_PRIMARY_CLONE_EXEMPT)) {
      expect(
        byFile[f] ?? 0,
        `复刻点位 ${f} 现 ${byFile[f] ?? 0} 处，登记表 ${c} 处——同文件里再多抄一处即绕过本门禁，只准改小并同步此表`,
      ).toBe(c)
    }
    // ② 登记表**只准缩短**：把 BTN_PRIMARY_CLONE_EXEMPT 改大来凑现值 = 绕过，红在这里
    const curTotal = Object.values(byFile).reduce((n, c) => n + c, 0)
    const regTotal = Object.values(BTN_PRIMARY_CLONE_EXEMPT).reduce((n, c) => n + c, 0)
    expect(
      curTotal <= BTN_PRIMARY_CLONE_TOTAL_CAP && regTotal <= BTN_PRIMARY_CLONE_TOTAL_CAP,
      `复刻债务表上限 ${BTN_PRIMARY_CLONE_TOTAL_CAP} 处（现 命中 ${curTotal} / 登记 ${regTotal}）——本表只准缩向 0，调上限需主线程拍板并在卡上记一笔`,
    ).toBe(true)
  })

  /**
   * 棘轮只准**显式**下调。上面任何一条发现「数变小了 / 条目清零了 / 债务表该缩了」都不直接把基线改掉，
   * 而是攒到这里红一次：基线跟着代码静默漂移 = 门禁形同虚设（本仓 `UIINV_UPDATE=1` 的一贯口径）。
   */
  it('棘轮卫生：基线只准显式下调（上面出现「请跑 UIINV_UPDATE=1」的提示，本条即红）', () => {
    if (UIINV_UPDATE) return
    expect(RATCHET_STALE.join('\n'), '基线已可下调，请显式落账后再提交').toBe('')
  })
})
