import { Show, For, createSignal, onMount, onCleanup } from "solid-js";
import { tagChipStyle, tagColor, tagLabel } from "~/stores/tags";
import type { TagInfo } from "~/types";

/**
 * 标签输入组件（v2.3.x UI 统一批）：
 * 已选标签 chips（tagChipStyle 背景、可 ✕ 移除）+ 输入框；
 * 输入时下拉过滤候选（名称包含匹配、排除已选），点击候选或回车添加，
 * 自由输入（非候选名）回车同样添加；输入为空时下拉展示全部未选候选。
 * 受控：value/onChange；点击外部 / ESC 关闭下拉。
 */
export default function TagInput(props: {
  value: string[];
  onChange: (next: string[]) => void;
  options: TagInfo[];
  placeholder?: string;
}) {
  const [input, setInput] = createSignal("");
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;

  // 已定义标签名（含子标签）：孤儿标签（未定义）chip 高亮提醒
  const definedNames = () => new Set(props.options.flatMap((t) => [t.name, ...(t.children ?? [])]));

  // 下拉候选：名称包含匹配 + 排除已选；输入为空时展示全部未选
  const candidates = () => {
    const term = input().trim().toLowerCase();
    const selected = new Set(props.value);
    const result: TagInfo[] = [];
    for (const t of props.options) {
      if (selected.has(t.name)) continue;
      if (term && !t.name.toLowerCase().includes(term)) continue;
      result.push(t);
    }
    return result;
  };

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t || props.value.includes(t)) return;
    props.onChange([...props.value, t]);
    setInput("");
  };

  const removeTag = (index: number) => {
    props.onChange(props.value.filter((_, i) => i !== index));
  };

  const commit = () => {
    addTag(input());
  };

  // 点击外部 / ESC 关闭下拉
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    });
  });

  return (
    <div ref={rootEl} class="relative">
      <Show when={props.value.length > 0}>
        <div class="flex flex-wrap gap-1 mb-2">
          <For each={props.value}>
            {(tag, index) => (
              <span
                class={`inline-flex items-center gap-1 px-2 py-1 text-white rounded text-xs ${
                  definedNames().has(tag) ? "" : "ring-2 ring-amber-400"
                }`}
                style={tagChipStyle(tag)}
                title={definedNames().has(tag) ? undefined : "未在设置中定义，可在设置中转为正式标签"}
              >
                {tagLabel(tag)}
                <button class="hover:opacity-80" onClick={() => removeTag(index())}>
                  ✕
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <input
        type="text"
        class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        placeholder={props.placeholder ?? "输入标签按回车"}
        value={input()}
        onInput={(e) => {
          setInput(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <Show when={open() && candidates().length > 0}>
        <div class="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-surface-200 rounded-lg shadow-lg py-1">
          <For each={candidates()}>
            {(t) => (
              <button
                class="w-full px-3 py-1.5 text-left text-sm hover:bg-surface-100 flex items-center gap-2"
                onClick={() => addTag(t.name)}
              >
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style={{ "background-color": tagColor(t.name) }} />
                <span class="truncate">{tagLabel(t.name)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
