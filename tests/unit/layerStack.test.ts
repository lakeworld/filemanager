import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStackForTest,
  dispatchEscapeForTest,
  isTop,
  pushLayer,
  topLayerId,
} from "../../src/renderer/src/components/ui/layerStack";

/**
 * 层栈入栈顺序与 Esc 派发（v2.5.8 D10 `lowest` 置底语义）。
 *
 * 为什么要有这份文件：`lowest`（置底入栈）是 D10 为「常驻浮条不该争 Esc 栈顶」加的，
 * 而 `pushLayer` 当年写的是 `stack.push(...)`——**那段插入逻辑压根没被调用**，
 * `lowest` 只是躺在类型里。结果 D10 证据档声称的三条不变式全为假：
 * ① 置底层不抢栈顶；② 置底层之间后开先关；③ 带选中态的页面开弹窗时栈顶仍是弹窗
 * （`isTop()` 驱动的焦点困守因此失效）。E2E `context-menu:182` 只是恰好没撞上挂载顺序。
 * 这里用真实 `pushLayer` 把三条钉死，改名换址都会红。
 *
 * 环境：vitest 为纯 node（`vitest.config.ts`），故 `layerStack.ts` 的模块级 window 监听
 * 加了 `typeof window` 守卫；Esc 派发经 `dispatchEscapeForTest` 直接跑，等价于那次 keydown。
 * 浮条「视觉上是否遮住建模弹窗」等真实 DOM 表现仍归 e2e（`selection-bar.spec.ts`）。
 */

/** 反复取栈顶并弹出，得到真实的出栈顺序（栈内部不导出，这是唯一的观测方式） */
const drainOrder = (handles: { id: number; remove: () => void }[]): number[] => {
  const order: number[] = [];
  const live = [...handles];
  while (live.length > 0) {
    const top = topLayerId();
    order.push(top);
    const hit = live.find((h) => h.id === top);
    if (!hit) throw new Error(`栈顶 ${top} 不在已入栈清单里 = 层泄漏`);
    hit.remove();
    live.splice(live.indexOf(hit), 1);
  }
  return order;
};

describe("层栈入栈顺序（v2.5.8 D10 lowest 置底）", () => {
  beforeEach(() => clearStackForTest());

  it("普通层后入栈即在栈顶——原有语义不动", () => {
    const a = pushLayer({});
    const b = pushLayer({});
    expect(topLayerId()).toBe(b.id);
    expect(isTop(a.id)).toBe(false);
    expect(isTop(b.id)).toBe(true);
  });

  it("置底层后入栈**不得**抢栈顶（lowest 生效的唯一判据）", () => {
    const modal = pushLayer({});
    const bar = pushLayer({ lowest: true });
    // 修复前这里必红：pushLayer 走 stack.push，后入栈的浮条反而压在弹窗上
    expect(topLayerId(), "置底层抢了栈顶 = lowest 是死代码").toBe(modal.id);
    expect(isTop(bar.id), "浮条在栈顶会让弹窗丢掉 isTop 驱动的焦点困守").toBe(false);
  });

  it("多条置底层之间后开先关，且整体仍垫在所有普通层之下", () => {
    const low1 = pushLayer({ lowest: true });
    const low2 = pushLayer({ lowest: true });
    const modal = pushLayer({});
    expect(drainOrder([low1, low2, modal])).toEqual([modal.id, low2.id, low1.id]);
  });

  it("先开的普通层不被后到的置底层盖住：出栈顺序 = 弹窗们先清完再轮到浮条", () => {
    const m1 = pushLayer({});
    const m2 = pushLayer({});
    const bar = pushLayer({ lowest: true });
    expect(drainOrder([m1, m2, bar])).toEqual([m2.id, m1.id, bar.id]);
  });

  it("全是置底层时照常后开先关（没有普通层时插到末尾）", () => {
    const b1 = pushLayer({ lowest: true });
    const b2 = pushLayer({ lowest: true });
    expect(drainOrder([b1, b2])).toEqual([b2.id, b1.id]);
  });

  it("remove 后不留残层，栈空时 topLayerId 归 0", () => {
    const a = pushLayer({});
    const b = pushLayer({ lowest: true });
    b.remove();
    a.remove();
    expect(topLayerId()).toBe(0);
  });
});

describe("Esc 只派栈顶（v2.5.8 D10/D11 消费顺序：弹出层 > 弹窗 > 页面）", () => {
  beforeEach(() => clearStackForTest());

  it("栈顶是普通层时，置底层的 onEscape 不得被叫", () => {
    const onModal = vi.fn();
    const onBar = vi.fn();
    const modal = pushLayer({ onEscape: onModal });
    pushLayer({ onEscape: onBar, lowest: true });
    const { prevented } = dispatchEscapeForTest();
    expect(prevented, "有层可派却不消费 = 页面级 Esc 会跟着一起触发").toBe(true);
    expect(onModal).toHaveBeenCalledTimes(1);
    expect(onBar, "置底层抢消费 = 右键菜单还挂着就先把选中清了").not.toHaveBeenCalled();
    modal.remove();
  });

  it("弹窗关掉后，Esc 才轮到置底的浮条清选中", () => {
    const onModal = vi.fn();
    const onBar = vi.fn();
    const modal = pushLayer({ onEscape: onModal });
    pushLayer({ onEscape: onBar, lowest: true });
    modal.remove();
    dispatchEscapeForTest();
    expect(onBar).toHaveBeenCalledTimes(1);
    expect(onModal).not.toHaveBeenCalled();
  });

  it("空栈按 Esc：不消费也不抛（键原样放行给页面/浏览器）", () => {
    const { prevented } = dispatchEscapeForTest();
    expect(prevented).toBe(false);
  });
});
