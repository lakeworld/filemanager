import { Show, For, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { pushLayer } from "~/components/ui/layerStack";
import {
  filterOptions,
  moveHighlight,
  autoSearchable,
  panelPosition,
  type SearchSelectOption,
} from "~/lib/searchSelect";

/**
 * 搜索下拉（v2.5.8 W4，PLAN §三 W4 用户拍板「下拉做成搜索下拉，漂亮点」）。
 *
 * 为什么不用原生 `<select>`：原生弹层由操作系统绘制，样式不可控、无搜索、无材质，
 * 与 W0 令牌（双层影/内亮边/outExpo）脱节；且 Windows 真机形态下原生下拉外观与站内
 * 其它浮层（DatePicker/ContextMenu）不一致。
 *
 * 实现口径（全部沿用仓内已趟平的先例，不另起炉灶）：
 * - 弹层 = `Portal` 到 body + `position:fixed`，坐标由 `panelPosition` 纯函数算
 *   （越界翻转，宿主弹窗 `overflow-auto` 不裁剪）——同 `DatePicker.tsx`；
 * - Esc/点外/滚动（仅触发器所在滚动链，见 onScroll 注释）/窗口变化 关闭；
 *   Esc 语义入全局层栈 `ui/layerStack`（弹出层 > 弹窗 > 页面）；
 * - 过滤与键盘推进的逻辑在 `~/lib/searchSelect`（纯函数，单测直测 13 例）。
 * - 材质 `.glass-panel` + 双层影 + 内亮边；入场复用 W3 的 `.fade-rise`（300ms outExpo，只动
 *   transform/opacity，减弱动效偏好已在 index.css 单点坍缩）——Portal 挂载即是新节点，挂过渡类
 *   不会播放（没有类名变化可言），入场动画必须走 animation 工具类。
 *   （注：类核查脚本连注释一起扫，这里刻意不写通配过渡与媒体查询的英文字面量。）
 *   弹层面积 ≪30% 视口，不触精致化 PLAN §四 的高基数 blur 豁免线。
 *
 * 纪律：禁解构 props（D11）；动态属性一律响应式读取；不使用整属性通配 transition（W0 清零项）。
 */
export type { SearchSelectOption };

interface SearchSelectProps {
  options: readonly SearchSelectOption[];
  /** 当前值（与某项 value 相等则显示其 label） */
  value: string;
  onChange: (next: string) => void;
  /** 无值时的占位文案 */
  placeholder?: string;
  /** 触发器 aria-label（e2e getByLabel 定位口径，照 DatePicker 先例） */
  ariaLabel?: string;
  /** 紧凑模式：与工具栏其它控件等高（筛选行场景） */
  compact?: boolean;
  /** 显式决定搜索框是否显示；缺省 = 选项 >5 条才显示（autoSearchable） */
  searchable?: boolean;
  /** 触发器与面板同宽（默认 true）；窄列里可关掉让面板自适应 */
  matchTriggerWidth?: boolean;
  /** 空态文案（无匹配 vs 列表本身为空自动区分） */
  emptyText?: string;
  class?: string;
}

/** 面板估算尺寸（定位翻转用；列表内部超高走 vscroll 滚动，不随条数撑破视口） */
const PANEL_W = 256;
const PANEL_H = 300;

export default function SearchSelect(props: SearchSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [term, setTerm] = createSignal("");
  const [highlight, setHighlight] = createSignal(-1);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let triggerEl: HTMLButtonElement | undefined;
  let panelEl: HTMLDivElement | undefined;
  let searchEl: HTMLInputElement | undefined;

  const filtered = createMemo(() => filterOptions(props.options, term()));
  const showSearch = createMemo(() => autoSearchable(props.options.length, props.searchable));
  const currentLabel = createMemo(
    () => props.options.find((o) => o.value === props.value)?.label ?? props.value,
  );

  const openPanel = () => {
    setTerm("");
    const idx = props.options.findIndex((o) => o.value === props.value);
    setHighlight(idx >= 0 ? idx : -1);
    const rect = triggerEl?.getBoundingClientRect();
    if (rect) {
      setPos(panelPosition(rect, PANEL_W, PANEL_H, { w: window.innerWidth, h: window.innerHeight }));
    }
    setOpen(true);
    // 有搜索框时聚焦，输入即过滤（不必先按一次键）
    queueMicrotask(() => searchEl?.focus());
  };

  const close = () => setOpen(false);

  const pick = (opt: SearchSelectOption) => {
    props.onChange(opt.value);
    close();
  };

  /** 面板内按键：↑↓ 推进、Enter 选中高亮、其余交全局（Esc 由层栈/兜底监听处理） */
  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => moveHighlight(filtered().length, h, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered()[highlight()];
      if (opt) pick(opt);
    }
  };

  // 触发器上直接键入也能过滤（焦点还在按钮时把按键转进面板）
  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (open()) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openPanel();
      if (e.key === "ArrowUp") setHighlight((h) => moveHighlight(props.options.length, h, -1));
    }
  };

  // 过滤词变化 → 高亮回到首项（旧高亮序号在新列表里没有意义）
  createEffect(() => {
    term();
    setHighlight(filtered().length > 0 ? 0 : -1);
  });

  /**
   * 打开期间才挂全局：Esc 入层栈（与 Modal/ContextMenu/DatePicker 同一让位语义）+ 点外 /
   * 滚动 / 窗口变化 关闭。为什么不常驻 `onMount` 挂：一页要放 4–5 个下拉，常驻等于让全站
   * 每一次按键、每一个滚动容器的 scroll 都跑 5×4 个 handler；开时挂、关时清即可，
   * 且「打开那一次点击」的 mousedown 早已结束，不会被自己的点外检测关掉。
   */
  createEffect(() => {
    if (!open()) return;
    const layer = pushLayer({ onEscape: () => close() });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // 层栈已消费（例如栈顶是 Modal）
      close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelEl?.contains(target) || triggerEl?.contains(target)) return;
      close();
    };
    /**
     * 滚动关闭：只认「会让触发器移位」的滚动——document/window，或触发器的祖先滚动容器。
     * 捕获阶段监听会收到**全站任意**滚动容器的事件，早先无条件 close() 实测两处自杀：
     * ① 选项 >7 条时面板内 `.vscroll` 一翻页就把自己关掉（探针实验：面板数 1→0）；
     * ② 面板外壳是 `overflow-hidden` 的滚动盒，搜索框 focus 被浏览器 scroll-into-view 顶一下
     *   也会派发 scroll，故 e2e 里 `fill()` 偶发性整层消失（竞态，非必现）。
     */
    const onScroll = (e: Event) => {
      // 事件目标类型为 EventTarget（document 滚动的目标就是 document），不能用 Node 收窄，
      // 否则与 window 的比较在 tsc 下是 TS2367 无重叠比较
      const t = e.target as EventTarget | null;
      if (t && t !== document) {
        if (!triggerEl || !(t as Element).contains?.(triggerEl)) return;
      }
      close();
    };
    const closeAll = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeAll);
    onCleanup(() => {
      layer.remove();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeAll);
    });
  });

  const widthStyle = () =>
    props.matchTriggerWidth === false
      ? { left: `${pos().left}px`, top: `${pos().top}px` }
      : {
          left: `${pos().left}px`,
          top: `${pos().top}px`,
          width: `${Math.max(triggerEl?.getBoundingClientRect().width ?? 0, PANEL_W)}px`,
        };

  return (
    <>
      <button
        ref={triggerEl}
        type="button"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open()}
        /* 非紧凑态（表单态）恒 h-9 与 `.input`/`.select` 等高——同排字段一高一矮是"没对齐"的观感来源；
           紧凑态（筛选行）保持原 py-2 口径不动 */
        class={`flex items-center gap-2 border border-surface-200 rounded-lg bg-white text-sm hover:border-surface-300 transition-colors ${
          props.compact ? "px-2 py-2" : "px-3 h-9"
        } ${props.class ?? ""}`}
        onClick={() => (open() ? close() : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span class={`flex-1 text-left truncate ${currentLabel() ? "text-surface-900" : "text-surface-400"}`}>
          {currentLabel() || props.placeholder || "请选择"}
        </span>
        <span class={`shrink-0 text-xs text-surface-400 transition-transform duration-200 ease-out-expo ${open() ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>

      <Portal>
        <Show when={open()}>
          <div
            ref={panelEl}
            data-search-select=""
            role="listbox"
            class="fixed z-[70] glass-panel rounded-xl shadow-card overflow-hidden flex flex-col fade-rise"
            style={widthStyle()}
            onKeyDown={onPanelKeyDown}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={showSearch()}>
              <div class="p-2 border-b border-surface-100">
                <input
                  ref={searchEl}
                  data-search-input=""
                  type="text"
                  class="input w-full text-sm"
                  placeholder="搜索…"
                  value={term()}
                  onInput={(e) => setTerm(e.currentTarget.value)}
                />
              </div>
            </Show>
            <div class="vscroll max-h-[240px] overflow-y-auto p-1">
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="px-3 py-4 text-center text-xs text-surface-400">
                    {props.emptyText ?? (props.options.length === 0 ? "暂无可选项" : "无匹配结果")}
                  </div>
                }
              >
                <For each={filtered()}>
                  {(opt, i) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={opt.value === props.value}
                      data-option={opt.value}
                      class={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-lg text-left transition-colors ${
                        highlight() === i()
                          ? "bg-primary-500/10 text-surface-900"
                          : "text-surface-700 hover:bg-surface-100"
                      }`}
                      onMouseEnter={() => setHighlight(i())}
                      onClick={() => pick(opt)}
                    >
                      <span class="flex-1 truncate">{opt.label ?? opt.value}</span>
                      <Show when={opt.hint}>
                        <span class="shrink-0 text-xs text-surface-400">{opt.hint}</span>
                      </Show>
                      <Show when={opt.value === props.value}>
                        <span class="shrink-0 text-xs text-primary-600">✓</span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Show>
      </Portal>
    </>
  );
}
