import type { JSX } from "solid-js";

/**
 * 按钮底座（v2.5.1 T2）：class 走组件类（btn-primary/btn-secondary/btn-danger/btn-ghost/btn-ghost-danger）；
 * disabled 统一降透明度 + 禁点。Solid 纪律（D11）：禁解构 props。
 */

const VARIANT_MAP: Record<string, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  danger: "btn-danger",
  ghost: "btn-ghost",
  "ghost-danger": "btn-ghost-danger",
};

const SIZE_MAP: Record<string, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "",
};

interface ButtonProps {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "ghost-danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  children: JSX.Element;
}

export default function Button(props: ButtonProps) {
  return (
    <button
      type={props.type ?? "button"}
      class={`${VARIANT_MAP[props.variant ?? "primary"]} ${SIZE_MAP[props.size ?? "md"]} disabled:opacity-50 disabled:cursor-not-allowed ${props.class ?? ""}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
