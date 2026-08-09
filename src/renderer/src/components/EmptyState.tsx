import { Show } from "solid-js";
import type { JSX } from "solid-js";

/**
 * 统一空态组件（v2.3.x UI 统一批）：居中布局、大图标、灰字标题与描述，
 * 可选 children（如「新建产品集」按钮等操作入口）。
 */
export default function EmptyState(props: {
  icon?: string;
  title: string;
  desc?: string;
  children?: JSX.Element;
}) {
  return (
    <div class="flex flex-col items-center justify-center text-center py-12">
      <Show when={props.icon}>
        <div class="text-4xl mb-3">{props.icon}</div>
      </Show>
      <h3 class="text-lg font-medium text-surface-700 mb-1">{props.title}</h3>
      <Show when={props.desc}>
        <p class="text-sm text-surface-400">{props.desc}</p>
      </Show>
      <Show when={props.children}>
        <div class="mt-4">{props.children}</div>
      </Show>
    </div>
  );
}
