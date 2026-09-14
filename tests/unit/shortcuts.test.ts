import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SHORTCUTS,
  dispatchShortcut,
  findShortcut,
  hasHandler,
  isTextTarget,
  matchShortcut,
  registerShortcut,
  resetShortcutsForTest,
} from '../../src/renderer/src/shortcuts'
import { clearStackForTest, pushLayer } from '../../src/renderer/src/components/ui/layerStack'

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

/**
 * v2.5.9：弹窗让位（缺陷来源 = 实测，不是设想）。
 *
 * 探针在真应用里量到三件事（重命名弹窗开着、焦点已 blur 出输入框）：按 Ctrl+C 底层弹
 * 「已复制 1 个文件到剪贴板」；按 Ctrl+A 底层从 1 个选成 2 个；按 Delete 在重命名弹窗上
 * 又叠一层「删除文件」确认框。预览里更糟：屏幕显示 mkA、底层选中的是 mkB，按 Delete
 * 删的是 mkB。`guard: "text"` 一条都拦不住——它只看焦点在不在输入元素上，而弹窗里点一下
 * 按钮/空白就离开输入框了。本组把「谁该让位」钉死。
 */
describe('弹窗开着时的按键归属（v2.5.9）', () => {
  /** 假按键：target 默认 BODY（`isTextTarget` 判否 ⇒ 走得到派发与让位这一层） */
  const fakeKey = (key: string, opts: { ctrl?: boolean; target?: unknown } = {}) => {
    let prevented = false
    const e = {
      key,
      ctrlKey: opts.ctrl === true,
      metaKey: false,
      shiftKey: false,
      target: opts.target ?? { tagName: 'BODY' },
      preventDefault: () => {
        prevented = true
      },
    } as unknown as KeyboardEvent
    return { e, wasPrevented: () => prevented }
  }

  beforeEach(() => {
    resetShortcutsForTest()
    clearStackForTest()
  })

  it('弹窗级层开着 → 标了 pageOnly 的页面处理器不执行、也不 preventDefault', () => {
    let calls = 0
    registerShortcut('list.delete', () => {
      calls++
      return true
    }, { pageOnly: true })
    pushLayer({ modal: true, onEscape: () => undefined })

    const { e, wasPrevented } = fakeKey('Delete')
    dispatchShortcut(e)
    expect(calls, '弹窗开着时页面那条 Delete 还是被执行了 = 用户会删掉自己没在看的文件').toBe(0)
    expect(wasPrevented(), '没消费却按住了 Delete = 按键被凭空吞掉').toBe(false)
  })

  it('非弹窗层不算让位面：常驻浮条（lowest）与面板层开着时，页面快捷键照常工作', () => {
    // 这两条判据错了就会误伤主路径：Ctrl+X 的剪切撤销层、日期/标签/搜索下拉面板都不是弹窗
    let calls = 0
    registerShortcut('file.paste', () => {
      calls++
      return true
    }, { pageOnly: true })
    pushLayer({ lowest: true, onEscape: () => undefined }) // ui/SelectionBar 那种底部浮条
    pushLayer({ onEscape: () => undefined }) // DatePicker / TagInput / SearchSelect / ContextMenu 这类面板层
    dispatchShortcut(fakeKey('v', { ctrl: true }).e)
    dispatchShortcut(fakeKey('v', { ctrl: true }).e)
    expect(calls, '把浮条/面板也当弹窗 ⇒ 「Ctrl+X → 换目录 → Ctrl+V」这类主路径会被扳死').toBe(2)
  })

  it('同一个 id 上页面版与弹窗版共存：弹窗开着只跳页面版，弹窗自己那条仍命中（file.copy 的实际形状）', () => {
    const hit: string[] = []
    // 注册序刻意「页面版在前」——与真应用里 FileBrowserView 先挂载的形态一致
    registerShortcut('file.copy', () => {
      hit.push('page')
      return true
    }, { pageOnly: true })
    registerShortcut('file.copy', () => {
      hit.push('modal')
      return true
    })
    pushLayer({ modal: true })

    const { e } = fakeKey('c')
    e.ctrlKey = true
    dispatchShortcut(e)
    expect(hit, '预览自己的 Ctrl+C 被一起挡掉 = 回退 v2.5.8 D19 B2③；页面版仍在跑 = 原缺陷没修').toEqual(['modal'])
  })

  it('弹窗关掉后页面处理器恢复（不靠注销、不留永久哑火）', () => {
    let calls = 0
    registerShortcut('list.selectAll', () => {
      calls++
      return true
    }, { pageOnly: true })
    const layer = pushLayer({ modal: true })
    // 必须带 Ctrl：不带 Ctrl 的 'a' 根本不匹配任何声明，那条断言会变成假绿
    dispatchShortcut(fakeKey('a', { ctrl: true }).e)
    expect(calls).toBe(0)
    layer.remove()
    clearStackForTest()
    const { e, wasPrevented } = fakeKey('a', { ctrl: true })
    dispatchShortcut(e)
    expect(calls, '关窗后仍哑火 = 修一个 bug 造一个更难的 bug').toBe(1)
    expect(wasPrevented()).toBe(true)
  })

  it('页面级注册点必须显式标 pageOnly（漏标即红；弹窗自己那条必须不标）', () => {
    const SRC = path.resolve(__dirname, '../../src/renderer/src')
    // 必须先剥注释：这些文件的头注里就写着 `registerShortcut("file.copy", …)` 这类示例，
    // 不剥会把它当成第三个注册点（门禁自己的口径也是 `codeOnly`，见上一段 describe）
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const read = (rel: string) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length
    // 浮条两条（Ctrl+A / Delete）、文件浏览器两条（Ctrl+X / Ctrl+V）：全是页面动作
    expect(count(read('components/ui/SelectionBar.tsx'), /pageOnly: true/g), 'SelectionBar 两条页面注册都要让位').toBe(2)
    expect(count(read('components/FileBrowserView.tsx'), /pageOnly: true/g), '剪切/粘贴两条页面注册都要让位').toBe(2)
    // App 的导航与设置、Header 的全局搜索：弹窗开着都不该把用户从弹窗里踢出去
    expect(count(read('App.tsx'), /pageOnly: true/g), '导航/设置类注册要让位').toBe(1)
    expect(count(read('components/Header.tsx'), /pageOnly: true/g), 'search.focus 注册要让位').toBe(1)
    // Ctrl+C 的 hook 里只能有一条让位：另一条是预览自己的，标了就等于把 B2③ 关掉
    const hook = read('hooks/useCopyShortcut.ts')
    expect(count(hook, /registerShortcut\(/g), 'hook 里应恰有两条注册（页面版 + 预览版）').toBe(2)
    expect(count(hook, /pageOnly: true/g), '只准页面版让位；预览版标了就会退回 B2③ 那个缺陷').toBe(1)
    // 预览里那条 Delete 是「弹窗自己」的处理器，标了 pageOnly 就等于没修 T1
    const preview = read('components/FilePreviewModal.tsx')
    expect(count(preview, /registerShortcut\(\s*["']list\.delete["']/g), '预览要自己接 Delete').toBe(1)
    expect(count(preview, /pageOnly: true/g), '预览自己的处理器不能标 pageOnly').toBe(0)
    // **入栈侧同样要钉**：上面查的是「页面那条有没有声明让位」，但让位的开关其实在层这一侧——
    // 谁把 `ui/Modal` 或预览的 `modal: true` 删掉，整套让位规则立刻静默失效，而上面每条都仍全绿。
    expect(count(read('components/ui/Modal.tsx'), /modal: true/g), 'Modal 底座入栈必须标弹窗级层').toBe(1)
    expect(count(read('components/FilePreviewModal.tsx'), /modal: true/g), '预览入栈必须标弹窗级层').toBe(1)
  })
})
