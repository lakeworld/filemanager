import { describe, expect, it } from 'vitest'
import { ledgerCopyPaths, shouldTakeFileCopy } from '../../src/renderer/src/lib/copyShortcut'

/**
 * v2.5.8 D19（体验批 B2）：Ctrl+C 接管判定的纯函数单测。
 *
 * 这条判定自 v2.5.7（A1 剪贴板劫持）起就是「修过一次、不能再修第二次」的敏感逻辑，
 * B2 又要把它从 1 个页面铺到 7 个页面 ⇒ 用单测把三条让位规则的**顺序与边界**钉死，
 * 各页只准通过 `hooks/useCopyShortcut.ts` 复用，不准再抄一遍。
 */

const base = { previewOpen: false, guardOn: true, textSelected: false, selectedCount: 2 } as const

describe('shouldTakeFileCopy：Ctrl+C 何时由「复制选中文件」接管', () => {
  it('正常态：预览没开、正文无选区、有选中文件 → 接管', () => {
    expect(shouldTakeFileCopy(base)).toBe(true)
  })

  it('规则 1：预览开着就不接管（否则复制的是底层列表的选中项，不是正在预览的那张）', () => {
    expect(shouldTakeFileCopy({ ...base, previewOpen: true })).toBe(false)
  })

  it('规则 2：守卫开 + 正文有非折叠选区 → 让位浏览器复制文本（v2.5.7 A1 根因 1）', () => {
    expect(shouldTakeFileCopy({ ...base, textSelected: true })).toBe(false)
  })

  it('规则 2 的反面：设置里把「让位正文」关掉，就回到「文件选中优先」的老口径', () => {
    expect(shouldTakeFileCopy({ ...base, guardOn: false, textSelected: true })).toBe(true)
  })

  it('规则 3：本页零选中 → 不接管，也不给这个键抢一次 preventDefault', () => {
    expect(shouldTakeFileCopy({ ...base, selectedCount: 0 })).toBe(false)
  })

  it('预览开着时，正文无选区也不接管（规则 1 必须排在规则 2/3 之前）', () => {
    // 这条钉的是**顺序**：若实现把 previewOpen 挪到 selectedCount 之后，
    // 「预览开着 + 零选中」与「预览开着 + 有选中」会给出不同答案，交棒链就断了
    expect(shouldTakeFileCopy({ ...base, previewOpen: true, selectedCount: 0 })).toBe(false)
    expect(shouldTakeFileCopy({ ...base, previewOpen: true, textSelected: true })).toBe(false)
  })
})

describe('ledgerCopyPaths：台账选中行 → 可复制的文件路径', () => {
  interface Row {
    number: string
    file_path: string
  }
  const pick = (r: Row) => r.file_path

  it('基本映射：按行的原顺序出路径', () => {
    expect(ledgerCopyPaths([{ number: 'A', file_path: '/x/a.pdf' }, { number: 'B', file_path: '/x/b.pdf' }], pick)).toEqual([
      '/x/a.pdf',
      '/x/b.pdf',
    ])
  })

  it('无归档文件的行（file_path 空串/null/undefined）整行跳过——一个空条目会让整批复制失败', () => {
    expect(ledgerCopyPaths([{ number: 'A', file_path: '' }, { number: 'B', file_path: '/x/b.pdf' }], pick)).toEqual(['/x/b.pdf'])
    expect(
      ledgerCopyPaths<{ number: string; file_path: string | null }>(
        [{ number: 'A', file_path: null }, { number: 'B', file_path: '/x/b.pdf' }],
        (r) => r.file_path,
      ),
    ).toEqual(['/x/b.pdf'])
    expect(ledgerCopyPaths([{ number: 'A' }, { number: 'B', file_path: '/x/b.pdf' }] as never[], pick)).toEqual(['/x/b.pdf'])
  })

  it('同一文件被多行引用 → 去重，保证 toast 报的数量就是剪贴板里的数量', () => {
    expect(ledgerCopyPaths([{ number: 'A', file_path: '/x/a.pdf' }, { number: 'B', file_path: '/x/a.pdf' }], pick)).toEqual([
      '/x/a.pdf',
    ])
  })

  it('全是没有文件的行 → 空数组（调用方据此不接管快捷键、也不弹「已复制 0 个」）', () => {
    expect(ledgerCopyPaths([{ number: 'A', file_path: '' }, { number: 'B', file_path: '' }], pick)).toEqual([])
  })
})
