/**
 * 预览连续切换的纯逻辑（v2.5.8 D18）。
 *
 * 与 `lib/searchSelect.ts`、`lib/selectionBar.ts` 同一分层口径：「算哪一张」是可测纯函数，
 * 「怎么换」才住 store 与组件。`stores/preview.ts` 的 `navigatePreview` 只做两件事——
 * 问这里要下一个下标，然后把那张交给**现成的** `openPreview`。
 *
 * 为什么单拆：本仓 vitest 是 `environment: 'node'` 且没配 `~` 别名，而
 * `stores/preview.ts:2` 顶层就 `import { api } from "~/wails/api"`（`api.ts:63` 读 `window.qihebox`）
 * ⇒ store 在单测里 import 即抛。导航判定是这次唯一有新算法的地方（代际守卫、会话复位全部
 * 复用 v2.5.3 T7 的既有链），把它抽成零依赖纯函数，才能在单测里把矩阵钉死。
 *
 * 边界语义（2026-09-13 用户拍板 #1）：**循环绕回**——最后一张再按 → 回第一张，
 * 对齐主流看图器；不做「到头停 + 按钮禁用」。
 */

/** 只用到 `path`：列表项可以是 `FileEntry`，也可以是台账行映射出的浅对象 */
export interface PreviewNavItem {
  path: string
}

/**
 * 当前文件在「打开瞬间的可见列表快照」里的下标。
 * `-1` = 没有列表（调用方是单文件场景）、空列表、或**快照过期**（预览期间文件被外部改名/删除）。
 * 按 `path` 比对而非对象引用：调用方每次筛选/排序都会产生新数组，引用比对会假性过期。
 */
export function previewIndexOf(
  list: readonly PreviewNavItem[] | undefined | null,
  currentPath: string | undefined | null,
): number {
  if (!list || list.length === 0) return -1
  if (!currentPath) return -1
  return list.findIndex((item) => item.path === currentPath)
}

/**
 * 下一次导航的下标；`null` = 不该动（静默返回，不报错）。
 * 四条「不动」守卫：未传列表 / 空列表 / 列表长度 1 / 快照过期（当前项不在列表里）。
 * 循环 = `(idx + delta + N) % N`：加 N 是让 `-1` 的取模落在正区间（JS 的 `%` 会跟着被除数符号）。
 */
export function nextPreviewIndex(
  list: readonly PreviewNavItem[] | undefined | null,
  currentPath: string | undefined | null,
  delta: 1 | -1,
): number | null {
  if (!list || list.length <= 1) return null
  const idx = previewIndexOf(list, currentPath)
  if (idx < 0) return null
  return (idx + delta + list.length) % list.length
}

/** 弹窗是否该显示 ◀▶ 按钮与位置指示（与 `nextPreviewIndex` 同源判据，不留第二份） */
export function canPreviewNav(
  list: readonly PreviewNavItem[] | undefined | null,
  currentPath: string | undefined | null,
): boolean {
  return nextPreviewIndex(list, currentPath, 1) !== null
}

/** 标题旁的 `i+1 / N` 位置指示（1 基）。下标 <0 或总数 <=0 → 空串 = 不显示。 */
export function previewPositionLabel(index: number, total: number): string {
  if (index < 0 || total <= 0) return ""
  return `${index + 1} / ${total}`
}

/**
 * 导航落点 + 要原样带过去的 context。
 * `context` 返回**同一引用**（不浅拷贝）：里面挂着调用方传的 `onDelete` 回调与 `list` 快照，
 * 拷一份就把「预览里删完要刷新列表」这条链切断了。
 */
export function planPreviewNav<
  TItem extends PreviewNavItem,
  TCtx extends { list?: readonly TItem[] },
>(
  list: readonly TItem[] | undefined | null,
  currentPath: string | undefined | null,
  delta: 1 | -1,
  context: TCtx,
): { file: TItem; context: TCtx } | null {
  const next = nextPreviewIndex(list, currentPath, delta)
  if (next === null || !list) return null
  return { file: list[next], context }
}
