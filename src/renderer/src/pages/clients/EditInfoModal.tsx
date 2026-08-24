import { createSignal, createEffect, Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫二次确认
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import Select from "~/components/ui/Select";
import TagInput from "~/components/TagInput";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { tagList } from "~/stores/tags";
import type { CustomerInfo, CustomerUpdateRequest } from "~/types";

/**
 * 编辑客户档案弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 字段信号与保存逻辑从 Clients.tsx 纯搬迁（信号仅本弹窗使用）；open 时由父组件传入 customer 并初始化。
 * 逻辑零改动：openEditInfo 初始化 + handleSaveInfo 提交原样。
 */
export default function EditInfoModal(props: {
  customer: CustomerInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editAlias, setEditAlias] = createSignal("");
  const [editCountry, setEditCountry] = createSignal("");
  const [editContact, setEditContact] = createSignal("");
  const [editSource, setEditSource] = createSignal("");
  const [editType, setEditType] = createSignal<"" | "企业" | "个人">("");
  const [editPhone, setEditPhone] = createSignal("");
  const [editEmail, setEditEmail] = createSignal("");
  const [editAddress, setEditAddress] = createSignal("");
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  // v2.5.5（B1-B）：脏守卫——打开时表单初值快照 + 确认弹窗开关
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardOpen, setDiscardOpen] = createSignal(false);

  // customer 变化（打开/切换）时初始化字段（对齐原 openEditInfo 语义；createEffect 防渲染期 setSignal）
  createEffect(() => {
    const cust = props.customer;
    if (!cust) return;
    const seeded = {
      alias: cust.alias || "",
      country: cust.country || "",
      contact: cust.contact || "",
      source: cust.source || "",
      type: cust.type || "",
      phone: cust.phone || "",
      email: cust.email || "",
      address: cust.address || "",
      tags: cust.tags ?? [],
      notes: cust.notes || "",
    };
    setEditAlias(seeded.alias);
    setEditCountry(seeded.country);
    setEditContact(seeded.contact);
    setEditSource(seeded.source);
    setEditType(seeded.type as "" | "企业" | "个人");
    setEditPhone(seeded.phone);
    setEditEmail(seeded.email);
    setEditAddress(seeded.address);
    setEditTags(seeded.tags);
    setEditNotes(seeded.notes);
    setSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardOpen(false);
  });

  /** v2.5.5（B1-B）：脏判定 = 表单字段相对打开快照有改动 */
  const dirty = () => {
    const snap = snapshot();
    if (!snap) return false;
    return (
      editAlias() !== snap.alias ||
      editCountry() !== snap.country ||
      editContact() !== snap.contact ||
      editSource() !== snap.source ||
      editType() !== snap.type ||
      editPhone() !== snap.phone ||
      editEmail() !== snap.email ||
      editAddress() !== snap.address ||
      editNotes() !== snap.notes ||
      JSON.stringify(editTags()) !== JSON.stringify(snap.tags)
    );
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
    const cust = props.customer;
    if (!cust || saving()) return;
    setSaving(true);
    const req: CustomerUpdateRequest = {
      name: cust.name,
      alias: editAlias().trim() || undefined,
      country: editCountry().trim() || undefined,
      contact: editContact().trim() || undefined,
      source: editSource().trim() || undefined,
      type: editType() || undefined,
      phone: editPhone().trim() || undefined,
      email: editEmail().trim() || undefined,
      address: editAddress().trim() || undefined,
      tags: editTags(),
      notes: editNotes().trim() || undefined,
    };
    const result = await api.clients.update(req);
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
          title="编辑客户档案"
          size="xl"
          onClose={realClose}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={dirty()}
          onCloseRequest={requestClose}
        >
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">编辑客户档案</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">别名</label>
              <Input value={editAlias()} onInput={(e) => setEditAlias(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">国家</label>
              <Input value={editCountry()} onInput={(e) => setEditCountry(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">联系方式</label>
              <Input value={editContact()} onInput={(e) => setEditContact(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">客户来源</label>
              <Input value={editSource()} onInput={(e) => setEditSource(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">客户类型</label>
              <Select
                ariaLabel="客户类型"
                value={editType()}
                onChange={(e) => setEditType(e.currentTarget.value as "" | "企业" | "个人")}
                class="w-full"
              >
                <option value="">未分类</option>
                <option value="企业">企业</option>
                <option value="个人">个人</option>
              </Select>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">电话</label>
              <Input value={editPhone()} placeholder="如：13800138000" onInput={(e) => setEditPhone(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">邮箱</label>
              <Input value={editEmail()} placeholder="如：name@example.com" onInput={(e) => setEditEmail(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">地址</label>
              <Input value={editAddress()} placeholder="如：浙江省义乌市…" onInput={(e) => setEditAddress(e.currentTarget.value)} class="w-full" />
            </div>
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
            <TagInput value={editTags()} onChange={setEditTags} options={tagList()} placeholder="如：重点、外贸" />
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
