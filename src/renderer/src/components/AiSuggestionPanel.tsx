/**
 * AI 建议面板（v2.2.0）：展示 AI 批量命名 / 打标结果，可勾选后应用。
 * 纯展示组件：数据由调用方经 api.ai.call 获取，应用逻辑由调用方实现。
 */
import { Show, For, createSignal } from "solid-js";

export interface AiPanelItem {
  original: string;
  /** rename 模式：建议名 */
  suggested?: string;
  /** rename 模式：AI 说明 */
  note?: string;
  /** tag 模式：建议标签 */
  tags?: string[];
}

export default function AiSuggestionPanel(props: {
  title: string;
  mode: "rename" | "tag";
  items: AiPanelItem[];
  onApply: (selected: number[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = createSignal<Set<number>>(
    new Set(props.items.map((_, i) => i)),
  );
  const [busy, setBusy] = createSignal(false);

  const toggle = (i: number) => {
    const s = new Set(selected());
    if (s.has(i)) {
      s.delete(i);
    } else {
      s.add(i);
    }
    setSelected(s);
  };

  const selectAll = () => setSelected(new Set(props.items.map((_, i) => i)));
  const clearAll = () => setSelected(new Set<number>());
  const selectedCount = () => selected().size;

  const apply = () => {
    if (selectedCount() === 0) return;
    setBusy(true);
    props.onApply(props.items.map((_, i) => i).filter((i) => selected().has(i)));
  };

  return (
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => !busy() && props.onClose()}>
      <div
        class="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-surface-100 px-6 py-4">
          <div>
            <h2 class="text-lg font-bold text-surface-900">{props.title}</h2>
            <p class="text-xs text-surface-400 mt-0.5">
              已选 {selectedCount()}/{props.items.length} 项 · AI 建议仅供参考，请核对后应用
            </p>
          </div>
          <button
            class="text-surface-400 hover:text-surface-600 text-2xl leading-none"
            onClick={() => !busy() && props.onClose()}
          >
            ✕
          </button>
        </div>

        {/* List */}
        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-2">
          <For each={props.items}>
            {(item, index) => {
              const checked = () => selected().has(index());
              return (
                <label
                  class={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${
                    checked() ? "border-primary-300 bg-primary-50" : "border-surface-200 hover:bg-surface-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    class="mt-0.5 w-4 h-4 accent-primary-600 shrink-0"
                    checked={checked()}
                    onChange={() => toggle(index())}
                  />
                  <div class="min-w-0 flex-1">
                    <Show
                      when={props.mode === "rename"}
                      fallback={
                        /* tag 模式 */
                        <div>
                          <div class="text-sm font-medium text-surface-800 truncate">{item.original}</div>
                          <Show when={(item.tags?.length ?? 0) > 0} fallback={<span class="text-xs text-surface-400">暂无建议</span>}>
                            <div class="mt-1.5 flex flex-wrap gap-1.5">
                              <For each={item.tags}>
                                {(t) => (
                                  <span class="px-2 py-0.5 rounded-full bg-primary-100 text-xs text-primary-700">
                                    {t}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      }
                    >
                      {/* rename 模式 */}
                      <div>
                        <div class="text-sm text-surface-500 truncate line-through decoration-surface-300">
                          {item.original}
                        </div>
                        <Show
                          when={item.suggested && item.suggested !== item.original}
                          fallback={<span class="text-xs text-surface-400">AI 未给出新名字（保持不变）</span>}
                        >
                          <div class="mt-0.5 text-sm font-semibold text-primary-700 truncate">
                            {item.suggested}
                          </div>
                        </Show>
                        <Show when={item.note}>
                          <div class="mt-0.5 text-xs text-amber-600">⚠ {item.note}</div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </label>
              );
            }}
          </For>
        </div>

        {/* Footer */}
        <div class="flex items-center justify-between border-t border-surface-100 px-6 py-4">
          <div class="flex gap-3">
            <button class="text-sm text-surface-500 hover:text-primary-600" onClick={selectAll}>
              全选
            </button>
            <button class="text-sm text-surface-500 hover:text-primary-600" onClick={clearAll}>
              清空
            </button>
          </div>
          <div class="flex gap-3">
            <button class="btn-secondary" onClick={() => !busy() && props.onClose()} disabled={busy()}>
              取消
            </button>
            <button
              class="btn-primary px-5"
              onClick={apply}
              disabled={busy() || selectedCount() === 0}
            >
              {busy() ? "应用中..." : `应用 ${selectedCount()} 项`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
