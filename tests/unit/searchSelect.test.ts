/**
 * SearchSelect（v2.5.8 W4 提前投产，PLAN §三 W4）纯逻辑单测。
 *
 * 组件本体是 Solid 渲染层，本仓无组件级渲染测试基建（先例：moneyInput/dateQuickPicks 同样只测抽出的纯函数），
 * 故把「过滤 / 键盘高亮推进 / 是否显示搜索框 / 弹层定位翻转」四件事抽到 src/renderer/src/lib/searchSelect.ts 直测。
 * 弹层与层栈接线（pushLayer/Esc/点外关闭）由 e2e 覆盖（tests/e2e/search-select.spec.ts）。
 */
import { describe, it, expect } from "vitest";
import {
  filterOptions,
  moveHighlight,
  autoSearchable,
  panelPosition,
  type SearchSelectOption,
} from "../../src/renderer/src/lib/searchSelect";

const OPTS: SearchSelectOption[] = [
  { value: "ps-1", label: "丝滑系列" },
  { value: "ps-2", label: "高速吹风机" },
  { value: "ps-3", label: "加湿器Pro" },
  { value: "", label: "全部产品集" },
];

describe("filterOptions（输入即过滤）", () => {
  it("空串 = 全量原序返回（不筛不排）", () => {
    expect(filterOptions(OPTS, "")).toEqual(OPTS);
    expect(filterOptions(OPTS, "   ")).toEqual(OPTS); // 首尾空白先 trim
  });

  it("大小写不敏感：命中 label（含 latin 子串）", () => {
    expect(filterOptions(OPTS, "pro").map((o) => o.value)).toEqual(["ps-3"]);
    expect(filterOptions(OPTS, "PRO").map((o) => o.value)).toEqual(["ps-3"]);
  });

  it("无 label 的选项按 value 匹配", () => {
    const opts: SearchSelectOption[] = [{ value: "alpha" }, { value: "beta" }];
    expect(filterOptions(opts, "AL").map((o) => o.value)).toEqual(["alpha"]);
  });

  it("无命中 → 空数组（由调用方渲染「无匹配」空态，不得回全量）", () => {
    expect(filterOptions(OPTS, "zzz")).toEqual([]);
  });

  it("value 空串的「全部」哨兵项也参与过滤（按 label 命中）", () => {
    expect(filterOptions(OPTS, "全部").map((o) => o.value)).toEqual([""]);
  });
});

describe("moveHighlight（↑↓ 键盘推进）", () => {
  it("向下从「未高亮(-1)」起步落到 0，再按依次 +1", () => {
    expect(moveHighlight(3, -1, 1)).toBe(0);
    expect(moveHighlight(3, 0, 1)).toBe(1);
  });

  it("到底绕回 0；到头再向上回到底", () => {
    expect(moveHighlight(3, 2, 1)).toBe(0);
    expect(moveHighlight(3, 0, -1)).toBe(2);
    expect(moveHighlight(3, -1, -1)).toBe(2); // 未高亮时向上也落到最后一项
  });

  it("空列表不动（0 长度返回 -1，避免 NaN 高亮）", () => {
    expect(moveHighlight(0, -1, 1)).toBe(-1);
    expect(moveHighlight(0, 0, -1)).toBe(-1);
  });
});

describe("autoSearchable（≤5 项自动隐藏搜索框）", () => {
  it("缺省：>5 项才显示搜索框", () => {
    expect(autoSearchable(5, undefined)).toBe(false);
    expect(autoSearchable(6, undefined)).toBe(true);
  });
  it("显式 searchable prop 覆盖自动判定（true 强制显示 / false 强制隐藏）", () => {
    expect(autoSearchable(2, true)).toBe(true);
    expect(autoSearchable(99, false)).toBe(false);
  });
});

describe("panelPosition（fixed 弹层越界翻转，照 DatePicker 口径）", () => {
  const rect = { left: 100, top: 200, bottom: 232, right: 260 };
  const vp = { w: 1024, h: 768 };

  it("常规情形：触发元素下方 6px 左对齐", () => {
    expect(panelPosition(rect, 220, 260, vp)).toEqual({ left: 100, top: 238 });
  });

  it("下缘越界 → 翻到触发元素上方展开（且不为负）", () => {
    const low = { left: 100, top: 600, bottom: 632, right: 260 };
    expect(panelPosition(low, 220, 260, vp)).toEqual({ left: 100, top: 334 });
    // 下方放不下（58+760>768）翻到上方也放不下（20-6-760<0）⇒ 贴顶 6px，绝不给出负坐标
    const veryLow = { left: 100, top: 20, bottom: 52, right: 260 };
    expect(panelPosition(veryLow, 220, 760, vp).top).toBe(6);
  });

  it("右缘越界 → 面板右对齐触发元素右缘", () => {
    const right = { left: 900, top: 100, bottom: 132, right: 1010 };
    expect(panelPosition(right, 220, 260, vp)).toEqual({ left: 790, top: 138 });
  });
});
