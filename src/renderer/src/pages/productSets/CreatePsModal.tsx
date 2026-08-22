import { createSignal, createEffect, Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import TagInput from "~/components/TagInput";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { tagList } from "~/stores/tags";
import type { ProductSetCreateRequest } from "~/types";
import type { ProductSetPrefill } from "~/stores/createPrefillNormalize";

/**
 * 新建产品集弹窗（v2.5.1 T3 波2 拆分 + overlay→Modal 迁移）：
 * 字段信号与提交逻辑从 ProductSets.tsx 纯搬迁；成功回调 onCreated。
 * v2.5.4 预填（PLAN-v2.5.4 §3.4）：可选 initial + onCancel（语义同 CreateClientModal）。
 */
export default function CreatePsModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  initial?: ProductSetPrefill | null;
  onCancel?: () => void;
}) {
  const [newPsName, setNewPsName] = createSignal("");
  const [newPsTags, setNewPsTags] = createSignal<string[]>([]);
  const [newPsNotes, setNewPsNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // 打开时 seed（有 initial 预填，无则清空防残留；依赖 open 与 initial 引用，同客户弹窗）
  createEffect(() => {
    if (!props.open) return;
    const init = props.initial;
    setNewPsName(init?.name ?? "");
    setNewPsTags(init?.tags ?? []);
    setNewPsNotes(init?.notes ?? "");
  });

  const handleCreate = async () => {
    if (saving()) return;
    const name = newPsName().trim();
    if (!name) return;
    setSaving(true);
    const req: ProductSetCreateRequest = {
      name,
      tags: newPsTags(),
      notes: newPsNotes().trim(),
    };
    const result = await api.productSets.create(req);
    setSaving(false);
    if (result.success) {
      setNewPsName("");
      setNewPsTags([]);
      setNewPsNotes("");
      props.onClose();
      props.onCreated();
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  return (
    <Show when={props.open}>
      <Modal open title="新建产品集" size="lg" onClose={props.onCancel ?? props.onClose}>
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">新建产品集</h2>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">产品集名称</label>
            <Input value={newPsName()} placeholder="如：夏季T恤系列" onInput={(e) => setNewPsName(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
            <TagInput value={newPsTags()} onChange={setNewPsTags} options={tagList()} placeholder="如：客户、重点" />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <Textarea value={newPsNotes()} rows={3} placeholder="添加备注..." onInput={(e) => setNewPsNotes(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="flex gap-3 justify-end">
            <button class="btn-secondary" onClick={props.onCancel ?? props.onClose}>取消</button>
            <button class="btn-primary" disabled={saving()} onClick={() => void handleCreate()}>
              {saving() ? "创建中..." : "确认创建"}
            </button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
