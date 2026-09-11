import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SHORTCUTS,
  findShortcut,
  hasHandler,
  isTextTarget,
  matchShortcut,
  registerShortcut,
  resetShortcutsForTest,
} from '../../src/renderer/src/shortcuts'

/**
 * v2.5.8 D11（W6 快捷键单注册点）纯逻辑单测。
 *
 * 钉四件事，都是「散挂改单点」最容易回退的地方：
 *  1. 声明表自身成立（id 唯一、键不撞、每条都有文案）——设置页直接读它，表坏了卡片就错；
 *  2. 匹配规则与收编前三处逐条等价（Ctrl/Cmd 同权、大小写无关、裸 Delete 不被 Ctrl+Delete 误伤）；
 *  3. 输入态守卫的豁免面 = 收编前 Header/Ctrl+C 的口径（INPUT/TEXTAREA/SELECT/contenteditable）；
 *  4. 处理器注销干净（组件卸载后键必须原样放行给浏览器，不能留幽灵处理器继续劫持）。
 */
describe('快捷键声明表与派发（v2.5.8 D11 / W6）', () => {
  beforeEach(() => resetShortcutsForTest())

  it('声明表自洽：id 唯一、同键不重复声明、每条都有 desc', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size, `id 重复：${ids.join(',')}`).toBe(ids.length)
    // 键位冲突会在派发时静默变成「后面的那条永远不生效」，在表这一层就挡住
    const keys = SHORTCUTS.map((s) => `${s.ctrl ? 'ctrl+' : ''}${s.key}`)
    expect(new Set(keys).size, `键位重复：${keys.join(',')}`).toBe(keys.length)
    for (const s of SHORTCUTS) {
      expect(s.desc.length, `${s.id} 缺设置页文案`).toBeGreaterThan(0)
    }
    // 收编的三条必须还在表里（被删掉就等于散挂回潮）
    for (const id of ['search.focus', 'note.save', 'file.copy']) {
      expect(findShortcut(id), `${id} 不在声明表里`).toBeDefined()
    }
  })

  it('匹配规则与收编前三处等价：Ctrl/Cmd 同权、键名大小写无关', () => {
    expect(matchShortcut({ key: 'K', ctrlKey: true, metaKey: false })?.id).toBe('search.focus')
    expect(matchShortcut({ key: 'k', ctrlKey: false, metaKey: true })?.id).toBe('search.focus')
    expect(matchShortcut({ key: 's', ctrlKey: true, metaKey: false })?.id).toBe('note.save')
    expect(matchShortcut({ key: 'c', ctrlKey: true, metaKey: false })?.id).toBe('file.copy')
    // 没有修饰键的 k/s/c 不匹配任何条（否则打字就被劫持）
    expect(matchShortcut({ key: 'k', ctrlKey: false, metaKey: false })).toBeUndefined()
    // 裸 Delete 命中；但 Ctrl+Delete / Alt 组合不该被当成删除
    expect(matchShortcut({ key: 'Delete', ctrlKey: false, metaKey: false })?.id).toBe('list.delete')
    expect(matchShortcut({ key: 'Delete', ctrlKey: true, metaKey: false })).toBeUndefined()
    // 未声明的键放行
    expect(matchShortcut({ key: 'j', ctrlKey: true, metaKey: false })).toBeUndefined()
  })

  it('输入态守卫豁免面 = 收编前口径（四类元素一律不劫持）', () => {
    const el = (tag: string, editable = false) =>
      ({ tagName: tag, isContentEditable: editable }) as unknown as HTMLElement
    expect(isTextTarget(el('INPUT'))).toBe(true)
    expect(isTextTarget(el('TEXTAREA'))).toBe(true)
    expect(isTextTarget(el('SELECT'))).toBe(true)
    expect(isTextTarget(el('DIV', true))).toBe(true)
    expect(isTextTarget(el('DIV'))).toBe(false)
    expect(isTextTarget(el('BUTTON'))).toBe(false)
    expect(isTextTarget(null)).toBe(false)
    // 档位归属不许漂：Ctrl+S 必须在编辑器里也能存盘（guard=none），
    // 其余劫持型快捷键必须让位给输入态（guard=text）
    expect(findShortcut('note.save')?.guard).toBe('none')
    for (const id of ['search.focus', 'file.copy', 'settings.open', 'list.selectAll', 'list.delete']) {
      expect(findShortcut(id)?.guard, `${id} 守卫档位变了`).toBe('text')
    }
  })

  it('注册/注销：卸载后注册表干净（不留幽灵处理器）', () => {
    expect(hasHandler('search.focus')).toBe(false)
    const off = registerShortcut('search.focus', () => true)
    expect(hasHandler('search.focus')).toBe(true)
    off()
    // 注销后注册表必须空回去——否则组件卸载后键仍被劫持，且 set 会无限增长
    expect(hasHandler('search.focus')).toBe(false)
  })
})

/**
 * 「单注册点」的机器把关（对应 PLAN W6 的三分法：收编 3 + 保留 1 + 组件内部豁免 12）。
 *
 * 两条断言各管一种回退：
 *  - `metaKey` 只准出现在 `shortcuts.ts`：散挂的定义就是「自己判修饰键」，
 *    一旦别处再写 `e.ctrlKey || e.metaKey`，说明有人绕过声明表新挂了组合键。
 *  - keydown 监听总数钉死为 14（`shortcuts.ts` 单点 1 + 层栈 1 + 组件内部 12）：
 *    新增监听必须显式改本基线并说明为什么算组件职责，防「清单越拖越长而没人数」。
 */
describe('快捷键单注册点门禁（v2.5.8 D11 / W6）', () => {
  const SRC = path.resolve(__dirname, '../../src/renderer/src')

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) out.push(...walk(p))
      else if (/\.tsx?$/.test(ent.name)) out.push(p)
    }
    return out
  }

  /** 去注释：本门禁只看代码，注释里写「Ctrl+K」不算散挂 */
  function codeOnly(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
      .join('\n')
  }

  it('metaKey 判定只住在 shortcuts.ts（别处再判修饰键 = 绕过声明表散挂）', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/')
      if (rel === 'shortcuts.ts') continue
      if (/\bmetaKey\b/.test(codeOnly(fs.readFileSync(f, 'utf8')))) offenders.push(rel)
    }
    expect(offenders, `又有人自己挂组合键监听了，请改走 shortcuts.ts 的声明表：${offenders.join(', ')}`).toEqual([])
  })

  it('keydown 监听总数 = 14（单点 1 + 层栈 1 + 组件内部豁免 12）', () => {
    const sites: string[] = []
    for (const f of walk(SRC)) {
      const src = codeOnly(fs.readFileSync(f, 'utf8'))
      const rel = path.relative(SRC, f).split(path.sep).join('/')
      for (const m of src.matchAll(/addEventListener\(\s*["']keydown["']/g)) {
        sites.push(`${rel}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
    expect(
      sites.sort(),
      `keydown 监听数量变了。当前豁免清单见 shortcuts.ts 文件头（1 保留 + 12 豁免）；` +
        `新增必须同时改本基线并在头注补「为什么算组件职责」：\n${sites.join('\n')}`,
    ).toHaveLength(14)
  })
})
