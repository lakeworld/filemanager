import { Show } from "solid-js";
import type { JSX } from "solid-js";

/**
 * 统一空态组件（v2.3.x UI 统一批）：居中布局、大图标、灰字标题与描述，
 * 可选 children（如「新建产品集」按钮等操作入口）。
 *
 * v2.5.8 精致化 D6：新增 `boxed`（缺能力补 props，不绕开组件——调研 §五.2 红线）——
 * 在卡内「子空态」（如产品集详情的关联客户/供应商）套一圈**虚线描边**，与「这里还能放东西」的
 * 语义一致；页面级大空态（整屏无数据）仍用默认无框版式，避免 19 处用点一次性改味。
 */
export default function EmptyState(props: {
  icon?: string;
  title: string;
  desc?: string;
  /** 卡内子空态：虚线描边 + 柔底（默认 false = 页面级无框布局） */
  boxed?: boolean;
  children?: JSX.Element;
}) {
  return (
    <div
      class={`flex flex-col items-center justify-center text-center ${
        props.boxed ? "border border-dashed border-surface-300 rounded-xl bg-surface-50/70 px-6 py-10" : "py-12"
      }`}
    >
      <Show when={props.icon}>
        <div class="text-4xl mb-3">{props.icon}</div>
      </Show>
      <h3 class={`${props.boxed ? "text-base" : "text-lg"} font-medium text-surface-700 mb-1`}>{props.title}</h3>
      <Show when={props.desc}>
        <p class="text-sm text-surface-400">{props.desc}</p>
      </Show>
      <Show when={props.children}>
        <div class="mt-4">{props.children}</div>
      </Show>
    </div>
  );
}
