/**
 * 原生右键编辑菜单构建（v2.5.7 A2，PLAN §三-A）。
 *
 * 纯函数：输入 { isEditable, hasSelection } → 菜单项数组（Electron MenuItemConstructorOptions 之一，
 * 字段为跨平台 role 子集——window.ts 只做 Menu.buildFromTemplate + popup + 一行 debug 日志）。
 *
 * 契约（与 PLAN §三-A 逐字一致）：
 * - isEditable（input/textarea/contenteditable 内点击）→ 撤销/重做/剪切/复制/粘贴/全选
 * - !isEditable 且 hasSelection（selectionText 非空）→ 仅「复制」
 * - !isEditable 且无选区 → 空数组（不弹——渲染层既有自定义右键作用于非编辑元素，不双菜单）
 *
 * 本模块不 import electron / node / 任何模块，编译后零运行时依赖（node 可直测）。
 */

export interface EditMenuState {
  /** 点击目标可编辑（input/textarea/contenteditable） */
  isEditable: boolean
  /** 网页有非空文本选区 */
  hasSelection: boolean
}

export type EditMenuItem = { role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'; label?: string }

/** 编辑类元素的标准菜单（isEditable=true 时的全项） */
const EDIT_MENU: EditMenuItem[] = [
  { role: 'undo', label: '撤销' },
  { role: 'redo', label: '重做' },
  { role: 'cut', label: '剪切' },
  { role: 'copy', label: '复制' },
  { role: 'paste', label: '粘贴' },
  { role: 'selectAll', label: '全选' },
]

/**
 * 构建右键编辑菜单。返回的项可直接经 MenuItemConstructorOptions[] 进 Menu.buildFromTemplate。
 * 排序稳定（撤销→重做→剪贴三件套→全选），标签为中文（与本体 UI 语系一致）。
 */
export function buildEditMenu(state: EditMenuState): EditMenuItem[] {
  if (!state) return []
  if (state.isEditable) return EDIT_MENU
  if (state.hasSelection) return [{ role: 'copy', label: '复制' }]
  return []
}
