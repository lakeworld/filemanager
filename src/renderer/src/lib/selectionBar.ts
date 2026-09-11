/**
 * 悬浮多选条的纯逻辑（v2.5.8 D10 / 精致化 W5）。
 *
 * 为什么单拆一份 lib：与 `lib/searchSelect.ts`、`lib/moneyInput.ts` 同一分层口径——
 * 「算什么样」是可测纯函数，「长什么样」才住组件。浮条里有两处会漂：
 * ① 计数文案的量词（个文件 / 张发票 / 条入库单 / 篇笔记 / 条报价），七页各写一份必出第三种写法；
 * ② 动作按钮的三档材质（default / primary / danger），原先散在七个副本里各拼长串。
 * 两者都收在这里，组件只做组装。
 */

/** 三档动作材质（与 `.btn-primary` / `.btn-secondary` 同源色族，但浮条要更紧凑的 py-1.5 档） */
export type SelectionActionTone = "default" | "primary" | "danger";

/**
 * 动作按钮材质单点。
 * danger 用 `bg-danger-500 hover:bg-danger-600`——沿用替换前七个副本里删除键的同一串，
 * 一字未改（W5 替换纪律：按钮文案与语义零改动，e2e 按 text 定位才能全绿）。
 */
export const SELECTION_ACTION_CLASS: Record<SelectionActionTone, string> = {
  default:
    "px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg whitespace-nowrap",
  primary: "px-3 py-1.5 text-sm text-white bg-primary-500 hover:bg-primary-600 rounded-lg whitespace-nowrap",
  danger: "px-3 py-1.5 text-sm text-white bg-danger-500 hover:bg-danger-600 rounded-lg whitespace-nowrap",
};

/** 「取消选择」是次要到不能再次要的动作，七页同款灰字无边框（替换前口径） */
export const SELECTION_CLEAR_CLASS =
  "px-3 py-1.5 text-sm text-surface-600 hover:bg-white rounded-lg whitespace-nowrap";

/**
 * 计数文案：`已选择 3 个文件`。
 *
 * 量词由调用方给（各页名词不同），但**「已选择」前缀与空格规则在这里定死**——
 * 门禁 `grep '已选择' src/renderer` 只准命中本文件的这一行模板（`ui/SelectionBar.tsx` 的
 * 命中全在注释里），靠的就是这条单点。
 */
export function selectionLabel(count: number, noun: string): string {
  return `已选择 ${count} ${noun}`;
}
