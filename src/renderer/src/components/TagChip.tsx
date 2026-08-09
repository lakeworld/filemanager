import { Show } from "solid-js";
import { tagColor, tagLabel } from "~/stores/tags";

/** hex → rgba（非法值兜底 slate 灰） */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(148,163,184,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 与背景色同色系的文字色：深色提亮、浅色加深，保证浅底可读 */
function tagTextColor(hex: string): string {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return "#475569";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const mul = brightness > 0.55 ? 0.45 : 1.35;
  const cl = (v: number) => Math.round(Math.min(255, Math.max(40, v * mul)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

/**
 * 统一标签 chip：浅色半透明底 + 同色系文字 + 实色圆点 + 细边框。
 * - name：标签名（子标签自动显示 父/子）
 * - onRemove：提供则显示 ✕ 移除按钮
 * - warn：true 时边框用琥珀色提示（未定义/孤儿标签）
 * - title：悬停提示
 */
export default function TagChip(props: {
  name: string;
  onRemove?: () => void;
  warn?: boolean;
  title?: string;
}) {
  const color = () => tagColor(props.name);
  const border = () => (props.warn ? "rgba(245,158,11,0.6)" : hexToRgba(color(), 0.35));
  return (
    <span
      class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium select-none whitespace-nowrap"
      style={{
        "background-color": props.warn ? "rgba(245,158,11,0.12)" : hexToRgba(color(), 0.14),
        color: props.warn ? "#b45309" : tagTextColor(color()),
        border: `1px solid ${border()}`,
      }}
      title={props.title}
    >
      <span
        class="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ "background-color": props.warn ? "#f59e0b" : color() }}
      />
      <span class="truncate">{tagLabel(props.name)}</span>
      <Show when={props.onRemove}>
        <button
          class="ml-0.5 opacity-60 hover:opacity-100 text-current"
          onClick={props.onRemove}
          aria-label={`移除标签 ${props.name}`}
        >
          ✕
        </button>
      </Show>
    </span>
  );
}
