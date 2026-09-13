/**
 * 随包 emoji 子集的覆盖面（v2.5.8 补丁，2026-09-13）——常驻断言。
 *
 * 背景：全站图标是裸 emoji 字符，此前依赖系统 emoji 字体；系统没装时 Linux 上图标整块看不见、
 * Windows/wine 字体路径下缺字形会回退成 32768px 宽的空位，把整行文字挤没。
 * 补丁做法是把在用的码位子集化随包（`assets/fonts/qihe-emoji-subset.woff2`，约 60KB）。
 *
 * 钉三件事：
 *  ① 源码里在用的每个 emoji 码位都被某个随包面覆盖（新增图标忘了重生成子集 ⇒ 在缺字体的机器上
 *    又是空的，而且本机开发看不出来——这是本补丁唯一可能自我复活的失败模式）；
 *  ② **分组不许错**：默认文字呈现的那批（◀ ▶  ⚠  ↔ ➕  ）必须住在队尾的 `Qihe Emoji Text` 面，
 *    不得进彩色面。本仓真踩过：把它们放进队首的彩色面 ⇒ 侧栏折叠键 ◀ 从黑色文字三角变成橙色
 *    实心 emoji（用户 2026-09-13 明确指出「我要黑色的返回箭头」）。
 *  ③ 随包字体文件真实存在、是 woff2、体积没失控。
 *
 * ⚠ 口径说明：`U+FE0F`（变体选择符）与 `U+200D`（ZWJ）不占字形，不参与比对；统计范围含注释
 *   （子集本来就是按整份源码文本生成的，宁可多带几个码位，口径保持一致）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../../src/renderer/src')
const FONTS_CSS = join(SRC, 'assets/fonts.css')
const SUBSET = join(SRC, 'assets/fonts/qihe-emoji-subset.woff2')
const PICTO = /\p{Extended_Pictographic}/gu
const IGNORED = new Set([0xfe0f, 0x200d])

/** 必须按"文字"画的码位（Unicode Emoji_Presentation=No），出现在界面上时不该被彩色面抢走 */
const TEXT_PRESENTATION = [
  0x2194, // ↔
  0x23f0, // ⏰
  0x25b6, // ▶
  0x25c0, // ◀
  0x2699, // ⚙
  0x26a0, // ⚠
  0x270f, // ✏
  0x274c, // ❌
  0x2795, // ➕
  0x2b06, // ⬆
]

function codepointsUnder(dir: string): Map<number, string> {
  const hit = new Map<number, string>()
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      for (const [cp, where] of codepointsUnder(p)) if (!hit.has(cp)) hit.set(cp, where)
      continue
    }
    if (!/\.tsx?$/.test(e.name)) continue
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(PICTO)) {
          const cp = m[0].codePointAt(0) as number
          if (IGNORED.has(cp) || hit.has(cp)) continue
          hit.set(cp, `${p.slice(SRC.length + 1)}:${i + 1}`)
        }
      })
  }
  return hit
}

/** 解析 fonts.css 里指定 family 的 @font-face unicode-range */
function rangeOf(family: string): Set<number> {
  const css = readFileSync(FONTS_CSS, 'utf8')
  const face = css.split('@font-face').find((b) => new RegExp(`font-family:\\s*['"]${family}['"]`).test(b))
  if (!face) throw new Error(`fonts.css 里找不到 '${family}' 的 @font-face`)
  const line = /unicode-range:([^;]+);/.exec(face)
  if (!line) throw new Error(`'${family}' 面没有 unicode-range ⇒ 它会接管所有文字，必须锁码位`)
  const out = new Set<number>()
  for (const token of line[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^U\+([0-9A-Fa-f]{4,6})-U\+([0-9A-Fa-f]{4,6})$/.exec(token)
    if (range) {
      for (let c = parseInt(range[1], 16); c <= parseInt(range[2], 16); c++) out.add(c)
      continue
    }
    const single = /^U\+([0-9A-Fa-f]{4,6})$/.exec(token)
    if (!single) throw new Error(`${family}: unicode-range 里出现无法解析的写法 ${token}`)
    out.add(parseInt(single[1], 16))
  }
  return out
}

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
const used = codepointsUnder(SRC)
const color = rangeOf('Qihe Emoji')
const text = rangeOf('Qihe Emoji Text')

describe("随包 emoji 面 'Qihe Emoji' / 'Qihe Emoji Text'", () => {
  it('① 源码在用的每个 emoji 码位都被随包面覆盖（新增图标须同步重生成子集）', () => {
    const missing = [...used.keys()].filter((cp) => !color.has(cp) && !text.has(cp)).sort((a, b) => a - b)
    expect(
      missing.map((cp) => `${hex(cp)} ${used.get(cp)}`),
      '这些码位不在任何随包面的 unicode-range 内 ⇒ 缺 emoji 字体的机器上它仍然是空的。' +
        '修法：加进 pyftsubset 的 --unicodes 重新生成 woff2，并把它归入正确的面（见 ②）。',
    ).toEqual([])
  })

  it('①b unicode-range 里不得白声明子集不再需要的码位（白名单漂移）', () => {
    const extra = [...color, ...text].filter((cp) => !used.has(cp)).map(hex).sort()
    expect(extra, '这些码位已不在源码中使用，但仍占着 unicode-range ⇒ 请一并从子集与两面里删掉').toEqual([])
  })

  it('② 默认文字呈现的那批只准住在队尾的 Text 面，不得进彩色面', () => {
    const wrong = TEXT_PRESENTATION.filter((cp) => color.has(cp)).map(hex)
    expect(wrong, '彩色面（排字体栈队首）会把这些字符画成彩色 emoji——◀ ▶ 这类必须保持黑色文字字形').toEqual([])
    const uncovered = TEXT_PRESENTATION.filter((cp) => !text.has(cp)).map(hex)
    expect(uncovered, '这批必须全部在 Qihe Emoji Text 面内，否则缺字体的机器会退回 32768px 空字形').toEqual([])
  })

  it('②b 队首彩色面不得含 Text 面的码位（两面必须互斥）', () => {
    const overlap = [...color].filter((cp) => text.has(cp)).map(hex)
    expect(overlap, '同一个码位出现在两面会让队首面赢，等价于把它变彩色').toEqual([])
  })

  it('③ 子集文件在位、是 woff2、体积没失控', () => {
    const size = statSync(SUBSET).size
    expect(size, '子集体积失控（本补丁的口径是"不靠包体换正确性"）').toBeLessThan(200_000)
    expect(readFileSync(SUBSET).subarray(0, 4).toString('ascii')).toBe('wOF2')
  })
})
