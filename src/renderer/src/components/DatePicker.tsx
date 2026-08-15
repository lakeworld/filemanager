import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { pushLayer } from "~/components/ui/layerStack";

/**
 * 日期选择器（v2.3.x UI 统一批，复刻 ERP DateField + CalendarPicker 交互）。
 * props.value 为 YYYY-MM-DD 或空串；选择日期 → onChange('YYYY-MM-DD')，清空 → onChange('')。
 * 面板经 Portal 渲染到 body + position:fixed（宿主弹窗 overflow-auto 不会裁剪），
 * 坐标取自触发元素 getBoundingClientRect()，bottom-left 对齐；越界时自动翻转
 * （右缘越界右对齐、下缘越界在触发元素上方展开）；滚动/窗口变化/外部点击/ESC 关闭。
 */
export default function DatePicker(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [view, setView] = createSignal<{ year: number; month: number }>({ year: 0, month: 0 });
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let triggerEl: HTMLButtonElement | undefined;
  let panelEl: HTMLDivElement | undefined;

  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  function toDateKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 解析 YYYY-MM-DD（非法日期如 02-30 返回 null） */
  function parseValue(v: string): Date | null {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const d = new Date(year, month, day);
    return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
  }

  // 面板尺寸常量：w-64 面板宽 256px；高度按头部 + 星期 + 6 行网格 + 底部按钮估算
  const PANEL_W = 256;
  const PANEL_H = 336;

  const openPanel = () => {
    // 打开时视图锚定当前值（无值则今天）
    const anchor = parseValue(props.value) ?? new Date();
    setView({ year: anchor.getFullYear(), month: anchor.getMonth() });
    const rect = triggerEl?.getBoundingClientRect();
    if (!rect) {
      setPos({ left: 0, top: 0 });
      setIsOpen(true);
      return;
    }
    // 边缘翻转：右缘越界 → 面板右对齐触发元素右缘；下缘越界 → 在触发元素上方展开
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + PANEL_W > window.innerWidth) {
      left = Math.max(6, rect.right - PANEL_W);
    }
    if (top + PANEL_H > window.innerHeight) {
      top = Math.max(6, rect.top - 6 - PANEL_H);
    }
    setPos({ left, top });
    setIsOpen(true);
  };

  const toggle = () => {
    if (isOpen()) {
      setIsOpen(false);
    } else {
      openPanel();
    }
  };

  const select = (d: Date) => {
    props.onChange(toDateKey(d));
    setIsOpen(false);
  };

  const clearDate = () => {
    props.onChange("");
    setIsOpen(false);
  };

  const changeMonth = (delta: number) => {
    setView((v) => {
      const month = v.month + delta;
      if (month < 0) return { year: v.year - 1, month: 11 };
      if (month > 11) return { year: v.year + 1, month: 0 };
      return { year: v.year, month };
    });
  };

  function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // 日期网格：周日起始，补齐前月/后月，共 42 格（6 周）
  const cells = () => {
    const { year, month } = view();
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const today = new Date();
    const result: { date: Date; day: number; currentMonth: boolean; today: boolean; selected: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      result.push({
        date,
        day: date.getDate(),
        currentMonth: date.getMonth() === month,
        today: isSameDay(date, today),
        selected: props.value === toDateKey(date),
      });
    }
    return result;
  };

  // v2.5.1（T3 波3，D2）：弹出层入层栈——Esc 归属栈顶（弹出层 > 弹窗 > 页面）；
  // 自身 Esc 监听仅在层栈未消费（defaultPrevented=false）时兜底关闭
  createEffect(() => {
    if (!isOpen()) return;
    const layer = pushLayer({ onEscape: () => setIsOpen(false) });
    onCleanup(() => layer.remove());
  });

  // 点击外部 / ESC / 滚动（捕获内层滚动容器）/ 窗口变化 → 关闭
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // 层栈已消费（如 Modal 栈顶）
      setIsOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelEl && panelEl.contains(target)) return;
      if (triggerEl && triggerEl.contains(target)) return;
      setIsOpen(false);
    };
    const close = () => setIsOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    });
  });

  return (
    <>
      <button
        ref={triggerEl}
        type="button"
        class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm flex items-center gap-2 bg-white hover:border-surface-300 transition-colors"
        onClick={toggle}
      >
        <span class="text-surface-400 shrink-0">📅</span>
        <span class={`flex-1 text-left truncate ${props.value ? "text-surface-900" : "text-surface-400"}`}>
          {props.value || props.placeholder || "选择日期"}
        </span>
        <Show when={props.value}>
          <span
            class="text-surface-400 hover:text-danger-600 shrink-0 px-1"
            role="button"
            aria-label="清空日期"
            onClick={(e) => {
              e.stopPropagation();
              clearDate();
            }}
          >
            ✕
          </span>
        </Show>
      </button>

      <Portal>
        <Show when={isOpen()}>
          <div
            ref={panelEl}
            class="fixed z-[70] bg-white rounded-xl shadow-lg border border-surface-200 p-3 w-64"
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 年月切换 */}
            <div class="flex items-center justify-between mb-2">
              <button
                type="button"
                class="w-7 h-7 flex items-center justify-center rounded-md text-surface-500 hover:bg-surface-100 hover:text-primary-600 transition-colors"
                aria-label="上个月"
                onClick={() => changeMonth(-1)}
              >
                ◀
              </button>
              <div class="text-sm font-medium text-surface-900">
                {view().year}年{view().month + 1}月
              </div>
              <button
                type="button"
                class="w-7 h-7 flex items-center justify-center rounded-md text-surface-500 hover:bg-surface-100 hover:text-primary-600 transition-colors"
                aria-label="下个月"
                onClick={() => changeMonth(1)}
              >
                ▶
              </button>
            </div>

            {/* 星期表头 */}
            <div class="grid grid-cols-7 mb-1">
              <For each={WEEKDAYS}>
                {(d) => <span class="text-center text-xs text-surface-400 h-6 leading-6">{d}</span>}
              </For>
            </div>

            {/* 日期网格 */}
            <div class="grid grid-cols-7 gap-0.5">
              <For each={cells()}>
                {(c) => (
                  <button
                    type="button"
                    class={`h-8 text-xs rounded-md transition-colors ${
                      c.selected
                        ? "bg-primary-500 text-white font-bold hover:bg-primary-600"
                        : c.currentMonth
                          ? "text-surface-700 hover:bg-surface-100"
                          : "text-surface-300 hover:bg-surface-100"
                    } ${c.today && !c.selected ? "font-bold text-primary-600" : ""}`}
                    onClick={() => select(c.date)}
                  >
                    {c.day}
                  </button>
                )}
              </For>
            </div>

            {/* 底部：清空日期 */}
            <div class="flex justify-end pt-2 mt-2 border-t border-surface-100">
              <button
                type="button"
                class="text-xs text-surface-400 px-2 py-1 rounded-md hover:bg-danger-50 hover:text-danger-600 transition-colors"
                onClick={clearDate}
              >
                清空日期
              </button>
            </div>
          </div>
        </Show>
      </Portal>
    </>
  );
}
