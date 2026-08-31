import { describe, it, expect } from 'vitest'
import { withBuiltinNotes, defaultSubFolder, BUILTIN_NOTES_FOLDER } from '../../src/renderer/src/constants/notes'

/**
 * v2.5.7（A2 笔记 + 用户拍板 2026-08-30）：笔记文件夹排子文件夹第一位（最左）。
 * 适用挂载面 = 产品集文档区 + 客户 + 供应商文件区（withBuiltinNotes 唯一真相源）。
 */
describe('withBuiltinNotes（笔记文件夹排序）', () => {
  it('无笔记时插到最前（第一位）', () => {
    expect(withBuiltinNotes(['主图', '详情页'], ['主图', '详情页'])).toEqual([BUILTIN_NOTES_FOLDER, '主图', '详情页'])
  })

  it('已有笔记时置顶（从原位置移到第一位，其余顺序不变）', () => {
    expect(withBuiltinNotes(['主图', BUILTIN_NOTES_FOLDER, '详情页'], ['主图', '详情页'])).toEqual([
      BUILTIN_NOTES_FOLDER,
      '主图',
      '详情页',
    ])
  })

  it('fallback 分支同样置顶', () => {
    expect(withBuiltinNotes(undefined, ['3C', '质检'])).toEqual([BUILTIN_NOTES_FOLDER, '3C', '质检'])
  })

  it('笔记唯一（去重；单例不重复出现）', () => {
    const r = withBuiltinNotes([BUILTIN_NOTES_FOLDER, BUILTIN_NOTES_FOLDER, '素材'], ['素材'])
    expect(r.filter((x) => x === BUILTIN_NOTES_FOLDER)).toHaveLength(1)
    expect(r[0]).toBe(BUILTIN_NOTES_FOLDER)
  })
})

/**
 * v2.5.7 发布日审查：withBuiltinNotes 把「笔记」置首是**显示顺序**（用户拍板），但三处把它当**默认落点**
 * 用过——产品集文档卡（原进「说明书」）、客户文件区默认 tab 与「选择文件并添加」默认导入目标（原「报价」）、
 * 删除子文件夹后的跳转。默认落点跟显示顺序解耦：取第一个非内建笔记项。
 */
describe('defaultSubFolder（默认落点与显示顺序解耦）', () => {
  it('笔记在最左，但默认落点取第一个非笔记子文件夹', () => {
    const folders = withBuiltinNotes(undefined, ['说明书', '参数表', '质检报告'])
    expect(folders[0]).toBe(BUILTIN_NOTES_FOLDER) // 显示：笔记最左
    expect(defaultSubFolder(folders)).toBe('说明书') // 默认落点：仍是说明书
  })

  it('客户域默认落点为报价（导入目标不变）', () => {
    const folders = withBuiltinNotes(undefined, ['报价', '合同', '沟通', '其他'])
    expect(defaultSubFolder(folders)).toBe('报价')
  })

  it('只剩笔记时回落笔记（不返回空串致路径断裂）', () => {
    expect(defaultSubFolder([BUILTIN_NOTES_FOLDER])).toBe(BUILTIN_NOTES_FOLDER)
  })

  it('空列表返回空串（保持调用方 || 兜底链不变）', () => {
    expect(defaultSubFolder([])).toBe('')
  })

  it('用户在配置里首位写了别的文件夹时，默认落点尊重配置首位的非笔记项', () => {
    expect(defaultSubFolder(withBuiltinNotes(['合同', '报价'], ['报价']))).toBe('合同')
  })
})