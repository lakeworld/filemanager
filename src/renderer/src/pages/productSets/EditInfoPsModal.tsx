import { createSignal, createEffect, Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫二次确认
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
  // v2.5.5（B1-B）：脏守卫——打开时表单初值快照 + 确认弹窗开关
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardOpen, setDiscardOpen] = createSignal(false);

  createEffect(() => {
    const ps = props.customer;
    if (!ps) return;
    const seeded = { tags: ps.tags ?? [], notes: ps.notes ?? "" };
    setEditTags(seeded.tags);
    setEditNotes(seeded.notes);
    setSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardOpen(false);
  });

  /** v2.5.5（B1-B）：脏判定 = 表单字段相对打开快照有改动 */
  const dirty = () => {
    const snap = snapshot();
    if (!snap) return false;
    return editNotes() !== snap.notes || JSON.stringify(editTags()) !== JSON.stringify(snap.tags);
  };

  /** 关闭请求：dirty → 弹「放弃未保存内容？」；否则直关（取消按钮与遮罩/Esc 同路） */
  const requestClose = () => {
    if (discardOpen()) return; // 确认弹窗打开期间防叠加触发
    if (dirty()) setDiscardOpen(true);
    else realClose();
  };

  /** 真实关闭（放弃修改确认后 / 非 dirty） */
  const realClose = () => {
    setDiscardOpen(false);
    props.onClose();
  };

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
      <>
        <Modal
          open
          title="编辑产品集信息"
          size="lg"
          onClose={realClose}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={dirty()}
          onCloseRequest={requestClose}
        >
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">编辑产品集信息</h2>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
            <TagInput value={editTags()} onChange={setEditTags} options={tagList()} placeholder="如：客户、重点" scope="product_set" />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <Textarea value={editNotes()} rows={3} placeholder="添加备注..." onInput={(e) => setEditNotes(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="flex gap-3 justify-end">
            {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestClose（二次确认） */}
            <button class="btn-secondary" onClick={requestClose}>取消</button>
            <button class="btn-primary" disabled={saving()} onClick={() => void handleSaveInfo()}>
              {saving() ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
        </Modal>
        {/* v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（独立 Modal 叠层） */}
        <Show when={discardOpen()}>
          <ConfirmDialog
            title="放弃未保存内容？"
            message="该弹窗有未保存的修改，放弃后将不会保存任何内容。"
            confirmLabel="放弃修改"
            cancelLabel="继续编辑"
            danger
            onConfirm={realClose}
            onCancel={() => setDiscardOpen(false)}
          />
        </Show>
      </>
    </Show>
  );
}
