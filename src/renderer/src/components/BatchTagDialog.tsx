import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { loadTagDefs, tagList } from "~/stores/tags";
import TagInput from "~/components/TagInput";
import TagChip from "~/components/TagChip";
import type { ApiResult, BatchTagResult } from "~/types";

/**
 * 批量打标弹窗（v2.4.4）。
 * props：paths（选中文件路径，空则直接关闭）、commonTags（选中文件当前共有的标签，
 * 由调用方从已加载 items 求交集传入）、onClose、onDone（完成后父级刷新列表 + 清空选中）。
 * 所有操作即时生效、无「保存」按钮：
 * - 添加区复用 TagInput（受控「待添加」数组）：选择/回车/新建标签 → onChange 立即
 *   api.metadata.batchTag({ paths, add: [tag] })，成功从输入区清除并计入「已应用」反馈；
 * - 移除区「共有标签」chips 带 ✕ → batchTag({ paths, remove: [tag] }) 后本地移除；
 * - 每次 batchTag 成功 toast「已更新 N 个文件」（有 failed 补「失败 M 个」）；
 * - 「完成」→ onDone() + onClose()。
 */
export default function BatchTagDialog(props: {
  paths: string[];
  commonTags: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  /** 待添加标签（TagInput 受控值；添加即应用后清空，正常始终为空或过渡态） */
  const [pending, setPending] = createSignal<string[]>([]);
  /** 本次会话已成功应用的标签（「已应用」反馈） */
  const [applied, setApplied] = createSignal<string[]>([]);
  /** 共有标签本地副本（移除后更新） */
  const [commonTags, setCommonTags] = createSignal<string[]>(props.commonTags);
  /** 有请求在途时禁用「完成」，避免列表刷新抢在打标落盘前（竞态） */
  const [busy, setBusy] = createSignal(false);

  // 空 paths 直接关闭（正常由菜单 show 保证，防御性兜底）
  createEffect(() => {
    if (props.paths.length === 0) props.onClose();
  });

  // 确保 TagInput 候选可用（如 Images 页未预加载标签定义）
  onMount(() => {
    void loadTagDefs();
  });

  // 收尾轮：Esc 关闭（请求在途时不允许，避免列表刷新抢在打标落盘前）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!busy()) {
        props.onDone();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const showTagToast = (r: ApiResult<BatchTagResult>) => {
    if (r.success) {
      const failed = r.data?.failed?.length ?? 0;
      showToast("success", `已更新 ${props.paths.length} 个文件`, failed > 0 ? `失败 ${failed} 个` : undefined);
    } else {
      showToast("error", "打标失败", r.error || "未知错误");
    }
  };

  const applyAdd = async (tag: string) => {
    setBusy(true);
    const r = await api.metadata.batchTag({ paths: props.paths, add: [tag] });
    setBusy(false);
    showTagToast(r);
    if (r.success) setApplied((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  };

  /** TagInput 受控 onChange：新增的 tag 立即 batchTag，随后从输入区清除 */
  const handleAddChange = (next: string[]) => {
    const prev = pending();
    const added = next.filter((t) => !prev.includes(t));
    setPending([]); // 立即清空输入区，避免残留「看似已应用」的 chips
    for (const t of added) void applyAdd(t);
  };

  const handleRemove = async (tag: string) => {
    setBusy(true);
    const r = await api.metadata.batchTag({ paths: props.paths, remove: [tag] });
    setBusy(false);
    showTagToast(r);
    if (r.success) setCommonTags((prev) => prev.filter((t) => t !== tag));
  };

  return (
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={props.onClose}>
      <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 class="text-xl font-bold mb-4">打标（{props.paths.length} 个文件）</h2>

        <div class="space-y-5">
          {/* 添加区 */}
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1.5">添加标签</label>
            <TagInput
              value={pending()}
              onChange={handleAddChange}
              options={tagList()}
              placeholder="输入或选择标签，回车立即应用"
            />
            <Show when={applied().length > 0}>
              <div class="mt-2">
                <span class="text-xs text-surface-400">已应用：</span>
                <div class="flex flex-wrap gap-1.5 mt-1">
                  <For each={applied()}>
                    {(tag) => <TagChip name={tag} />}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          {/* 移除区 */}
          <Show when={commonTags().length > 0}>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1.5">共有标签（点击 ✕ 移除）</label>
              <div class="flex flex-wrap gap-1.5">
                <For each={commonTags()}>
                  {(tag) => (
                    <TagChip name={tag} onRemove={() => void handleRemove(tag)} />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex gap-3 justify-end mt-6">
          <button
            class="btn-primary"
            disabled={busy()}
            onClick={() => {
              props.onDone();
              props.onClose();
            }}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
