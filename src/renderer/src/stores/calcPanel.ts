import { createSignal } from "solid-js";

/**
 * 计算面板开关（v2.5.9/A7「计算」）。
 *
 * 为什么开关要活在组件之外（文件级信号）而不是 `createSignal` 塞在 CalcPanel 里：唤起入口有
 * **两个**——侧栏「工具 → 计算」项与全局快捷键 `Ctrl+=`（PLAN-v2.6-计算 §八③ 拍板）——两处都得在
 * 面板**还没挂载**时把它调起来，状态只能住在组件外面。
 *
 * 面板本体（`components/CalcPanel.tsx`）在 `calcPanelOpen()` 为真时才挂载，于是「入层栈 / 输入框聚焦 /
 * 拉历史」全部跟着挂载走，关闭即整体卸载，不留跨次残留（与 `ui/Modal` 的 Show 语义同款）。
 *
 * 写法照 `stores/notifyBanner.ts`（createSignal + 具名导出）+ `stores/preview.ts` 的 open/close 配对：
 * 关闭只认一个入口，Esc / 点遮罩 / 右上 ✕ 三处行为一致。
 */
const [calcPanelOpen, setCalcPanelOpen] = createSignal(false);

export { calcPanelOpen };

/** 打开面板（幂等：已开着再调不重置内容——草稿与历史由面板自己持有） */
export function openCalcPanel(): void {
  setCalcPanelOpen(true);
}

/** 关闭面板（Esc / 点遮罩 / 右上 ✕ 三处共用） */
export function closeCalcPanel(): void {
  setCalcPanelOpen(false);
}