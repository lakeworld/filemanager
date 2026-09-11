import { describe, expect, it } from 'vitest'
import {
  SELECTION_ACTION_CLASS,
  SELECTION_CLEAR_CLASS,
  selectionLabel,
} from '../../src/renderer/src/lib/selectionBar'

/**
 * v2.5.8 D10（精致化 W5）：悬浮多选条的纯逻辑单测。
 *
 * 组件本体（材质/定位/入层栈）走 e2e + 截图取证；这里只钉收口时最容易漂的两件事：
 * ① 计数文案的组法（七页五种量词，组法必须一处定死）；
 * ② 三档动作材质确实是三档（收成一串常量后，「分档失效」是静默的）。
 * 材质串里的类是否存在于编译 CSS，由 `npm run check:classes` 覆盖——它扫 `src/renderer` 全文，
 * 组件常量在扫描范围内，故此处不重复造轮子。
 */
describe('悬浮多选条纯逻辑（v2.5.8 D10 / W5）', () => {
  it('计数文案：量词由调用方给，前缀与空格组法单点', () => {
    expect(selectionLabel(1, '张发票')).toBe('已选择 1 张发票')
    expect(selectionLabel(12, '个文件')).toBe('已选择 12 个文件')
    // 收口前七页各写一份，量词出现过「个文件 / 张发票 / 条入库单 / 条报价 / 篇笔记」五种；
    // 组法（前缀 + 半角空格 + 数字 + 空格 + 量词）必须由这一处定死
    expect(selectionLabel(3, '条报价')).toBe('已选择 3 条报价')
    // 既有 e2e 靠整句 text 定位（如 selection-checkbox.spec 的「已选择 1 张发票」），
    // 组法一变就全红——这条断言就是给那些 spec 兜底的
    expect(selectionLabel(1, '条入库单')).toBe('已选择 1 条入库单')
  })

  it('三档动作材质互不相同，且都自带 whitespace-nowrap（窄窗口不挤成两行）', () => {
    const tones = ['default', 'primary', 'danger'] as const
    const classes = tones.map((t) => SELECTION_ACTION_CLASS[t])
    expect(new Set(classes).size, '三档材质撞成同一串 = 分档失效').toBe(3)
    for (const c of classes) {
      expect(c).toContain('whitespace-nowrap')
      expect(c).toContain('rounded-lg')
      expect(c).toContain('px-3')
      expect(c).toContain('py-1.5')
    }
    expect(SELECTION_ACTION_CLASS.danger).toContain('bg-danger-500')
    expect(SELECTION_ACTION_CLASS.primary).toContain('bg-primary-500')
    expect(SELECTION_ACTION_CLASS.default).toContain('border-surface-200')
  })

  it('「取消选择」是次到动作：白字无边框，与 primary/danger 三档都不撞串', () => {
    expect(SELECTION_CLEAR_CLASS).not.toContain('border-')
    expect(SELECTION_CLEAR_CLASS).toContain('hover:bg-white')
    expect(Object.values(SELECTION_ACTION_CLASS)).not.toContain(SELECTION_CLEAR_CLASS)
  })
})
