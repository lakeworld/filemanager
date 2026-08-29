/**
 * editMenu 单测（v2.5.7 A2，PLAN §三-A）：参数矩阵四组合——isEditable×hasSelection。
 * 契约：isEditable → 标准六项；仅选区 → 复制一项；其余空；null 入参容错。
 */
import { describe, it, expect } from 'vitest'
import { buildEditMenu, type EditMenuState } from '../../src/main/core/editMenu'

describe('buildEditMenu（原生右键编辑菜单，v2.5.7 A2）', () => {
  it('isEditable=true → 标准六项（撤销/重做/剪切/复制/粘贴/全选，顺序稳定）', () => {
    const items = buildEditMenu({ isEditable: true, hasSelection: false })
    expect(items.map((i) => i.role)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    expect(items).toHaveLength(6)
  })

  it('isEditable=true 且带选区 → 仍是标准六项（编辑态覆盖选区）', () => {
    expect(buildEditMenu({ isEditable: true, hasSelection: true })).toHaveLength(6)
  })

  it('非编辑但有文本选区 → 仅「复制」', () => {
    const items = buildEditMenu({ isEditable: false, hasSelection: true })
    expect(items).toEqual([{ role: 'copy', label: '复制' }])
  })

  it('非编辑且无选区 → 空数组（不弹菜单）', () => {
    expect(buildEditMenu({ isEditable: false, hasSelection: false })).toEqual([])
  })

  it('仅选区命中（selectionText 非空但非编辑）语义 = hasSelection', () => {
    // window 接线处：params.isEditable || params.selectionText 非空 → 进入本函数；此处纯函数不接收 params
    expect(buildEditMenu({ isEditable: false, hasSelection: true })[0]?.role).toBe('copy')
  })

  it('容错：null/未定义入参 → 空数组（不炸）', () => {
    expect(buildEditMenu(null as unknown as EditMenuState)).toEqual([])
    expect(buildEditMenu(undefined as unknown as EditMenuState)).toEqual([])
  })

  it('所有项均为 role 形式（可跨平台 Menu.buildFromTemplate 直用）', () => {
    for (const item of buildEditMenu({ isEditable: true, hasSelection: false })) {
      expect(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']).toContain(item.role)
    }
  })
})
