import { Show } from "solid-js";

/**
 * 统一加载态组件（v2.3.x UI 统一批）：居中 spinner + 可选文字。
 */
export default function Loading(props?: { text?: string }) {
  return (
    <div class="flex flex-col items-center justify-center gap-3 py-12">
      <div class="w-8 h-8 border-2 border-surface-200 border-t-primary-500 rounded-full animate-spin" />
      <Show when={props?.text}>
        <span class="text-sm text-surface-400">{props?.text}</span>
      </Show>
    </div>
  );
}
