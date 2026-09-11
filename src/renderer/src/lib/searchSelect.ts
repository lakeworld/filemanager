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
  /**
   * 不可选占位项（v2.5.8 D9 控件统一 II 补的能力，唯一使用者 = 入库单弹窗
   * 「供应商已删除」灰显占位，此前由原生 `<option disabled>` 表达）。
   * 语义：仍出现在列表里且**参与过滤**（要看得到才知道为什么是它），但
   * ↑↓ 会跳过它（`moveHighlightSkipped`）、点击与 Enter 都不提交（组件侧守卫）。
   */
  disabled?: boolean;
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

/**
 * 在**可选项**之间推进高亮序号（`disabled` 项跳过），签名吃列表本身而非长度。
 *
 * 为什么不直接改 `moveHighlight` 的签名去吃 options：那函数已有 3 条单测与两处调用点，
 * 且它的「循环绕回」语义与 disabled 无关；本函数只做一层「按 `moveHighlight` 推进、
 * 撞上不可选项就继续推进，最多推进 len 步」的包装，既有语义零改动
 * （全可选项时与 `moveHighlight` 逐点等价，已由单测锁死）。
 *
 * 返回 -1 的两种情形：列表为空、或整列表都 disabled（宁可不高亮，也不让 Enter 提交出禁用项）。
 */
export function moveHighlightSkipped(
  options: readonly SearchSelectOption[],
  current: number,
  delta: number,
): number {
  const len = options.length;
  let idx = current;
  for (let step = 0; step < len; step++) {
    idx = moveHighlight(len, idx, delta);
    if (idx < 0) return -1;
    if (!options[idx].disabled) return idx;
  }
  return -1;
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
