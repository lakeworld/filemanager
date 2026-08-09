import { createSignal, onMount, onCleanup } from "solid-js";

/**
 * 右键菜单状态管理钩子（v2.3.x UI 统一批）：
 * 统一各页面手写的 contextMenu 状态（show/x/y/payload）+ window click 关闭监听。
 * 用法：const menu = useContextMenu<PayloadType>();
 * 右键时 menu.open(e, payload)，渲染时
 * <Show when={menu.show()}>
 *   <ContextMenu x={menu.x()} y={menu.y()} onClose={menu.close} items={...} />
 * </Show>
 */
export function useContextMenu<T>() {
  const [show, setShow] = createSignal(false);
  const [x, setX] = createSignal(0);
  const [y, setY] = createSignal(0);
  const [payload, setPayload] = createSignal<T | null>(null);

  /** 打开菜单（内部 preventDefault，阻止浏览器默认右键菜单） */
  const open = (e: MouseEvent, p: T) => {
    e.preventDefault();
    setShow(true);
    setX(e.clientX);
    setY(e.clientY);
    // 用函数形式写入：泛型 T 可能是函数类型时避免 setter 值/更新器重载歧义
    setPayload(() => p);
  };

  const close = () => setShow(false);

  // 关闭触发：任意 mousedown（左/右键）、任意位置右键（contextmenu）、滚动（capture，覆盖滚动容器）。
  // 菜单自身点击由 ContextMenu 内部 stopPropagation 阻止冒泡到此，不会误关。
  onMount(() => {
    const onAny = () => close();
    const onScroll = () => close();
    window.addEventListener("mousedown", onAny);
    window.addEventListener("contextmenu", onAny);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onAny);
      window.removeEventListener("contextmenu", onAny);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  return { show, x, y, payload, open, close };
}
