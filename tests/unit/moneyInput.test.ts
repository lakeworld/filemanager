/**
 * moneyInput 单测（v2.5.5 B2，PLAN §三）。
 * filterMoneyInput（输入中过滤）+ formatMoneyBlur（失焦格式化）纯函数直测——
 * 组合语义 = 组件输入→失焦：filter 只清非法字符不打断输入，blur 才格式化为两位小数。
 */
import { describe, it, expect } from "vitest";
import { filterMoneyInput, formatMoneyBlur } from "../../src/renderer/src/lib/moneyInput";

describe("filterMoneyInput（输入中过滤）", () => {
  it("只留数字与小数点，其余字符丢弃", () => {
    expect(filterMoneyInput("abc")).toBe("");
    expect(filterMoneyInput("12a3")).toBe("123");
    expect(filterMoneyInput("1,234.56")).toBe("1234.56");
    expect(filterMoneyInput(" 1 2 . 5 ")).toBe("12.5");
  });

  it("只允许一个小数点（多余的删除，保留第一个）", () => {
    expect(filterMoneyInput("1.2.3")).toBe("1.23");
    expect(filterMoneyInput("..1")).toBe(".1");
    expect(filterMoneyInput("1..2")).toBe("1.2");
    expect(filterMoneyInput("1.2.3.4")).toBe("1.234");
  });

  it("负号仅允许前导；其余位置丢弃", () => {
    expect(filterMoneyInput("-12.5")).toBe("-12.5");
    expect(filterMoneyInput("12-5")).toBe("125");
    expect(filterMoneyInput("--12")).toBe("-12");
    expect(filterMoneyInput("1-2-3")).toBe("123");
  });

  it("空串与纯垃圾 → 空串", () => {
    expect(filterMoneyInput("")).toBe("");
    expect(filterMoneyInput("abc!!")).toBe("");
  });
});

describe("formatMoneyBlur（失焦格式化）", () => {
  it("空与纯垃圾 → 空串", () => {
    expect(formatMoneyBlur("")).toBe("");
    expect(formatMoneyBlur("   ")).toBe("");
    expect(formatMoneyBlur("abc")).toBe("");
    expect(formatMoneyBlur("12abc")).toBe("");
    expect(formatMoneyBlur("1.2.3")).toBe("");
  });

  it("数字格式化为两位小数", () => {
    expect(formatMoneyBlur("1")).toBe("1.00");
    expect(formatMoneyBlur("1.2")).toBe("1.20");
    expect(formatMoneyBlur("0001.2")).toBe("1.20");
    expect(formatMoneyBlur(".5")).toBe("0.50");
    expect(formatMoneyBlur("12.")).toBe("12.00");
  });

  it("0 保留（不因 0 判定为非法；-0 归 0.00）", () => {
    expect(formatMoneyBlur("0")).toBe("0.00");
    expect(formatMoneyBlur("0.0")).toBe("0.00");
    expect(formatMoneyBlur("0.000")).toBe("0.00");
    expect(formatMoneyBlur("-0")).toBe("0.00");
  });

  it("负数允许（- 前缀）", () => {
    expect(formatMoneyBlur("-5")).toBe("-5.00");
    expect(formatMoneyBlur("-1.2")).toBe("-1.20");
    expect(formatMoneyBlur("-0.5")).toBe("-0.50");
  });

  it("超长小数截两位（字符串级截断、不四舍五入）", () => {
    expect(formatMoneyBlur("1.239")).toBe("1.23");
    expect(formatMoneyBlur("9.999")).toBe("9.99");
    expect(formatMoneyBlur("0.001")).toBe("0.00");
    expect(formatMoneyBlur("-1.239")).toBe("-1.23");
    // 浮点安全：0.29*100 = 28.999...，字符串级截断不受影响
    expect(formatMoneyBlur("0.29")).toBe("0.29");
  });
});

describe("filter + format 组合（组件输入 → 失焦语义）", () => {
  it("abc1.2.3 失焦 → 1.23", () => {
    expect(formatMoneyBlur(filterMoneyInput("abc1.2.3"))).toBe("1.23");
  });

  it("正常金额 1250.5 失焦 → 1250.50", () => {
    expect(formatMoneyBlur(filterMoneyInput("12a50.5"))).toBe("1250.50");
    expect(formatMoneyBlur(filterMoneyInput("1,234.56"))).toBe("1234.56");
  });

  it("负数输入 -12.5 失焦 → -12.50", () => {
    expect(formatMoneyBlur(filterMoneyInput("-12.5"))).toBe("-12.50");
  });

  it("超长小数输入失焦截两位", () => {
    expect(formatMoneyBlur(filterMoneyInput("12.3456"))).toBe("12.34");
  });
});
