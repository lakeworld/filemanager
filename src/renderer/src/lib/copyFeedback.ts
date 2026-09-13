/**
 * 复制文件到系统剪贴板的**反馈文案**单点（v2.5.8 D19 / 体验批 B1）。
 *
 * 为什么又抽一份 lib（同 `lib/selectionBar.ts` 口径）：B1 的缺陷不是「没反馈」，
 * 而是**同一个动作用了三种反馈**——
 *  - 文件浏览器 / 图包库 / 证书库 / 笔记库：组件内 `showActionMessage` 内联条（2s 自消）；
 *  - 搜索页 / 预览弹窗：**只有失败才报**，成功静默（用户按了没反应，只能再按一次）；
 *  - 发票 / 入库 / 报价 / 报价详情 / 批量识别 五处右键「复制」：`void api.…()`，**成功失败全静默**。
 * 三套并存 ⇒ 同一个「复制」在不同页面给人的确定感完全不同。这里把口径钉成一处：
 * **成功与失败都必须出声**，文案由本函数生成，动作与 toast 见 `utils/copyAction.ts`。
 *
 * 文案里保留「到剪贴板」三个字不是啰嗦：`tests/e2e/clipboard-guard.spec.ts:105/234` 就靠这句
 * 判定「Ctrl+C 走的是文件复制路径而不是被文本选区吞掉」，换词会直接把那条守卫打成瞎子。
 */

/** 各域的中文量词（默认「个文件」；笔记页历史上就叫「篇笔记」，统一后口径不变） */
export const COPY_NOUN = {
  file: "个文件",
  note: "篇笔记",
} as const;

/**
 * 成功反馈标题：`已复制 3 个文件到剪贴板`。
 * `count <= 0` 时返回空串 = **调用方不该弹任何东西**（空选区按 Ctrl+C 静默，
 * 这条与替换前各页的 `if (paths.length === 0) return` 守卫同义，只是收进文案层钉住）。
 */
export function copyFeedbackTitle(count: number, noun: string = COPY_NOUN.file): string {
  if (count <= 0) return "";
  return `已复制 ${count} ${noun}到剪贴板`;
}

/** 失败反馈标题（全站统一一句，具体原因走 toast 的 body） */
export const COPY_ERROR_TITLE = "复制失败";

/** 失败兜底文案：IPC 没给 error 时说人话，不显示 undefined */
export const COPY_ERROR_FALLBACK = "剪贴板不可用或剪贴板工具缺失";

/**
 * 从 `ApiResult` 形状的结果算出该弹什么（纯函数，供 `utils/copyAction.ts` 用，也供单测钉）。
 * 返回 `null` = 什么都不弹（空选区）。
 */
export function copyFeedbackToast(
  count: number,
  result: { success: boolean; error?: string | null } | null,
  noun: string = COPY_NOUN.file,
): { tone: "success" | "error"; title: string; body?: string } | null {
  if (count <= 0) return null;
  if (result?.success) return { tone: "success", title: copyFeedbackTitle(count, noun) };
  return { tone: "error", title: COPY_ERROR_TITLE, body: result?.error || COPY_ERROR_FALLBACK };
}
