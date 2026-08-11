import { describe, it, expect } from "vitest";
import { clampMenuPos } from "../../src/renderer/src/utils/clampMenuPos";

/**
 * 右键菜单视口钳制纯函数（v2.4.8「菜单撑满整个界面」根治配套）。
 * 红线：任何非法输入不得产出 NaN/Infinity（NaN 写进 style 会被浏览器丢弃，
 * fixed 元素失去 left/top 回退静态位置 → block 宽度=父容器宽度=全屏宽）。
 */
describe("clampMenuPos", () => {
  it("常规坐标：视口中央不越界", () => {
    expect(clampMenuPos(400, 300, 180, 300, 1280, 720)).toEqual({ left: 400, top: 300 });
  });

  it("右下角右键：内移到视口内（含 8px 边距）", () => {
    // innerW - width - 8 = 1092，innerH - height - 8 = 412
    expect(clampMenuPos(1200, 700, 180, 300, 1280, 720)).toEqual({ left: 1092, top: 412 });
  });

  it("极小窗口（视口比菜单还小）：保持左边距，不产出负值", () => {
    expect(clampMenuPos(100, 100, 500, 600, 320, 240)).toEqual({ left: 8, top: 8 });
  });

  it("负坐标（多显示器副屏）：钳到边距", () => {
    expect(clampMenuPos(-50, -20, 180, 300, 1280, 720)).toEqual({ left: 8, top: 8 });
  });

  it("坐标正好贴边：保持边距", () => {
    expect(clampMenuPos(0, 0, 180, 300, 1280, 720)).toEqual({ left: 8, top: 8 });
  });

  it("NaN 坐标：回退边距，绝不产出 NaN", () => {
    const r = clampMenuPos(Number.NaN, Number.NaN, 180, 300, 1280, 720);
    expect(r.left).toBe(8);
    expect(r.top).toBe(8);
    expect(Number.isFinite(r.left)).toBe(true);
    expect(Number.isFinite(r.top)).toBe(true);
  });

  it("NaN 尺寸/视口（测量异常）：跳过钳制，返回（有限）原坐标", () => {
    const r = clampMenuPos(400, 300, Number.NaN, Number.NaN, 1280, 720);
    expect(r).toEqual({ left: 400, top: 300 });
  });

  it("Infinity 输入：坐标回退边距；尺寸非有限跳过钳制", () => {
    expect(clampMenuPos(Infinity, -Infinity, 180, 300, 1280, 720)).toEqual({ left: 8, top: 8 });
    expect(clampMenuPos(400, 300, Infinity, 300, 1280, 720)).toEqual({ left: 400, top: 300 });
  });

  it("0 尺寸（布局未完成的异常测量）：按 0 尺寸钳制（坐标仍受视口约束）", () => {
    // width=0 → innerW - 0 - 8 = 1272；left = min(400, 1272) = 400
    expect(clampMenuPos(400, 300, 0, 0, 1280, 720)).toEqual({ left: 400, top: 300 });
  });

  it("自定义边距", () => {
    expect(clampMenuPos(0, 0, 180, 300, 1280, 720, 16)).toEqual({ left: 16, top: 16 });
  });
});
