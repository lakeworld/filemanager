import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
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
    // v2.5.3（P2-7）：请求在途时 lockOpen——Esc/遮罩均不触发 onClose（照 ArchiveProgressDialog 先例）
    // v2.5.8 D14（framed 收口）：加 framed 走统一骨架；手写 `<h2>` 与手搓白卡外壳材质作废
    // （面板本体 `.modal-panel` 已是实底白卡，`.dlg-header` 显示 title，`.dlg-body` 给 px-6 py-5）。
    // 本弹窗未写 size ⇒ 沿用底座默认 md（max-w-md），迁移前后正文实宽不变。
    <Modal
      open
      title={`打标（${props.paths.length} 个文件）`}
      framed
      lockOpen={busy()}
      onClose={props.onClose}
      // 「完成」进页脚槽（`.dlg-footer` 自带 justify-end + gap-3，外层 `flex gap-3 justify-end mt-6` 作废）；
      // class 逐字未动（`btn-primary` 已在统一档上，无被覆盖项可删）
      footer={
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
      }
    >
      {/* 外壳 div 与它的 onClick 一字未动（Modal 面板自己已 stop 冒泡，冗余但不属本轮可删项）；
          仍包一层 div，使 `.dlg-body` 的 `flex flex-col gap-4` 只作用在这一个子节点上，
          内层 `space-y-5` 的原有节奏保持不变（不趁迁移改版式）。 */}
      <div onClick={(e) => e.stopPropagation()}>
        <div class="space-y-5">
          {/* 添加区 */}
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1.5">添加标签</label>
            <TagInput
              value={pending()}
              onChange={handleAddChange}
              options={tagList()}
              placeholder="输入或选择标签，回车立即应用"
              scope="file" // v2.5.7（A3）：文件批量打标 = 文件域
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
      </div>
    </Modal>
  );
}
