import type { JSX } from "solid-js";

/**
 * 多行文本域底座（v2.5.1 T2）：走 input 组件类语义（textarea 用同类边框/焦点规范）。
 * Solid 纪律（D11）：禁解构 props。
 */

interface TextareaProps {
  value?: string;
  placeholder?: string;
  rows?: number;
  error?: boolean;
  disabled?: boolean;
  class?: string;
  onInput?: (e: InputEvent) => void;
}

export default function Textarea(props: TextareaProps) {
  return (
    <textarea
      rows={props.rows ?? 3}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      class={`input h-auto py-2 resize-none ${props.error ? "border-danger-400 focus:border-danger-500 focus:ring-danger-500/30" : ""} ${props.class ?? ""}`}
      onInput={props.onInput}
    />
  );
}
