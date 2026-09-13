/**
 * 复制文件到系统剪贴板的统一动作（v2.5.8 D19 / 体验批 B1）。
 *
 * 与 `lib/copyFeedback.ts` 的分工：那边管「说什么」（纯文案，可单测），这边管「做 + 说」
 * （调 IPC + 弹全局 toast）。全站 12 个复制点里 **11 处**一律走这里，不再各自 `void api.…` /
 * 各自拼文案。唯一例外是预览弹窗内的「📋 复制文件」：它只复制当前这一张，且失败要写进**弹窗内**
 * 错误条（不是全局 toast），并保留 v2.5.3（T7）O1 的代际守卫 ⇒ 它直接复用
 * `lib/copyFeedback.ts` 的文案常量，不走本模块。
 *
 * 用**注入的复制函数**而不是本模块直接 import `~/wails/api`：`wails/api.ts:63` 在模块顶层就取
 * `window.qihebox`，本仓单测无 DOM ⇒ 直接 import 的模块进不了单测。注入后
 * 「成功与失败都要出声」这条判据本身可测（`tests/unit/copyFeedback.test.ts`），
 * 真 IPC 链路由 e2e 覆盖（`tests/e2e/copy-paste.spec.ts`）。
 *
 * 为什么反馈走全局 toast 而不是各页那条 2s 内联条：内联条挂在 `ui/SelectionBar` 的 message 槽上，
 * **只有选中文件时才存在**——而复制恰恰常在右键单选（无多选条）的场景下发生，
 * 结果就是那五处右键复制永远看不见反馈。toast 是全站唯一不受选区约束的反馈面。
 */
// 相对 import（不是 `~/`）：本模块要能在 `environment: 'node'` 的单测里被直接 import，
// 而 vitest 没配 `~` 别名（只有 electron.vite.config.ts:32 配了）。同 stores/appSettings.ts 的相对写法。
import { showToast } from "../stores/notifyBanner";
import { COPY_NOUN, copyFeedbackToast } from "../lib/copyFeedback";
import { ledgerCopyPaths } from "../lib/copyShortcut";

// 量词表随动作一起转出：调用点只需 import 本模块一行（`COPY_NOUN.note` 在笔记页用）
export { COPY_NOUN };

/**
 * 与 `api.files.copyFilesToClipboard` 同形状的最小面（便于注入假实现）。
 * `error` 写成 `string | null` 是被真实调用点逼出来的：`shared/types.ts:13` 的
 * `ApiResult.error` 是 `string | null`（主进程成功时也回 `null`），不是 `undefined`。
 */
type CopyFn = (paths: string[]) => Promise<{ success: boolean; error?: string | null }>;

/**
 * 复制并把结果说出来；返回是否成功（调用方要额外做什么时用）。
 * 空选区直接返回 false 且**不弹任何东西**——与替换前各页的 `if (paths.length === 0) return` 一致。
 */
export async function copyFilesWithFeedback(
  copy: CopyFn,
  paths: string[],
  noun: string = COPY_NOUN.file,
): Promise<boolean> {
  if (paths.length === 0) return false;
  const result = await copy(paths).catch((err: unknown) => ({
    success: false,
    // IPC 侧偶发抛异常（PowerShell/xclip 不可用时的 reject）——不吞掉，如实转成失败反馈
    error: err instanceof Error ? err.message : String(err),
  }));
  const t = copyFeedbackToast(paths.length, result, noun);
  if (t) showToast(t.tone, t.title, t.body);
  return !!result.success;
}

/**
 * 台账类（发票 / 入库 / 报价）批量条的「复制归档文件」。
 *
 * 为什么单列一个入口而不让调用点直接 `copyFilesWithFeedback(paths)`：台账一行**可以没有归档文件**
 * （只登记记录、没附文件），选中的全是这种行时路径数组是空的——直接静默返回就等于
 * 「按钮按了没反应」，正是 B1 要清的那笔账。所以这里补一句如实说明，
 * 同时把「先剔除无文件行、再去重」的口径固定在 `lib/copyShortcut.ts` 一处。
 */
export async function copyLedgerFiles<T>(
  copy: CopyFn,
  rows: T[],
  pickPath: (row: T) => string | null | undefined,
): Promise<boolean> {
  if (rows.length === 0) return false;
  const paths = ledgerCopyPaths(rows, pickPath);
  if (paths.length === 0) {
    showToast("info", `选中的 ${rows.length} 行都没有归档文件`);
    return false;
  }
  return copyFilesWithFeedback(copy, paths);
}
