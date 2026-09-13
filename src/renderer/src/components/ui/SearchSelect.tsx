import { Show, For, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { pushLayer } from "~/components/ui/layerStack";
import {
  filterOptions,
  moveHighlightSkipped,
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
 * - Esc/点外/滚动（仅触发器所在滚动链，见 onScroll 注释）/窗口变化 关闭；Esc 语义入全局层栈 ui/layerStack（弹出层 > 弹窗 > 页面）；
 * - 过滤与键盘推进的逻辑在 `~/lib/searchSelect`（纯函数，单测直测）。
 * - 材质 `.glass-panel` + 双层影 + 内亮边；入场复用 W3 的 `.fade-rise`（300ms outExpo，只动
 *   transform/opacity，减弱动效偏好已在 index.css 单点坍缩）——Portal 挂载即是新节点，挂过渡类
 *   不会播放（没有类名变化可言），入场动画必须走 animation 工具类。
 *   （注：类核查脚本连注释一起扫，这里刻意不写通配过渡与媒体查询的英文字面量。）
 *   弹层面积 ≪30% 视口，不触精致化 PLAN §四 的高基数 blur 豁免线。
 *
 * **本文件与 `ui/Select.tsx` 是站内原生 `<select>` 的唯一合法持有者**（v2.5.8 D9 定的 grep 口径：`grep '<select' src/renderer | grep -v 'components/ui/'` 必须为空）；页面/弹窗一律用本组件。
 *
 * 能力：**选项级** disabled（D9）= 占位项灰显、↑↓ 跳过、点击与 Enter 不提交；已知与原生的一处差异
 * 是悬停可让高亮**停在**占位项上（原生整项不参与高亮），但提交口全封死、不影响正确性，要逐像素对齐
 * 就改 `onMouseEnter` 为跳过。**控件级** disabled（复审 r2 A-1）= 整只禁用，见 props.disabled 一行。
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
  /**
   * 挂载即聚焦触发器（v2.5.8 D9，为设置页「标签域内联编辑」补的能力——原生那侧写的是
   * `autofocus`）。聚焦≠展开：与原生 `<select autofocus>` 一致，要展开仍需 Enter/空格/点击。
   */
  autoFocus?: boolean;
  /**
   * 面板关闭时回调（v2.5.8 D9 同批补）。用于「选中或放弃都要收起内联编辑器」这类需求，
   * 替代原生 `<select onBlur>` 的收起语义：点选项提交后、按 Esc、点外、窗口 resize 皆会触发一次。
   */
  onClose?: () => void;
  /** 整只禁用（v2.5.8 复审 r2 A-1，为设置页「偏好未就绪时值仍被键盘改走」补的能力）：触发器是真 disabled 的 button ⇒ 鼠标与键盘（Tab 聚焦 / Enter / ↑↓）一起封死、面板不弹，观感对齐 .input 的禁用档；页面侧从此不准再另写一份门控（AGENTS.md §一.8） */
  disabled?: boolean;
  class?: string;
}

/** 面板**首帧**估算尺寸（定位翻转用；列表内部超高走 vscroll 滚动，不随条数撑破视口）。
 *  挂载后 `reposition()` 会用实测尺寸复算，这两个数只影响第一帧的兜底位置。 */
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

  /**
   * 按面板**实测尺寸**定位（v2.5.8 D21b 修「下拉飘浮」）。
   *
   * `PANEL_W`/`PANEL_H` 只是首帧估算，而 `matchTriggerWidth={false}`（全站 48 处的主流配法）
   * 下面板是收缩包裹的：设置页「提前提醒天数」实测 77×104，按 256×300 判越界会**同时**误触发
   * 左移与上翻 ⇒ 面板落在控件左上方约 130px/300px 的空处，看着就是"飘"在那里。复算之后，
   * 小面板只在真放不下时才翻，常态与触发器左对齐、紧贴其下方。
   */
  const reposition = () => {
    const rect = triggerEl?.getBoundingClientRect();
    if (!rect || !panelEl) return;
    const next = panelPosition(rect, panelEl.offsetWidth, panelEl.offsetHeight, {
      w: window.innerWidth,
      h: window.innerHeight,
    });
    setPos((p) => (p.left === next.left && p.top === next.top ? p : next));
  };

  const openPanel = () => {
    setTerm("");
    const idx = props.options.findIndex((o) => o.value === props.value);
    // 当前值落在占位项（disabled）时不高亮它——否则 Enter 会"看起来能选其实不提交"
    setHighlight(idx >= 0 && !props.options[idx].disabled ? idx : -1);
    const rect = triggerEl?.getBoundingClientRect();
    if (rect) {
      setPos(panelPosition(rect, PANEL_W, PANEL_H, { w: window.innerWidth, h: window.innerHeight }));
    }
    setOpen(true);
    // Solid 的 `setOpen(true)` 同步插入 Portal 子树，此刻面板已在 DOM 里，
    // 立即复算 ⇒ 首帧就是真实尺寸下的位置，不存在"先飘一下再回来"。
    reposition();
    // 有搜索框时聚焦，输入即过滤（不必先按一次键）
    queueMicrotask(() => searchEl?.focus());
  };

  // 过滤词变化会改变面板高度（列表变短 / 空态），开着时随之复算，否则翻转态下会与触发器脱开
  createEffect(() => {
    if (!open()) return;
    filtered();
    reposition();
  });

  const close = () => {
    if (!open()) return;
    setOpen(false);
    props.onClose?.(); // 收起内联编辑器的口径统一走这里（替代原生 select 的 onBlur）
  };

  const pick = (opt: SearchSelectOption) => {
    if (opt.disabled || props.disabled) return; // 占位项只展示不提交（同原生 option disabled）；整只禁用时任何提交口一并关死
    if (opt.value !== props.value) props.onChange(opt.value); // 同值不提交：原生 <select> 选回当前项不触发 change（Images:367 / Notes:455 的联动重置因此不再重复跑）
    close(); // 同值也照样收起面板（与原生一致），收起语义仍走 onClose
  };

  /** 面板内按键：↑↓ 推进高亮（跳过占位项）、Enter 选中高亮、其余交全局（Esc 由层栈/兜底监听处理） */
  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = moveHighlightSkipped(filtered(), highlight(), e.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) setHighlight(next);
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
      if (e.key === "ArrowUp") {
        const idx = moveHighlightSkipped(props.options, -1, -1);
        if (idx >= 0) setHighlight(idx);
      }
    }
  };

  // 过滤词变化 → 高亮回到**首个可选项**（旧高亮序号在新列表里没有意义）
  createEffect(() => {
    term();
    setHighlight(moveHighlightSkipped(filtered(), -1, 1));
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
        ref={(el) => {
          triggerEl = el;
          // v2.5.8 D9：内联编辑场景（设置页标签域）要求挂载即聚焦，等价原生 `autofocus`；
          // 用微任务而非直接 focus——ref 执行时该节点尚未插入文档，直接 focus 会被浏览器忽略。
          if (el && props.autoFocus) queueMicrotask(() => el.focus());
        }}
        type="button"
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open()}
        /* 非紧凑态（表单态）恒 h-9 与 `.input`/`.select` 等高——同排字段一高一矮是"没对齐"的观感来源；
           紧凑态（筛选行）保持原 py-2 口径不动；禁用态与 .input 同一档（半透 + 不允许光标） */
        class={`flex items-center gap-2 border border-surface-200 rounded-lg bg-white text-sm hover:border-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
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
                      aria-disabled={opt.disabled || undefined}
                      data-option={opt.value}
                      class={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-lg text-left transition-colors ${
                        opt.disabled
                          ? "text-surface-400 cursor-default"
                          : highlight() === i()
                            ? "bg-primary-500/10 text-surface-900"
                            : "text-surface-700 hover:bg-surface-100"
                      }`}
                      onMouseEnter={() => {
                        if (!opt.disabled) setHighlight(i());
                      }}
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
