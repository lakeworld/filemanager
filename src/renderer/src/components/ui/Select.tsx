import type { JSX } from "solid-js";

/**
 * 下拉选择底座（v2.5.1 T2）：走 select 组件类；无 aria-label/aria-labelledby/label 关联时 dev 控制台警告（T4 清点）。
 * Solid 纪律（D11）：禁解构 props。
 */

interface SelectProps {
  value?: string;
  disabled?: boolean;
  class?: string;
  ariaLabel?: string;
  onChange?: (e: Event) => void;
  children: JSX.Element;
}

export default function Select(props: SelectProps) {
  if (import.meta.env.DEV && !props.ariaLabel) {
    console.warn("[ui/Select] 无 aria-label：请通过 ariaLabel 提供（T4 可访问性规范）");
  }
  return (
    <select
      value={props.value ?? ""}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      class={`select ${props.class ?? ""}`}
      onChange={props.onChange}
    >
      {props.children}
    </select>
  );
}
