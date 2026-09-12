/**
 * SearchSelect（v2.5.8 W4 提前投产，PLAN §三 W4）纯逻辑单测。
 *
 * 组件本体是 Solid 渲染层，本仓无组件级渲染测试基建（先例：moneyInput/dateQuickPicks 同样只测抽出的纯函数），
 * 故把「过滤 / 键盘高亮推进 / 是否显示搜索框 / 弹层定位翻转」四件事抽到 src/renderer/src/lib/searchSelect.ts 直测。
 * 弹层与层栈接线（pushLayer/Esc/点外关闭）由 e2e 覆盖（tests/e2e/search-select.spec.ts）。
 *
 * v2.5.8 复审 r2 追加两组（修「设置页关掉后键盘仍能改值」那条 A-1/A-2），口径如实分三档：
 *  1) `pick()` 的提交判定——**真跑生产代码**：把 SearchSelect.tsx 里 pick 的函数体原文取出来
 *     `new Function` 执行（不是抄一份进测试，抄的那份永远绿、没有意义）。这能真正验到
 *     「同值不提交 / disabled 不提交 / 同值仍收起面板」。
 *  2) 「触发器是不是真 disabled」——**源码形态门禁**（先例 = uiInventory / uiScan 读源码文本把关）：
 *     本仓 vitest 是纯 node 环境（`vitest.config.ts` 无 DOM、无 solid 插件、`~/` 别名不可解析，
 *     实测 import 组件即失败），且「组件不许为可测而新造渲染基建」，故只钉形状，不声称验到行为。
 *  3) 「键盘 Tab 不动、鼠标点不动」——**必须靠 e2e**（真焦点序列 + 真事件派发，本文件验不了），
 *     交接清单写在本文件最末尾的注释块里，由主线程重建产物后补跑。
 */
import { describe, it, expect } from "vitest";
import {
  filterOptions,
  moveHighlight,
  moveHighlightSkipped,
  autoSearchable,
  panelPosition,
  type SearchSelectOption,
} from "../../src/renderer/src/lib/searchSelect";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("moveHighlightSkipped（↑↓ 跳过不可选项，v2.5.8 D9 选项级 disabled）", () => {
  // 唯一使用者 = 入库单弹窗的「供应商已删除」占位项（原生 select 用 <option disabled> 表达）
  const MIXED: SearchSelectOption[] = [
    { value: "a", label: "甲" },
    { value: "gone", label: "乙（已删除）", disabled: true },
    { value: "c", label: "丙" },
  ];

  it("向前推进跳过 disabled 项（0 → 2，不停在 1）", () => {
    expect(moveHighlightSkipped(MIXED, 0, 1)).toBe(2);
  });

  it("向后推进同样跳过", () => {
    expect(moveHighlightSkipped(MIXED, 2, -1)).toBe(0);
  });

  it("尚未高亮时进入：↓ 落首个可选项、↑ 落末个可选项", () => {
    expect(moveHighlightSkipped(MIXED, -1, 1)).toBe(0);
    expect(moveHighlightSkipped(MIXED, -1, -1)).toBe(2);
  });

  it("末尾绕回仍落到可选项", () => {
    expect(moveHighlightSkipped(MIXED, 2, 1)).toBe(0);
  });

  it("空列表 / 全部 disabled → -1（与 moveHighlight 一样不给 NaN 高亮）", () => {
    expect(moveHighlightSkipped([], 0, 1)).toBe(-1);
    expect(moveHighlightSkipped([{ value: "x", disabled: true }], -1, 1)).toBe(-1);
    expect(moveHighlightSkipped([{ value: "x", disabled: true }, { value: "y", disabled: true }], 0, 1)).toBe(-1);
  });

  it("全部可选项时与 moveHighlight 逐点等价（既有语义一字未改）", () => {
    const all: SearchSelectOption[] = [{ value: "1" }, { value: "2" }, { value: "3" }];
    for (const cur of [-1, 0, 1, 2]) {
      for (const d of [1, -1]) {
        expect(moveHighlightSkipped(all, cur, d)).toBe(moveHighlight(all.length, cur, d));
      }
    }
  });
});

/* -----------------------------------------------------------------------------
 * v2.5.8 复审 r2 A-1/A-2（设置页关掉后键盘仍能改值 + 换壳引入的同值多触发）
 * 三档验证口径见本文件头注释：① pick 跑生产源码函数体 ② 触发器 disabled 走源码形态门禁
 * ③ 焦点/按键行为归 e2e（文件末尾交接清单）。
 * -------------------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SS_SRC = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/ui/SearchSelect.tsx"), "utf8");
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, "src/renderer/src/pages/Settings.tsx"), "utf8");

/** 触发器那段 `<button …>`：从开标签起、到它自己的 onKeyDown 止，整段就是它的属性面 */
function triggerTag(src: string): string {
  const start = src.indexOf("<button");
  const end = src.indexOf("onKeyDown={onTriggerKeyDown}", start);
  if (start < 0 || end < start) throw new Error("找不到 SearchSelect 的触发器按钮：本门禁的文本定位要跟着改（不是回归，是维护）");
  return src.slice(start, end);
}

type PickProps = { value: string; disabled?: boolean; onChange: (v: string) => void };
type PickFn = (opt: SearchSelectOption, props: PickProps, close: () => void) => void;

/**
 * 把生产文件里 pick() 的函数体**原文**取出来执行。
 * 为什么不在测试里抄一份同逻辑：抄的那份与生产各写各的，生产哪天删掉守卫，抄的这份照样绿 = 假绿。
 * 抽取失败时明确报「是维护不是回归」，绝不静默跳过。
 */
function loadPick(src: string): PickFn {
  const body = /const pick = \(opt: SearchSelectOption\) => \{\n([\s\S]*?)\n  \};/.exec(src);
  if (!body) throw new Error("pick() 的函数体形状变了：本用例靠文本抽取生产源码来跑它，请跟着改这一行（不是回归，是维护）");
  return new Function("opt", "props", "close", body[1]) as PickFn;
}

describe("pick()：控件级 disabled 与同值早退（执行的是生产源码函数体）", () => {
  const pick = loadPick(SS_SRC);
  /** 一次提交的可观测面 = 写回了几次值 + 面板收起几次 */
  const run = (opt: SearchSelectOption, props: { value: string; disabled?: boolean }) => {
    const committed: string[] = [];
    let closes = 0;
    pick(opt, { ...props, onChange: (v) => committed.push(v) }, () => {
      closes++;
    });
    return { committed, closes };
  };

  it("选不同值：提交一次并收起面板（既有语义不变）", () => {
    expect(run({ value: "7" }, { value: "3" })).toEqual({ committed: ["7"], closes: 1 });
  });

  it("选回当前值：不提交，但面板照常收起（原生 <select> 对同一项不触发 change）", () => {
    expect(run({ value: "7" }, { value: "7" })).toEqual({ committed: [], closes: 1 });
  });

  it("「全部」空串哨兵同值：同样不提交（筛选行最常见的一次误点）", () => {
    expect(run({ value: "" }, { value: "" })).toEqual({ committed: [], closes: 1 });
  });

  it("选项级 disabled：不提交也不收起（D9 既有语义一字未改）", () => {
    expect(run({ value: "gone", disabled: true }, { value: "a" })).toEqual({ committed: [], closes: 0 });
  });

  it("控件级 disabled：面板即便因别的原因开着，也提交不出值", () => {
    expect(run({ value: "7" }, { value: "3", disabled: true })).toEqual({ committed: [], closes: 0 });
  });
});

describe("触发器 disabled 能力（源码形态门禁，先例 = uiInventory/uiScan）", () => {
  const tag = triggerTag(SS_SRC);

  it("props 接口上有 disabled 这一等公民（页面才不必再自己糊一层）", () => {
    expect(SS_SRC).toMatch(/\n  disabled\?: boolean;/);
  });

  it("触发器挂的是真 disabled 属性，不是 classList 里的把戏", () => {
    expect(tag).toContain("disabled={props.disabled}");
    expect(tag).not.toMatch(/classList|pointer-events/);
  });

  it("禁用态材质档对齐 .input（半透 + 不允许光标），不是只有行为没有观感", () => {
    expect(tag).toContain("disabled:opacity-50");
    expect(tag).toContain("disabled:cursor-not-allowed");
  });
});

describe("页面侧不得再绕过底座门控（AGENTS.md §一.8；A-1 那处糊法的回归守）", () => {
  it("Settings.tsx 全文不再出现 pointer-events", () => {
    expect(SETTINGS_SRC).not.toMatch(/pointer-events/);
  });

  it("「提前提醒天数」改成给组件传 disabled（门控仍在，只是换了正确表达）", () => {
    const at = SETTINGS_SRC.indexOf('ariaLabel="提前提醒天数"');
    expect(at, "调用点定位：设置页这条下拉不见了").toBeGreaterThan(-1);
    const call = SETTINGS_SRC.slice(SETTINGS_SRC.lastIndexOf("<SearchSelect", at), at);
    expect(call).toContain("disabled={!prefReady()}");
  });
});

/**
 * 留给主线程的 e2e 交接清单（本文件验不了的部分，重建产物后补跑）：
 * 建议在 `tests/e2e/app-settings.spec.ts` 现有「提前提醒天数」那一组旁边加一条「未就绪 = 真的改不动」：
 *  1. 未就绪态（拦截/延后 `qihebox.settings.getAll` 回包，让 `appSettingsReady` 保持 false）下
 *     `getByRole('button', { name: '提前提醒天数' })` 必须 `toBeDisabled()`——这一条同时守住
 *     「不是靠 pointer-events 糊的」（糊法的 button 不禁用，Playwright 会照常点到它）。
 *  2. 键盘路径：`.focus()` 后焦点必须落不回该按钮（`document.activeElement` 不等于它），
 *     再按 Tab + Enter + ArrowDown/ArrowUp 一轮后，存储里的 `certReminderDays` 仍等于进入页面时的值
 *     （用 `qihebox.settings.getAll` 读回，别读 DOM——读 DOM 与信号分叉是本仓明文禁的）。
 *  3. 鼠标路径：disabled 的按钮上 Playwright 的 `click()` 会卡在「等它可点」直到超时，所以这条只写
 *     `expect(...).toBeDisabled()`，别去真点；反向守 = 就绪后（getAll 回包到位）同一组定位重新可点、
 *     且**选同值不再触发保存**（断言 `settings.set` 调用次数不增加，或读回落盘值未变）——
 *     这一条才是 A-2「同值早退」在真链路上的验收（单测那五条只验到 pick 的判定本身）。
 */
