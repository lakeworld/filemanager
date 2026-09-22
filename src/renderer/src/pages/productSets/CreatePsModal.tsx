import { createSignal, createEffect, Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫二次确认
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
 * v2.5.4 预填（内部设计文档 §3.4）：可选 initial + onCancel（语义同 CreateClientModal）。
 * v2.5.9 A6-3：`onCreated(name)` 带出新建的名字——调用方据此**直接进详情**（`/product-sets/<name>`）；
 * 不带名字时调用方只能停在列表页（旧行为），那是本次要修的用户体验缺口。
 */
export default function CreatePsModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
  initial?: ProductSetPrefill | null;
  onCancel?: () => void;
}) {
  const [newPsName, setNewPsName] = createSignal("");
  const [newPsTags, setNewPsTags] = createSignal<string[]>([]);
  const [newPsNotes, setNewPsNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  // v2.5.5（B1-B）：脏守卫——打开时表单初值快照 + 确认弹窗开关
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardOpen, setDiscardOpen] = createSignal(false);

  // 打开时 seed（有 initial 预填，无则清空防残留；依赖 open 与 initial 引用，同客户弹窗）
  createEffect(() => {
    if (!props.open) return;
    const init = props.initial;
    const seeded = { name: init?.name ?? "", tags: init?.tags ?? [], notes: init?.notes ?? "" };
    setNewPsName(seeded.name);
    setNewPsTags(seeded.tags);
    setNewPsNotes(seeded.notes);
    setSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardOpen(false);
  });

  /** v2.5.5（B1-B）：脏判定 = 表单字段相对打开快照有改动 */
  const dirty = () => {
    const snap = snapshot();
    if (!snap) return false;
    return (
      newPsName() !== snap.name ||
      newPsNotes() !== snap.notes ||
      JSON.stringify(newPsTags()) !== JSON.stringify(snap.tags)
    );
  };

  /** 关闭请求：dirty → 弹「放弃未保存内容？」；否则直关（取消按钮与遮罩/Esc 同路） */
  const requestClose = () => {
    if (discardOpen()) return; // 确认弹窗打开期间防叠加触发
    if (dirty()) setDiscardOpen(true);
    else realClose();
  };

  /** 真实关闭（放弃修改确认后 / 非 dirty）：清确认态 + 走 onCancel/onClose */
  const realClose = () => {
    setDiscardOpen(false);
    (props.onCancel ?? props.onClose)();
  };

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
      props.onCreated(name);
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  return (
    <Show when={props.open}>
      <>
        <Modal
          open
          title="新建产品集"
          subtitle="名称即产品集文件夹名，图包 / 证书 / 文档都挂在它下面"
          size="lg"
          framed
          onClose={realClose}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={dirty()}
          onCloseRequest={requestClose}
          footer={
            <>
              {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestClose（二次确认） */}
              <button class="btn-secondary" onClick={requestClose}>取消</button>
              <button class="btn-primary" disabled={saving()} onClick={() => void handleCreate()}>
                {saving() ? "创建中..." : "确认创建"}
              </button>
            </>
          }
        >
          <div class="dlg-field">
            <label class="dlg-label dlg-required" aria-required="true">产品集名称</label>
            <Input value={newPsName()} placeholder="如：夏季T恤系列" onInput={(e) => setNewPsName(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="dlg-field">
            <label class="dlg-label">标签<span class="dlg-hint">（建议从已定义标签中选择）</span></label>
            <TagInput value={newPsTags()} onChange={setNewPsTags} options={tagList()} placeholder="如：客户、重点" scope="product_set" />
          </div>
          <div class="dlg-field">
            <label class="dlg-label">备注</label>
            <Textarea value={newPsNotes()} rows={3} placeholder="添加备注..." onInput={(e) => setNewPsNotes(e.currentTarget.value)} class="w-full" />
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
