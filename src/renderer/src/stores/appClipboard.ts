import { createSignal } from "solid-js";
import { clearCut, markCut, reconcileCut } from "~/lib/cutPaste";

/**
 * 应用内「剪切」标记（v2.5.8 D19 / 体验批 B7）。
 *
 * 为什么住 store 而不是文件浏览器组件的本地 signal：剪切的典型用法是
 * **在 A 文件夹按 Ctrl+X、走到 B 文件夹按 Ctrl+V**，而每次换子文件夹都是一次路由跳转，
 * 组件本地状态会在跳转中丢掉 ⇒ 这个标记必须活过路由。放模块级 signal 是全应用单例，
 * 与「同一时刻只有一批待移动文件」的真实语义一致（系统剪贴板也只有一个）。
 *
 * 状态转移的判据全部住 `lib/cutPaste.ts`（纯函数、有单测），本文件只做接线。
 */
const [cutPaths, setCutPaths] = createSignal<string[]>([]);

export { cutPaths };

/** Ctrl+X：把选中这批记为待移动；与现标记同一批则取消（返回是否真的标记上了，供反馈文案用） */
export function applyCut(selected: string[]): string[] {
  const next = markCut(cutPaths(), selected);
  setCutPaths(next);
  return next;
}

/** 选中集变化后对账：用户改去选别的文件了，旧标记作废（免得 Ctrl+V 悄悄搬一批他没在看的文件） */
export function syncCutWithSelection(selected: string[]): void {
  const next = reconcileCut(cutPaths(), selected);
  if (next !== cutPaths()) setCutPaths(next);
}

/** 移动成功 / Esc / 切页：清空 */
export function resetCut(): void {
  const next = clearCut();
  if (next !== cutPaths()) setCutPaths(next);
}
