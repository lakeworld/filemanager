import type { JSX } from "solid-js";

/**
 * 输入框底座（v2.5.1 T2）：走 input 组件类；error 加 danger 边框。
 * Solid 纪律（D11）：禁解构 props。
 */

interface InputProps {
  value?: string;
  placeholder?: string;
  type?: string;
  error?: boolean;
  disabled?: boolean;
  class?: string;
  onInput?: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
}

export default function Input(props: InputProps) {
  return (
    <input
      type={props.type ?? "text"}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      class={`input ${props.error ? "border-danger-400 focus:border-danger-500 focus:ring-danger-500/30" : ""} ${props.class ?? ""}`}
      onInput={props.onInput}
      onKeyDown={props.onKeyDown}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
    />
  );
}
