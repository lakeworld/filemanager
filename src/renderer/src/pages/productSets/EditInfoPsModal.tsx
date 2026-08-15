import { createSignal, createEffect, Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import Textarea from "~/components/ui/Textarea";
import TagInput from "~/components/TagInput";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { tagList } from "~/stores/tags";
import type { ProductSetInfo } from "~/types";

/**
 * 编辑产品集信息弹窗（v2.5.1 T3 波2 拆分 + overlay→Modal 迁移）：
 * 字段信号与保存逻辑从 ProductSets.tsx 纯搬迁；customer=选中产品集（变化时初始化）。
 */
export default function EditInfoPsModal(props: {
  customer: ProductSetInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    const ps = props.customer;
    if (!ps) return;
    setEditTags(ps.tags ?? []);
    setEditNotes(ps.notes ?? "");
  });

  const handleSaveInfo = async () => {
    const ps = props.customer;
    if (!ps || saving()) return;
    setSaving(true);
    const result = await api.productSets.updateInfo({
      name: ps.name,
      tags: editTags(),
      notes: editNotes().trim(),
    });
    setSaving(false);
    if (result.success) {
      props.onClose();
      props.onSaved();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  return (
    <Show when={props.customer}>
      <Modal open title="编辑产品集信息" size="lg" onClose={props.onClose}>
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">编辑产品集信息</h2>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
            <TagInput value={editTags()} onChange={setEditTags} options={tagList()} placeholder="如：客户、重点" />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <Textarea value={editNotes()} rows={3} placeholder="添加备注..." onInput={(e) => setEditNotes(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="flex gap-3 justify-end">
            <button class="btn-secondary" onClick={props.onClose}>取消</button>
            <button class="btn-primary" disabled={saving()} onClick={() => void handleSaveInfo()}>
              {saving() ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
