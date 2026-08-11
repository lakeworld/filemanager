import { Show, For, onMount, onCleanup, createSignal } from "solid-js";

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
 * v2.4.7：菜单渲染后按实测尺寸对视口边缘钳制，贴近窗口右/下边缘时内移。
 */
export default function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const close = () => props.onClose();

  // v2.4.7：初始在右键位置渲染，挂载后实测宽高再钳制（避免超出窗口右侧/底部被裁掉）
  const [pos, setPos] = createSignal({ left: props.x, top: props.y });
  let rootEl: HTMLDivElement | undefined;

  onMount(() => {
    // 视口边缘钳制：菜单实测尺寸 + 8px 边距，超出右侧/底部则内移（极小窗口下至少留左边距）
    if (rootEl) {
      const { width, height } = rootEl.getBoundingClientRect();
      const MARGIN = 8;
      setPos({
        left: Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN)),
        top: Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN)),
      });
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
    <Show when={props.items.some((i) => i.show !== false)}>
      <div
        id="ctx-menu-root"
        ref={rootEl}
        class="fixed z-50 bg-white shadow-lg rounded-lg border border-surface-200 py-1 min-w-[180px]"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <For each={props.items}>
          {(item) => (
            <Show when={item.show !== false}>
              <button
                class={`w-full px-4 py-2 text-left text-sm hover:bg-surface-100 transition-colors ${
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
  );
}
