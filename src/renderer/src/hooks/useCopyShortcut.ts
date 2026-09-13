import { onCleanup, onMount } from "solid-js";
import { shouldTakeFileCopy, yieldsToTextSelection } from "~/lib/copyShortcut";
import { registerShortcut } from "~/shortcuts";
import { clipboardGuardOn } from "~/stores/appSettings";
import { showPreview } from "~/stores/preview";

/**
 * 「Ctrl+C 复制选中文件」的统一注册口（v2.5.8 D19 / 体验批 B2）。
 *
 * 收编前的局面：这套守卫**只有一份，且住在文件浏览器组件里**（`FileBrowserView.tsx` 自带一段
 * `registerShortcut("file.copy", …)`），图包库 / 证书库 / 搜索页 / 笔记库 / 发票 / 入库 / 报价
 * 这些有选中态的页面按 Ctrl+C 毫无反应——而 `HELP.md` 把它当成全局能力在写。
 * B2 要铺到全站点，守卫就必须只有一份 ⇒ 判据抽进 `lib/copyShortcut.ts`（纯函数、可单测），
 * 本文件只做「读三个信号 + 注册一次」，`clipboardGuardOn()` 这个消费点**全仓只在本文件出现**
 * （`tests/unit/clipboardGuard-off.test.ts` 的结构钉按文件计数：两处各写一份判定就是漂移）。
 *
 * 输入框 / contenteditable 的豁免不在这里判——派发层 `guard: "text"`（`shortcuts.ts` 的
 * `isTextTarget`）已经管了，页面再判一次就是双源。
 */

/** 正文是否存在**非折叠**选区（有选中的文字 ⇒ Ctrl+C 该归浏览器）。逐行等价于 FileBrowserView 原实现 */
export function hasNonCollapsedTextSelection(): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  if (sel.rangeCount === 0) return false;
  return !sel.getRangeAt(0).collapsed;
}

/**
 * 在组件作用域内注册「Ctrl+C 复制选中文件」（七个选中态页面用这个）。
 * @param getPaths 取本页当前选中的文件绝对路径（返回空数组 = 本页不接管这个键）
 * @param onCopy   拿到路径后做什么（各页现成的 `handleCopy`：复制 + B1 的统一反馈）
 */
export function useCopyShortcut(getPaths: () => string[], onCopy: (paths: string[]) => void): void {
  onMount(() => {
    const off = registerShortcut("file.copy", () => {
      const paths = getPaths();
      if (
        !shouldTakeFileCopy({
          previewOpen: showPreview(),
          guardOn: clipboardGuardOn(),
          textSelected: hasNonCollapsedTextSelection(),
          selectedCount: paths.length,
        })
      ) {
        // 三条让位规则（预览 / 正文选区 / 零选中）逐条见 `lib/copyShortcut.ts`。
        // 这里返回 false 而不是吞掉：派发层会继续试下一个处理器，预览那条 Ctrl+C 正是这么接棒的。
        return false;
      }
      onCopy(paths);
      return true; // 交回派发层 preventDefault（与收编前 FileBrowserView 的口径一致）
    });
    onCleanup(off);
  });
}

/**
 * 预览弹窗自己那条 Ctrl+C 的注册口（B2③：预览开着时复制的是**正在预览的这一张**）。
 *
 * 为什么和页面版分开一个入口而不是复用：规则 1「预览开着就交棒」对预览自己自相矛盾
 * （它就是那个预览），规则 3「零选中放行」也不适用（要复制的就是眼前这一张）。
 * 但规则 2（A1 正文选区让位）**必须**照用——预览里选中元数据文字后按 Ctrl+C 仍是复制文本。
 * @param copyCurrent 复制当前预览文件（`FilePreviewModal` 里带代际守卫的那个 `handleCopyFile`）
 */
export function registerPreviewCopyShortcut(copyCurrent: () => void): () => void {
  return registerShortcut("file.copy", () => {
    if (!showPreview()) return false; // 预览没开着 ⇒ 这条不该管底层页面的 Ctrl+C
    if (yieldsToTextSelection(clipboardGuardOn(), hasNonCollapsedTextSelection())) return false;
    copyCurrent();
    return true;
  });
}
