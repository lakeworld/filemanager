import { Show, For } from "solid-js";
import { tagColor, tagLabel } from "~/stores/tags";

/** hex → rgba（非法值兜底 slate 灰） */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(148,163,184,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * 文件卡片标签展示（v2.4.4 T2/T3）：小尺寸 chips 组。
 * - tags：文件标签名列表；undefined / 空数组时不渲染任何内容
 * - max：完整显示上限（默认 2），超出部分收起为 +N 徽标
 * 视觉语言与 TagChip 一致：8% 透明度淡底 + 实色圆点 + 中性深灰文字（子标签显示 父/子）。
 */
export default function TagChips(props: { tags?: string[]; max?: number }) {
  const limit = () => Math.max(props.max ?? 2, 0);
  const visible = () => (props.tags ?? []).slice(0, limit());
  const hiddenCount = () => (props.tags?.length ?? 0) - visible().length;
  return (
    <Show when={props.tags && props.tags.length > 0}>
      <div class="flex flex-wrap items-center gap-1 mt-1.5">
        <For each={visible()}>
          {(name) => {
            const color = () => tagColor(name);
            const label = () => tagLabel(name);
            return (
              <span
                class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium select-none whitespace-nowrap"
                style={{
                  "background-color": hexToRgba(color(), 0.08),
                  color: "#334155",
                  border: `1px solid ${hexToRgba(color(), 0.22)}`,
                }}
                title={label()}
              >
                <span class="w-1 h-1 rounded-full shrink-0" style={{ "background-color": color() }} />
                <span class="truncate">{label()}</span>
              </span>
            );
          }}
        </For>
        <Show when={hiddenCount() > 0}>
          <span class="text-[10px] leading-none text-surface-400 font-medium select-none whitespace-nowrap">
            +{hiddenCount()}
          </span>
        </Show>
      </div>
    </Show>
  );
}
