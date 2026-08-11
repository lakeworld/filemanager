import { Show, For, onMount, onCleanup, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { clampMenuPos } from "~/utils/clampMenuPos";

export interface ContextMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  /** 条件显示：返回 false 时隐藏（如单文件操作） */
  show?: boolean;
  action: () => void;
}

/**
 * 统一右键菜单（v2.0.1 重构）：声明式菜单项，统一样式与关闭逻辑。
 * 页面只需提供 items 配置；点击外部 / Escape 关闭。
 *
 * v2.4.8 打磨轮：渲染后按实测尺寸对视口边缘钳制。
 * v2.4.8 根治（「菜单撑满整个界面」回归）：
 * - 按钮补 `block`（保留 w-full）：inline-block 按钮在父 max-content 计算中会排成一行，
 *   shrink-to-fit 宽度撑成「left 到视口右缘的全部空间」（实测 1208px）；block 按钮
 *   自然撑满父宽且不污染父 max-content 计算，菜单宽度回归内容固有值（≈180px）。
 * - Portal 渲染到 body：脱离页面容器（flex/grid/transform 祖先），fixed 定位恒相对视口。
 * - 钳制抽为纯函数 clampMenuPos（NaN 防御：非法输入回退原坐标/边距，绝不产出 NaN style）。
 * - CSS 物理兜底 max-w/max-h：无论测量如何，菜单尺寸不超过视口。
 */
export default function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const close = () => props.onClose();

  // 菜单实测尺寸经 ResizeObserver 响应式更新：首次渲染时 emoji/字体未加载完，
  // onMount 一次性测量会拿到半成品高度（实测 190 vs 稳定后 406）导致钳制基准错误；
  // RO 在尺寸稳定（字体加载/内容变化）后自动回调校正，pos 随 size 响应式重算。
  // pos 为 memo：响应式跟踪 props.x/y 与 size，杜绝 onMount 快照切断响应式的时序问题
  // （useContextMenu.open 先 setShow 后 setX/setY，挂载瞬间 props.x/y 仍是旧值）。
  const [size, setSize] = createSignal<{ w: number; h: number } | null>(null);
  let rootEl: HTMLDivElement | undefined;

  const pos = (): { left: number; top: number } => {
    const s = size();
    if (!s) return { left: props.x, top: props.y }; // 未测量：原坐标（响应式跟随 props）
    return clampMenuPos(props.x, props.y, s.w, s.h, window.innerWidth, window.innerHeight);
  };

  onMount(() => {
    if (rootEl) {
      const ro = new ResizeObserver(() => {
        if (!rootEl) return;
        const { width, height } = rootEl.getBoundingClientRect();
        if (width > 0 && height > 0) setSize({ w: width, h: height });
      });
      ro.observe(rootEl);
      onCleanup(() => ro.disconnect());
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => {
      // 点击菜单外部关闭（菜单自身点击冒泡由 stopPropagation 阻止）
      const el = document.getElementById("ctx-menu-root");
      if (el && !el.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    });
  });

  return (
    <Portal>
      <Show when={props.items.some((i) => i.show !== false)}>
        <div
          id="ctx-menu-root"
          ref={rootEl}
          class="fixed z-50 bg-white shadow-lg rounded-lg border border-surface-200 py-1 min-w-[180px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto"
          style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={props.items}>
            {(item) => (
              <Show when={item.show !== false}>
                <button
                  class={`block w-full px-4 py-2 text-left text-sm hover:bg-surface-100 transition-colors ${
                    item.danger ? "text-red-600 hover:bg-red-50" : "text-surface-700"
                  }`}
                  onClick={() => {
                    item.action();
                    close();
                  }}
                >
                  {item.icon && <span class="mr-2">{item.icon}</span>}
                  {item.label}
                </button>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </Portal>
  );
}
