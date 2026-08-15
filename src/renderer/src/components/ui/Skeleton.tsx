import { For } from "solid-js";

/**
 * 骨架屏底座（v2.5.1 T2）：skeleton 类块；仅加载态使用（T4 选型规则：列表/卡片栅格初始加载）。
 * Solid 纪律（D11）：禁解构 props。
 */

interface SkeletonProps {
  class?: string;
  lines?: number;
}

export default function Skeleton(props: SkeletonProps) {
  const lineClass = () => props.class ?? "h-4 w-full";
  return (
    <div class="flex flex-col gap-3">
      <For each={Array.from({ length: props.lines ?? 3 })}>
        {() => <div class={`skeleton ${lineClass()}`} />}
      </For>
    </div>
  );
}
