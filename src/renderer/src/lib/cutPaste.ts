/**
 * 应用内「剪切 = 移动」的状态机（v2.5.8 D19 / 体验批 B7）。
 *
 * 边界（用户 2026-09-12 拍板，PLAN §五 B7 原文）：**只做应用内移动语义，不做剪切到外部**。
 * 把 Ctrl+X 真接进系统剪贴板，用户就会把它粘到资源管理器/微信里——文件被移出工作区后
 * 元数据、标签、台账引用全断，属"看起来是标准快捷键、实际会毁数据"的那类坑。
 * 所以这里的"剪贴板"是**渲染层内部的一个路径数组信号**，外部程序看不见它；
 * 外发永远走「复制」（Ctrl+C，住 `hooks/useCopyShortcut.ts`）。
 *
 * 状态转移（`markCut` 是 Ctrl+X，`reconcile` 是选中集变化后的对账，`afterMove` 是移动成功）：
 *   按 Ctrl+X ─┬─ 与当前标记同一批 → 取消（再按一次反选，多数编辑器的习惯）
 *              └─ 否则 → 标记成新选的这批
 *   选中变了 ─┬─ 新选中 ≠ 标记 → 标记作废（用户已经在操作别的文件了，旧的"待移动"不该悄悄生效）
 *             └─ 新选中 = 标记 → 保留
 *   移动成功 → 标记清空（否则再按 Ctrl+V 会把已移走的原路径再搬一次，报"文件不存在"）
 *
 * 三处都按**集合**比较而不是数组顺序：选中顺序随点击次序变，但"哪几个文件"没变。
 */

/** 归一成一个键：分隔符与大小写差异不该让同一批文件被认成两批（Win 路径不区分大小写） */
function keyOf(paths: string[]): string {
  return [...paths].map((p) => p.replace(/\\/g, "/").toLowerCase()).sort().join("\n");
}

/** 两批路径是否是同一集合（顺序无关） */
export function sameCutSet(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  return keyOf(a) === keyOf(b);
}

/**
 * Ctrl+X：把当前选中记为"待移动"。
 * 空选中不标记（否则标记被清成空、还看不出原因）；与现标记同一批则取消标记。
 */
export function markCut(current: string[], selected: string[]): string[] {
  if (selected.length === 0) return current;
  if (sameCutSet(current, selected)) return [];
  return [...selected];
}

/** 选中集变化后对账：不再是同一批就作废（**清空选中不算改选**，见下方注释） */
export function reconcileCut(current: string[], selected: string[]): string[] {
  if (current.length === 0) return current;
  // 空选中不清标记：换子文件夹 / 刷新列表都会把选中清成空，而「在 A 目录 Ctrl+X →
  // 走到 B 目录 Ctrl+V」正是本功能的主路径。只有用户**改去选了别的文件**才算改主意。
  if (selected.length === 0) return current;
  return sameCutSet(current, selected) ? current : [];
}

/** 移动成功 / Esc / 主动取消：一律清空 */
export function clearCut(): string[] {
  return [];
}

/**
 * 应用内剪切标记与「系统剪贴板粘贴导入」（B3）的优先级。
 * 两条链路共用一个 Ctrl+V：手里有"待移动"的标记时先满足移动，否则才去读系统剪贴板导文件。
 * 反过来说，标记存在时**不**去读系统剪贴板——用户按 Ctrl+X 再 Ctrl+V，绝不会想要导入。
 */
export type PasteIntent = "move" | "import";
export function pasteIntent(cutPaths: string[]): PasteIntent {
  return cutPaths.length > 0 ? "move" : "import";
}
