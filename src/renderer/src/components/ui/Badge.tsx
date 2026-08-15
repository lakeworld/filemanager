import type { JSX } from "solid-js";

/**
 * 徽章底座（v2.5.1 T2，D10 规格 px-2 py-0.5 text-xs font-medium）：
 * variant 六态 success/warning/danger/info/neutral/cert。
 * Solid 纪律（D11）：禁解构 props。
 */

const VARIANT_MAP: Record<string, string> = {
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  neutral: "badge-neutral",
  cert: "badge-cert",
};

interface BadgeProps {
  variant?: "success" | "warning" | "danger" | "info" | "neutral" | "cert";
  class?: string;
  children: JSX.Element;
}

export default function Badge(props: BadgeProps) {
  return <span class={`${VARIANT_MAP[props.variant ?? "neutral"]} ${props.class ?? ""}`}>{props.children}</span>;
}
