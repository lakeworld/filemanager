/**
 * 应用内「剪切 = 移动」状态机的单测（v2.5.8 D19 / 体验批 B7）。
 *
 * 这条链路没有任何系统能力可依赖（不像 B3 的读剪贴板要看平台上装了什么工具），
 * 全靠这一组转移规则支撑，所以逐条钉死：
 *  - 「再按一次 Ctrl+X 取消」——多数编辑器的习惯，用户会这么做；
 *  - 「改了选中就把旧标记作废」——否则 Ctrl+V 会搬一批他根本没在看的文件；
 *  - 「集合比较而非数组比较」——选中顺序随点击次序变，标记不该因此被认成另一批。
 */
import { describe, expect, it } from 'vitest'
import { clearCut, markCut, pasteIntent, reconcileCut, sameCutSet } from '../../src/renderer/src/lib/cutPaste'

describe('sameCutSet：按集合比，不按顺序比', () => {
  it('顺序不同仍是同一批', () => {
    expect(sameCutSet(['/a', '/b'], ['/b', '/a'])).toBe(true)
  })

  it('Windows 反斜杠与 POSIX 斜杠归一（同一台机器上两种写法都可能出现）', () => {
    expect(sameCutSet(['C:\\ws\\a.png'], ['C:/ws/a.png'])).toBe(true)
  })

  it('盘符大小写归一（Win 路径不区分大小写）', () => {
    expect(sameCutSet(['C:\\ws\\a.png'], ['c:\\ws\\a.png'])).toBe(true)
  })

  it('少一个文件就不是一批；两个空数组才叫相等', () => {
    expect(sameCutSet(['/a', '/b'], ['/a'])).toBe(false)
    expect(sameCutSet([], [])).toBe(true)
    expect(sameCutSet([], ['/a'])).toBe(false)
  })
})

describe('markCut：Ctrl+X 的三种走向', () => {
  it('空选中什么都不改（不静默把现有标记清了——那会让人以为按坏了）', () => {
    expect(markCut(['/a'], [])).toEqual(['/a'])
  })

  it('首次按下：把选中的这批记为待移动', () => {
    expect(markCut([], ['/a', '/b'])).toEqual(['/a', '/b'])
  })

  it('同一批再按一次 = 取消标记', () => {
    expect(markCut(['/a', '/b'], ['/b', '/a'])).toEqual([])
  })

  it('换了另一批 = 覆盖成新的一批（不是叠加）', () => {
    expect(markCut(['/a'], ['/c'])).toEqual(['/c'])
  })

  it('返回的是副本：调用方改返回值不会串改到 store 里的数组', () => {
    const selected = ['/a']
    const out = markCut([], selected)
    out.push('/b')
    expect(selected).toEqual(['/a'])
  })
})

describe('reconcileCut：选中集变化后对账', () => {
  it('本来没有标记 → 保持没有', () => {
    expect(reconcileCut([], ['/a'])).toEqual([])
  })

  it('选中还是那一批 → 标记保留（换子文件夹时列表刷新会把选中重算成同一批，不能误清）', () => {
    expect(reconcileCut(['/a', '/b'], ['/b', '/a'])).toEqual(['/a', '/b'])
  })

  it('清空选中不动标记：换子文件夹会把选中清成空，而「A 目录 Ctrl+X → B 目录 Ctrl+V」正是主路径', () => {
    expect(reconcileCut(['/a'], [])).toEqual(['/a'])
  })

  it('但改去选了别的文件（非空且不同一批）→ 旧标记立刻作废', () => {
    expect(reconcileCut(['/a'], ['/b'])).toEqual([])
    expect(reconcileCut(['/a', '/b'], ['/a', '/b', '/c'])).toEqual([])
  })
})

describe('clearCut / pasteIntent', () => {
  it('移动成功或 Esc 之后是空数组（不是 null，调用方不用再判空指针）', () => {
    expect(clearCut()).toEqual([])
  })

  it('手里有待移动的批次 → Ctrl+V 走应用内移动', () => {
    expect(pasteIntent(['/a'])).toBe('move')
  })

  it('没有标记 → Ctrl+V 才去读系统剪贴板做粘贴导入', () => {
    expect(pasteIntent([])).toBe('import')
  })
})
