/**
 * 计算解析器（v2.5.9/A7「计算」）
 *
 * 纯函数模块，双端共享、无 Electron 依赖（node 直测）。权威文档：
 * `docs/INTERNAL/PLAN-v2.6-计算.md` §二（规格冻结：四则 + 括号 + % + 日期，之外一律不加）
 * 与 §六（解析器设计：手写 tokenizer + 递归下降，零第三方依赖）。
 *
 * 规格要点（与 §二 逐条对应，改动前先改文档）：
 * - 输入收 ASCII `*` `/`，显示渲染成 `×` `÷`（`renderExpression`）；输入侧同时认 `×` `÷`，
 *   这样「点算式回填输入框」原样贴回也能再算（回填的是显示态）。
 * - `%` 四条：`A+B%`=A×(1+B/100)、`A-B%`=A×(1-B/100)、`A×B%`=A×B/100、裸 `B%`=B/100。
 *   实现上用「percent 标记」表达：后缀 % 既除以 100 又打标记；加减法见到右操作数带标记才走
 *   相对口径；乘除/括号/一元正负只是把它当数值传递（`100+10%*2` 里 `10%*2` 已不带标记）。
 * - 日期三形态：`日期±数`、`日期−日期`；日期与数字的其余混算一律语法错（`日期×2` 不猜）。
 * - 容错只有三条：任意空格；结尾多按的二元运算符自动忽略；除零给温和提示。
 */

export type CalcErrorKind = 'syntax' | 'divide-by-zero' | 'invalid-date'
export type CalcResultKind = 'number' | 'date'

export interface CalcSuccess {
  ok: true
  kind: CalcResultKind
  /** number → 原始数值；date → 'YYYY-MM-DD' */
  value: number | string
  /** 展示态结果：数字 = 千分位两位小数；日期 = YYYY-MM-DD */
  display: string
  /** 展示态算式（× ÷ 渲染 + 规整空格） */
  expression: string
}

export interface CalcFailure {
  ok: false
  error: CalcErrorKind
  message: string
}

export type CalcEvalResult = CalcSuccess | CalcFailure

/** 错误三态文案（面板内温和提示，不落账、不崩） */
export const CALC_ERROR_MESSAGES: Record<CalcErrorKind, string> = {
  syntax: '算式没看懂',
  'divide-by-zero': '除数不能为 0',
  'invalid-date': '这个日期不存在',
}

// —— 内部值模型 ——

type NumVal = { kind: 'num'; n: number; percent: boolean }
type DateVal = { kind: 'date'; y: number; m: number; d: number }
type Val = NumVal | DateVal

function num(n: number, percent = false): NumVal {
  return { kind: 'num', n, percent }
}

// —— tokenizer ——

type Tok =
  | { t: 'num'; v: number }
  | { t: 'date'; y: number; m: number; d: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: '%' }
  | { t: '(' }
  | { t: ')' }

class CalcError extends Error {
  constructor(readonly kind: CalcErrorKind) {
    super(CALC_ERROR_MESSAGES[kind])
  }
}

/**
 * 日期字面量：`\d{4}-\d{1,2}-\d{1,2}`（月份/日放 1–2 位是刻意的——`2026-9-16` 是手敲日期
 * 的常见形态，若按 `\d{2}` 严格匹配它会被静默算成 `2026 - 9 - 16` 的减法，属于「看起来算了
 * 个数字」的坏答案；代价是 `1234-5-6` 这类四位数减法的罕见输入会被当日期，见 §六 口径）。
 * 月份/日范围与真实日期合法性在 parseAtom 里校验（报 invalid-date）。
 */
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?![\d.,])/

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function tokenize(input: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u3000') {
      i += 1
      continue
    }
    if (isDigit(c)) {
      const dm = DATE_RE.exec(input.slice(i))
      if (dm) {
        toks.push({ t: 'date', y: Number(dm[1]), m: Number(dm[2]), d: Number(dm[3]) })
        i += dm[0].length
        continue
      }
      let j = i
      let seenDot = false
      while (j < input.length) {
        const ch = input[j]
        if (isDigit(ch) || ch === ',') {
          j += 1
          continue
        }
        if (ch === '.' && !seenDot) {
          seenDot = true
          j += 1
          continue
        }
        break
      }
      const raw = input.slice(i, j).replace(/,/g, '') // 千分位逗号宽容剔除
      if (raw === '.' || raw === '') throw new CalcError('syntax')
      toks.push({ t: 'num', v: Number(raw) })
      i = j
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      toks.push({ t: 'op', v: c })
      i += 1
      continue
    }
    if (c === '×') {
      toks.push({ t: 'op', v: '*' })
      i += 1
      continue
    }
    if (c === '÷') {
      toks.push({ t: 'op', v: '/' })
      i += 1
      continue
    }
    if (c === '%') {
      toks.push({ t: '%' })
      i += 1
      continue
    }
    if (c === '(') {
      toks.push({ t: '(' })
      i += 1
      continue
    }
    if (c === ')') {
      toks.push({ t: ')' })
      i += 1
      continue
    }
    throw new CalcError('syntax')
  }
  // 容错第二条：结尾多按的二元运算符自动忽略（`1+2+` = 3、`5*` = 5、`1+2++` = 3）。
  // 只剔二元运算符，不动 `%`——`10%` 的 % 是后缀不是「多按」。
  while (toks.length > 0) {
    const last = toks[toks.length - 1]
    if (last.t === 'op') toks.pop()
    else break
  }
  return toks
}

// —— 日期工具（本地时区口径，不引 dayjs） ——

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

function addDays(y: number, m: number, d: number, n: number): DateVal {
  const dt = new Date(y, m - 1, d + n)
  return { kind: 'date', y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() }
}

/** 日期 − 日期 = 天数。走 UTC 归一化差值，避开夏令时造成的非整数天 */
function dayDiff(a: DateVal, b: DateVal): number {
  const A = Date.UTC(a.y, a.m - 1, a.d)
  const B = Date.UTC(b.y, b.m - 1, b.d)
  return Math.round((A - B) / 86400000)
}

// —— 格式化与展示态渲染 ——

/** 数字展示：千分位两位小数（全仓既有惯例，toLocaleString zh-CN） */
export function formatCalcNumber(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatCalcDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * 展示态算式：`*`→`×`、`/`→`÷`，并把空格规整成「二元运算符两侧一个空格、
 * 一元运算符贴住操作数、括号内外不留空格、`%` 贴住前一 token」。
 * 走 token 而不是字符串替换，是为了不把日期里的 `-` 拆坏（`2026-09-16` 必须整块）。
 * tokenize 失败（半敲状态如 `1+abc`）时退回「收空格 + 换符号」的简单渲染，保证输入栏回显不崩。
 */
export function renderExpression(input: string): string {
  let toks: Tok[]
  try {
    toks = tokenize(input)
  } catch {
    return input.trim().replace(/\s+/g, ' ').replace(/\*/g, '×').replace(/\//g, '÷')
  }
  const tokText = (tk: Tok): string => {
    switch (tk.t) {
      case 'num':
        return String(tk.v)
      case 'date':
        return formatCalcDate(tk.y, tk.m, tk.d)
      case 'op':
        return tk.v === '*' ? '×' : tk.v === '/' ? '÷' : tk.v
      case '%':
        return '%'
      case '(':
        return '('
      case ')':
        return ')'
    }
  }
  let out = ''
  let prev: Tok | undefined
  let prevOpUnary = false
  for (let idx = 0; idx < toks.length; idx += 1) {
    const tk = toks[idx]
    const unary = tk.t === 'op' && (idx === 0 || prev === undefined || prev.t === 'op' || prev.t === '(')
    if (out !== '') {
      const glue =
        tk.t === '%' || // % 贴前一 token（100 + 10%）
        tk.t === ')' || // 右括号贴前
        (prev !== undefined && prev.t === '(') || // 左括号贴后
        (prev !== undefined && prev.t === 'op' && prevOpUnary) // 一元正负号贴后（3 × -2）
      if (!glue) out += ' '
    }
    out += tokText(tk)
    prev = tk
    prevOpUnary = unary
  }
  return out
}

// —— 解析 + 求值（递归下降，边解析边求值） ——

class Parser {
  private i = 0
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i]
  }

  private next(): Tok | undefined {
    return this.toks[this.i++]
  }

  parse(): Val {
    if (this.toks.length === 0) throw new CalcError('syntax')
    const v = this.expr()
    if (this.i !== this.toks.length) throw new CalcError('syntax')
    return v
  }

  /** 加减层；日期三种形态在这一层裁决 */
  private expr(): Val {
    let left = this.term()
    for (;;) {
      const tk = this.peek()
      if (!tk || tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) break
      this.next()
      const right = this.term()
      left = this.addSub(left, right, tk.v === '+')
    }
    return left
  }

  private addSub(left: Val, right: Val, plus: boolean): Val {
    if (left.kind === 'date') {
      if (right.kind === 'date') {
        if (!plus) return num(dayDiff(left, right))
        throw new CalcError('syntax') // 日期 + 日期：不猜
      }
      if (right.percent) throw new CalcError('syntax') // 日期 ± 百分数：不猜
      return addDays(left.y, left.m, left.d, plus ? right.n : -right.n)
    }
    if (right.kind === 'date') throw new CalcError('syntax') // 数 + 日期：不猜
    // 右操作数带 % 标记 → 标准计算器相对口径：A+B% = A×(1+B/100)（right.n 已经是 B/100）
    if (right.percent) return num(plus ? left.n * (1 + right.n) : left.n * (1 - right.n))
    return num(plus ? left.n + right.n : left.n - right.n)
  }

  /** 乘除层；日期一律语法错 */
  private term(): Val {
    let left = this.unary()
    for (;;) {
      const tk = this.peek()
      if (!tk || tk.t !== 'op' || (tk.v !== '*' && tk.v !== '/')) break
      this.next()
      const right = this.unary()
      if (left.kind === 'date' || right.kind === 'date') throw new CalcError('syntax')
      const divisor = right.n
      if (tk.v === '/') {
        if (divisor === 0) throw new CalcError('divide-by-zero')
        left = num(left.n / divisor)
      } else {
        left = num(left.n * divisor)
      }
    }
    return left
  }

  /** 一元正负（保留 % 标记：`-10%` 仍是「负百分之十」） */
  private unary(): Val {
    const tk = this.peek()
    if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
      this.next()
      const v = this.unary()
      if (tk.v === '-') {
        if (v.kind === 'date') throw new CalcError('syntax')
        return num(-v.n, v.percent)
      }
      return v
    }
    return this.postfix()
  }

  /** 后缀 %（可连缀；日期取 % 语法错） */
  private postfix(): Val {
    let v = this.atom()
    for (;;) {
      const tk = this.peek()
      if (!tk || tk.t !== '%') break
      this.next()
      if (v.kind === 'date') throw new CalcError('syntax')
      v = num(v.n / 100, true)
    }
    return v
  }

  private atom(): Val {
    const tk = this.next()
    if (!tk) throw new CalcError('syntax')
    if (tk.t === 'num') return num(tk.v)
    if (tk.t === 'date') {
      if (!isValidDate(tk.y, tk.m, tk.d)) throw new CalcError('invalid-date')
      return { kind: 'date', y: tk.y, m: tk.m, d: tk.d }
    }
    if (tk.t === '(') {
      const inner = this.expr()
      const close = this.next()
      if (!close || close.t !== ')') throw new CalcError('syntax')
      return inner
    }
    throw new CalcError('syntax')
  }
}

/**
 * 求值入口。成功返回展示态结果与展示态算式；失败返回三态之一（不抛异常、不崩）。
 * 空输入 / 纯空格按语法错返回（UI 层在回车前自行忽略空输入，不落账）。
 */
export function evaluateExpression(input: string): CalcEvalResult {
  const expression = renderExpression(input)
  let parsed: Val
  try {
    parsed = new Parser(tokenize(input)).parse()
  } catch (e) {
    const kind: CalcErrorKind = e instanceof CalcError ? e.kind : 'syntax'
    return { ok: false, error: kind, message: CALC_ERROR_MESSAGES[kind] }
  }
  if (parsed.kind === 'date') {
    const value = formatCalcDate(parsed.y, parsed.m, parsed.d)
    return { ok: true, kind: 'date', value, display: value, expression }
  }
  return { ok: true, kind: 'number', value: parsed.n, display: formatCalcNumber(parsed.n), expression }
}