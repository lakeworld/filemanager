/**
 * 计算解析器单测（v2.5.9/A7；权威 = 内部计算设计文档（不进公开仓）§二 规格冻结 + §六 解析器设计）
 * 覆盖矩阵：四则优先级 / 嵌套括号 / % 四口径 / 日期三形态 / 容错三条（空格·尾部运算符·除零）/
 * 日期与数字混算报错 / 结果格式化（千分位两位 · YYYY-MM-DD）/ 显示态渲染（*→× · /→÷）。
 *
 * 语义模型（实现与测试共用的同一份口径，写在这里防漂移）：
 * - 值 = {n, percent}：后缀 % 既除以 100 又打上 percent 标记；
 * - 加法/减法：右操作数带 percent 标记时按相对口径 A×(1±B/100)；**乘除会消标记**（`100+10%*2` 已不带），
 *   括号与一元正负原样传递标记（`100+(10%)` / `-10%` 仍带，实现注释同口径）；
 * - 乘除：percent 只作为 /100 的数值参与（A×B% = A×B/100）；
 * - 裸 B% = B/100。
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateExpression,
  renderExpression,
  formatCalcNumber,
  formatCalcDate,
  formatCalcTime,
} from '../../src/shared/calc'

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

  /**
   * 三路代码审查抓出的真缺陷（2026-09-21 修复批）。每条都先在本机复现过旧行为，再钉新口径：
   * raw 保真 / 千分位只在合规分组时剔除 / 纯整数日期（年份与时区两坑）/ 日期±非整数天 / 非有限数。
   */
  describe('审查修复批（原样字面量 · 千分位分组 · 纯整数日期 · 非有限数）', () => {
    it('千分位只在合规分组时剔除：1,234 / 12,345,678.9 / 1,234.56 照常算', () => {
      expect(displayOf('1,234')).toBe('1,234.00')
      expect(displayOf('12,345,678.9 + 0.1')).toBe('12,345,679.00')
      expect(displayOf('1,234.56 + 0.44')).toBe('1,235.00')
    })

    it('分组不成立即语法错，不做静默纠偏（旧口径：1,5+1=16、2,5*4=100、1,2,3=123、1,=1）', () => {
      for (const bad of ['1,5 + 1', '2,5*4', '1,2,3', '1,', '1,0000', '2026-09-16,5']) {
        expect(errorOf(bad), `${bad} 应语法错——静默算成别的数比报错坏得多`).toBe('syntax')
      }
    })

    it('renderExpression 回显用户原样字面量（raw）：千分位逗号与长整数不被 String(v) 改写', () => {
      expect(renderExpression('1,380 / 1.13 * 0.13')).toBe('1,380 ÷ 1.13 × 0.13')
      expect(renderExpression('9007199254740993 + 0')).toBe('9007199254740993 + 0')
      expect(renderExpression('1111111111111111111111 + 0')).toBe('1111111111111111111111 + 0')
    })

    it('点算式回填再算：raw 保真的算式原样再算得同结果（22 位字面量不塌成 1e+21）', () => {
      for (const input of ['1,380 / 1.13 * 0.13', '9007199254740993 + 0', `${'1'.repeat(22)} + 0`]) {
        const r = evaluateExpression(input)
        expect(r.ok, `${input} 应能算`).toBe(true)
        if (!r.ok) continue
        expect(r.expression, `${input} 的展示态算式塌成了科学计数法`).not.toContain('e+')
        const again = evaluateExpression(r.expression)
        expect(again.ok, `回填后语法错：${r.expression}`).toBe(true)
        if (again.ok) {
          expect(again.display, `回填再算结果变了：${r.expression}`).toBe(r.display)
          expect(again.expression).toBe(r.expression)
        }
      }
    })

    it('日期运算不再受 JS 年份映射影响：0000-01-01 + 1、0100-01-01 + 1（旧口径 1900-01-02 / 100-01-02）', () => {
      expect(displayOf('0000-01-01 + 1')).toBe('0000-01-02')
      expect(displayOf('0100-01-01 + 1')).toBe('0100-01-02')
      expect(formatCalcDate(100, 1, 2)).toBe('0100-01-02') // 年份补零到 4 位（回填后才不会读成减法）
    })

    it('日期运算不再受运行机器时区影响：2011-12-31 - 1 = 2011-12-30（Apia 那天被本地时区跳过）', () => {
      expect(displayOf('2011-12-31 - 1')).toBe('2011-12-30')
      expect(displayOf('2011-12-31 - 2011-12-29')).toBe('2.00')
    })

    it('日期字面量刻意放宽：2026-9-16 认作日期（代价 = 1234-5-6 也被当日期）', () => {
      expect(displayOf('2026-9-16 + 1')).toBe('2026-09-17')
      expect(renderExpression('2026-9-16 + 1')).toBe('2026-09-16 + 1')
      expect(displayOf('1234-5-6')).toBe('1234-05-06')
    })

    it('日期超出 YYYY-MM-DD 可表达范围报 invalid-date：9999-12-31 + 1 / 0000-01-01 - 1', () => {
      expect(errorOf('9999-12-31 + 1')).toBe('invalid-date')
      expect(errorOf('0000-01-01 - 1')).toBe('invalid-date')
    })

    it('日期 ± 非整数天 = 语法错（旧口径静默截断：2026-09-16 + 1.5 曾得 2026-09-17）', () => {
      expect(errorOf('2026-09-16 + 1.5')).toBe('syntax')
      expect(errorOf('2026-09-16 - 0.5')).toBe('syntax')
      expect(displayOf('2026-09-16 + 1.0')).toBe('2026-09-17') // 整值写法仍算 1 天
    })

    it('非有限数报「数太大，算不出来」：400 位字面量 / 溢出后再 ×0（∞×0=NaN）', () => {
      expect(errorOf('9'.repeat(400))).toBe('too-large')
      expect(errorOf(`${'9'.repeat(400)} + 1`)).toBe('too-large')
      expect(errorOf(`${'9'.repeat(400)} * 0`)).toBe('too-large')
      const r = evaluateExpression('9'.repeat(400))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toBe('数太大，算不出来')
    })

    it('括号与一元正负原样传递 % 标记（只有乘除消标记）：100 + (10%) = 110', () => {
      expect(displayOf('100 + (10%)')).toBe('110.00')
      expect(displayOf('200 + (10%)')).toBe('220.00') // 相对口径随基数变，证明确实还带标记
      expect(displayOf('100 - (10%)')).toBe('90.00')
      expect(displayOf('100 + 10%*2')).toBe('100.20') // 对照组：乘除已把标记消掉
    })
  })
})