/**
 * 计算解析器单测（v2.5.9/A7；权威 = docs/INTERNAL/PLAN-v2.6-计算.md §二 规格冻结 + §六 解析器设计）
 * 覆盖矩阵：四则优先级 / 嵌套括号 / % 四口径 / 日期三形态 / 容错三条（空格·尾部运算符·除零）/
 * 日期与数字混算报错 / 结果格式化（千分位两位 · YYYY-MM-DD）/ 显示态渲染（*→× · /→÷）。
 *
 * 语义模型（实现与测试共用的同一份口径，写在这里防漂移）：
 * - 值 = {n, percent}：后缀 % 既除以 100 又打上 percent 标记；
 * - 加法/减法：右操作数带 percent 标记时按相对口径 A×(1±B/100)（％ 标记在乘除/括号/一元后原样传递规则见实现注释）；
 * - 乘除：percent 只作为 /100 的数值参与（A×B% = A×B/100）；
 * - 裸 B% = B/100。
 */
import { describe, it, expect } from 'vitest'
import { evaluateExpression, renderExpression, formatCalcNumber, formatCalcTime } from '../../src/shared/calc'

/** 断言成功并取 display（失败时把错误信息带进断言输出，便于定位） */
function displayOf(input: string): string {
  const r = evaluateExpression(input)
  if (!r.ok) throw new Error(`解析失败（${r.error}: ${r.message}）: ${input}`)
  return r.display
}

function errorOf(input: string): string {
  const r = evaluateExpression(input)
  if (r.ok) throw new Error(`本应失败却成功（${r.display}）: ${input}`)
  return r.error
}

describe('计算解析器（v2.5.9/A7）', () => {
  describe('四则运算与优先级', () => {
    it('乘除优先于加减', () => {
      expect(displayOf('1+2*3')).toBe('7.00')
      expect(displayOf('10-6/3')).toBe('8.00')
    })

    it('同级左结合：10-2-3=5、8/4/2=1', () => {
      expect(displayOf('10-2-3')).toBe('5.00')
      expect(displayOf('8/4/2')).toBe('1.00')
    })

    it('嵌套括号：((1+2)*3)+4 = 13', () => {
      expect(displayOf('((1+2)*3)+4')).toBe('13.00')
    })

    it('高频形态 (3200 + 380) * 1.15 = 4,117.00', () => {
      expect(displayOf('(3200 + 380) * 1.15')).toBe('4,117.00')
    })

    it('一元正负：-5+3=-2、3*-2=-6、-(2+3)=-5', () => {
      expect(displayOf('-5+3')).toBe('-2.00')
      expect(displayOf('3*-2')).toBe('-6.00')
      expect(displayOf('-(2+3)')).toBe('-5.00')
    })

    it('千分位逗号宽容剔除：1,000 + 1 = 1,001.00', () => {
      expect(displayOf('1,000 + 1')).toBe('1,001.00')
    })

    it('浮点尾差被格式化收住：0.1+0.2 显示 0.30', () => {
      expect(displayOf('0.1+0.2')).toBe('0.30')
    })
  })

  describe('% 四口径（标准计算器语义）', () => {
    it('A+B% = A×(1+B/100)：100+10% = 110', () => {
      expect(displayOf('100+10%')).toBe('110.00')
    })

    it('A-B% = A×(1-B/100)：100-10% = 90', () => {
      expect(displayOf('100-10%')).toBe('90.00')
    })

    it('A×B% = A×B/100：100*10% = 10', () => {
      expect(displayOf('100*10%')).toBe('10.00')
    })

    it('裸 B% = B/100：10% = 0.10', () => {
      expect(displayOf('10%')).toBe('0.10')
    })

    it('括号内 % 参与乘法：1000*(1+5%) = 1,050.00', () => {
      expect(displayOf('1000*(1+5%)')).toBe('1,050.00')
    })

    it('右操作数不是 % 时不走相对口径：100+10 = 110 与 100+10% 是两条路', () => {
      expect(displayOf('100+10')).toBe('110.00')
      expect(displayOf('100+10%')).toBe('110.00') // 同为 110 是巧合（10% of 100 = 10），见下一条钉差别
      expect(displayOf('200+10%')).toBe('220.00') // 相对口径：+10% 随基数变化
      expect(displayOf('200+10')).toBe('210.00')
    })

    it('% 后再次乘除不再带相对语义：100+10%*2 = 100.20', () => {
      expect(displayOf('100+10%*2')).toBe('100.20')
    })
  })

  describe('日期三形态', () => {
    it('日期 + 天数 = 日期：2026-09-16 + 60 → 2026-11-15', () => {
      expect(displayOf('2026-09-16 + 60')).toBe('2026-11-15')
    })

    it('日期 - 天数 = 日期：2026-09-16 - 5 → 2026-09-11', () => {
      expect(displayOf('2026-09-16 - 5')).toBe('2026-09-11')
    })

    it('日期 - 日期 = 天数：2026-11-15 - 2026-09-16 → 60.00', () => {
      expect(displayOf('2026-11-15 - 2026-09-16')).toBe('60.00')
    })

    it('跨月边界：2026-01-31 + 1 → 2026-02-01', () => {
      expect(displayOf('2026-01-31 + 1')).toBe('2026-02-01')
    })

    it('闰年 2024-02-28 + 1 → 2024-02-29；平年 2025-02-28 + 1 → 2025-03-01', () => {
      expect(displayOf('2024-02-28 + 1')).toBe('2024-02-29')
      expect(displayOf('2025-02-28 + 1')).toBe('2025-03-01')
    })

    it('日期结果的 kind = date，天数的 kind = number', () => {
      const d = evaluateExpression('2026-09-16 + 60')
      expect(d.ok && d.kind).toBe('date')
      const n = evaluateExpression('2026-11-15 - 2026-09-16')
      expect(n.ok && n.kind).toBe('number')
    })

    it('非法日期报「这个日期不存在」：2026-02-30 / 2026-13-01', () => {
      expect(errorOf('2026-02-30')).toBe('invalid-date')
      expect(errorOf('2026-13-01')).toBe('invalid-date')
    })

    it('日期与数字混算（除日期±数、日期−日期外）一律语法错', () => {
      expect(errorOf('2026-09-16 * 2')).toBe('syntax')
      expect(errorOf('2 * 2026-09-16')).toBe('syntax')
      expect(errorOf('2026-09-16 + 2026-09-16')).toBe('syntax')
      expect(errorOf('2 + 2026-09-16')).toBe('syntax')
      expect(errorOf('2026-09-16 / 2')).toBe('syntax')
    })
  })

  describe('容错三条（只有三条）', () => {
    it('任意空格宽容', () => {
      expect(displayOf('  1  +   2 * 3  ')).toBe('7.00')
      expect(displayOf('( 3200+380 )*1.15')).toBe('4,117.00')
    })

    it('结尾多按的运算符自动忽略：1+2+ = 3、5* = 5、1+2++ = 3', () => {
      expect(displayOf('1+2+')).toBe('3.00')
      expect(displayOf('5*')).toBe('5.00')
      expect(displayOf('1+2++')).toBe('3.00')
    })

    it('除零给「除数不能为 0」：1/0 与 1/(2-2)', () => {
      expect(errorOf('1/0')).toBe('divide-by-zero')
      expect(errorOf('1/(2-2)')).toBe('divide-by-zero')
    })
  })

  describe('语法错（温和失败，不崩）', () => {
    it('空输入 / 纯空格 / 裸运算符', () => {
      expect(errorOf('')).toBe('syntax')
      expect(errorOf('   ')).toBe('syntax')
      expect(errorOf('*')).toBe('syntax')
    })

    it('括号不配平 / 非法字符 / 连续运算符', () => {
      expect(errorOf('(1+2')).toBe('syntax')
      expect(errorOf('1+2)')).toBe('syntax')
      expect(errorOf('1+abc')).toBe('syntax')
      expect(errorOf('1+*2')).toBe('syntax')
      expect(errorOf('()')).toBe('syntax')
    })
  })

  describe('显示态渲染（*→× · /→÷）与格式化', () => {
    it('renderExpression 只换乘除号、收空格、其余原样', () => {
      expect(renderExpression('(3200 + 380) * 1.15')).toBe('(3200 + 380) × 1.15')
      expect(renderExpression('8/4/2')).toBe('8 ÷ 4 ÷ 2')
      expect(renderExpression('  1  +  2  ')).toBe('1 + 2')
      expect(renderExpression('2026-09-16 + 60')).toBe('2026-09-16 + 60')
      expect(renderExpression('100+10%')).toBe('100 + 10%')
    })

    it('成功结果携带显示态算式与显示态结果', () => {
      const r = evaluateExpression('(3200+380)*1.15')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.expression).toBe('(3200 + 380) × 1.15')
        expect(r.display).toBe('4,117.00')
      }
    })

    it('输入侧也认 × 与 ÷（点算式回填后原样再算得同结果）', () => {
      expect(displayOf('8 ÷ 4 ÷ 2')).toBe('1.00')
      expect(displayOf('2 × 3')).toBe('6.00')
    })

    it('formatCalcNumber：千分位两位小数、负数与零', () => {
      expect(formatCalcNumber(4117)).toBe('4,117.00')
      expect(formatCalcNumber(0.1)).toBe('0.10')
      expect(formatCalcNumber(-1234.5)).toBe('-1,234.50')
      expect(formatCalcNumber(0)).toBe('0.00')
    })
  })

  describe('formatCalcTime（历史行时间小灰字）', () => {
    // 固定「现在」= 2026-09-22（周二）10:30 本地；断言全部相对它，不依赖运行时钟
    const now = new Date(2026, 8, 22, 10, 30)
    const at = (y: number, m: number, d: number, h = 12, min = 0): string =>
      new Date(y, m - 1, d, h, min).toISOString()

    it('同一天 → HH:MM（两位补零；含晚于此刻的未来偏移）', () => {
      expect(formatCalcTime(at(2026, 9, 22, 9, 5), now)).toBe('09:05')
      expect(formatCalcTime(at(2026, 9, 22, 23, 59), now)).toBe('23:59')
    })

    it('昨天按日历天差判：昨夜 23:00 只差 11.5 小时，仍算「昨天」', () => {
      expect(formatCalcTime(at(2026, 9, 21, 23, 0), now)).toBe('昨天')
      expect(formatCalcTime(at(2026, 9, 21, 0, 5), now)).toBe('昨天')
    })

    it('2–6 天前 → 周X', () => {
      expect(formatCalcTime(at(2026, 9, 19), now)).toBe('周六') // 3 天前
      expect(formatCalcTime(at(2026, 9, 16), now)).toBe('周三') // 6 天前（边界内）
    })

    it('7 天及更早 → YYYY-MM-DD', () => {
      expect(formatCalcTime(at(2026, 9, 15), now)).toBe('2026-09-15') // 7 天前，刚好出界
      expect(formatCalcTime(at(2026, 9, 12), now)).toBe('2026-09-12')
    })

    it('iso 非法 / 空串 → 空串（UI 不显示时间，不崩）', () => {
      expect(formatCalcTime('not-a-date', now)).toBe('')
      expect(formatCalcTime('', now)).toBe('')
    })
  })
})