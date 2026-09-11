/**
 * SearchSelect（搜索下拉）的纯逻辑层（v2.5.8 W4，PLAN §三 W4；本批随笔记库/证书库提前投产）。
 *
 * 为什么单独成文件：本仓无渲染层组件测试基建（先例 = `lib/moneyInput.ts`、`lib/dateQuickPicks.ts`
 * 一律「逻辑抽出纯函数 + node 直测，交互与层栈由 e2e 覆盖」）。组件本体在
 * `components/ui/SearchSelect.tsx`，只负责把这些函数接成 Solid 响应式。
 *
 * 契约要点：
 * - `filterOptions`：空串（含纯空白）= 全量原序，绝不因"没输入"就把列表打乱；
 *   匹配 `label ?? value`（大小写不敏感子串）；无命中返回空数组，由 UI 显式渲染「无匹配」。
 * - `moveHighlight`：0 长度恒回 -1（不给 NaN/0 的高亮）；到头到尾循环绕回。
 * - `autoSearchable`：≤5 项自动隐藏搜索框（用户拍板「下拉要做搜索下拉，漂亮点」，但两三个选项
 *   还挂个搜索框是噪声）；显式 `searchable` prop 覆盖。
 * - `panelPosition`：fixed 弹层定位 + 越界翻转，与 `DatePicker.openPanel` 同口径（那里是内联实现，
 *   本函数是把它抽出来供两处复用与直测），任何情形都不返回负坐标。
 */

export interface SearchSelectOption {
  /** 提交值（空串常作「全部」哨兵，由调用方定义语义） */
  value: string;
  /** 显示文本；缺省回退 value */
  label?: string;
  /** 右侧淡灰提示（如条数、父级路径）；不参与匹配 */
  hint?: string;
}

/** 输入即过滤：空串全量，否则按 label ?? value 大小写不敏感子串匹配，保持原顺序 */
export function filterOptions(
  options: readonly SearchSelectOption[],
  term: string,
): SearchSelectOption[] {
  const q = term.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter((o) => (o.label ?? o.value).toLowerCase().includes(q));
}

/**
 * ↑↓ 推进高亮序号。current = -1 表示尚未高亮任何项。
 * len = 0 恒回 -1；越过首/尾循环绕回。
 */
export function moveHighlight(len: number, current: number, delta: number): number {
  if (len <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : len - 1;
  const next = current + delta;
  if (next < 0) return len - 1;
  if (next >= len) return 0;
  return next;
}

/** 搜索框是否显示：显式 prop 优先，否则 >5 项才显示 */
export function autoSearchable(optionCount: number, override?: boolean): boolean {
  if (override !== undefined) return override;
  return optionCount > 5;
}

/** 触发元素几何（只取定位需要的四条边） */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  right: number;
}

/** fixed 弹层左上角坐标（面板尺寸固定估算 + 越界翻转 + 贴边留 6px） */
export function panelPosition(
  rect: AnchorRect,
  panelW: number,
  panelH: number,
  viewport: { w: number; h: number },
): { left: number; top: number } {
  const gap = 6;
  let left = rect.left;
  if (left + panelW > viewport.w) left = Math.max(gap, rect.right - panelW);
  let top = rect.bottom + gap;
  if (top + panelH > viewport.h) top = Math.max(gap, rect.top - gap - panelH);
  return { left, top };
}
