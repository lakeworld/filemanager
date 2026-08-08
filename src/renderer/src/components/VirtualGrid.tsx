import { For, createSignal, onMount, onCleanup, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";

/**
 * 虚拟滚动网格（v2.1.0 性能优化）
 * 基于 @tanstack/solid-virtual：只渲染可见行 ± overscan，滚出即卸载，
 * 万图目录下 DOM 常驻节点稳定在几十个（对照 CullSnap/Telegram-Drive 同类实践）。
 *
 * 约定：固定行高（卡片高度固定，不做动态测量），组件自带滚动容器（h-full），
 * 调用方把列表区域包在 flex-1 min-h-0 的容器里即可。
 */
export interface VirtualGridBreakpoints {
  base: number;
  md?: number; // ≥768px
  lg?: number; // ≥1024px
  xl?: number; // ≥1280px
}

interface VirtualGridProps<T> {
  items: T[];
  /** 每行高度 px（含行间距） */
  itemHeight: number;
  columns: number | VirtualGridBreakpoints;
  /** 网格间距 px（列/行） */
  gap?: number;
  /** 行内单卡片渲染 */
  renderItem: (item: T, index: number) => JSX.Element;
  /** 滚动容器额外类 */
  class?: string;
}

const BREAKPOINTS = [
  { name: "xl", mq: "(min-width: 1280px)" },
  { name: "lg", mq: "(min-width: 1024px)" },
  { name: "md", mq: "(min-width: 768px)" },
] as const;

type BreakpointName = (typeof BREAKPOINTS)[number]["name"];

export default function VirtualGrid<T>(props: VirtualGridProps<T>) {
  let containerRef: HTMLDivElement | undefined;

  const resolveColumns = (): number => {
    if (typeof props.columns === "number") return props.columns;
    const cfg = props.columns;
    if (typeof window === "undefined") return cfg.base;
    for (const { name, mq } of BREAKPOINTS) {
      if (window.matchMedia(mq).matches) {
        const v = cfg[name as BreakpointName];
        if (v) return v;
      }
    }
    return cfg.base;
  };

  const [cols, setCols] = createSignal(resolveColumns());

  onMount(() => {
    const mqs = BREAKPOINTS.map(({ mq }) => window.matchMedia(mq));
    const update = () => setCols(resolveColumns());
    mqs.forEach((m) => m.addEventListener("change", update));
    onCleanup(() => mqs.forEach((m) => m.removeEventListener("change", update)));
  });

  const virtualizer = createVirtualizer({
    // Solid 版 createVirtualizer 内部为响应式上下文：count 直接传求值结果，
    // 内部访问 items/cols 会自动追踪变化（数据增减、窗口断点切换时自动重建）
    count: Math.ceil(props.items.length / cols()),
    getScrollElement: () => containerRef as HTMLDivElement,
    estimateSize: () => props.itemHeight,
    overscan: 3,
    getItemKey: (i) => i,
  });

  const gap = () => props.gap ?? 16;

  return (
    <div ref={containerRef} class={`vscroll overflow-y-auto h-full ${props.class ?? ""}`}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
        <For each={virtualizer.getVirtualItems()}>
          {(row) => {
            const rowStart = row.index * cols();
            const rowItems = props.items.slice(
              rowStart,
              Math.min(rowStart + cols(), props.items.length)
            );
            return (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                  height: `${row.size}px`,
                  display: "grid",
                  "grid-template-columns": `repeat(${cols()}, minmax(0, 1fr))`,
                  gap: `${gap()}px`,
                  "align-content": "start",
                }}
              >
                <For each={rowItems}>
                  {(item, i) => props.renderItem(item, rowStart + i())}
                </For>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
