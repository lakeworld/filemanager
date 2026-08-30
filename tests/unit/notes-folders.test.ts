import { describe, it, expect } from 'vitest'
import { withBuiltinNotes, BUILTIN_NOTES_FOLDER } from '../../src/renderer/src/constants/notes'

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