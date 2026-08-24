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
import type { CustomerCreateRequest } from "~/types";
import type { CustomerPrefill } from "~/stores/createPrefillNormalize";

/**
 * 新建客户弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 字段信号与提交逻辑从 Clients.tsx 纯搬迁（信号仅本弹窗使用）；成功回调 onCreated。
 * v2.5.4 预填（PLAN-v2.5.4 §3.4）：可选 initial（打开时 seed 全字段；不传 = 空表，照旧）+
 * 可选 onCancel（批量预填取消语义 P1-1：取消/X 走 onCancel；不传退回 onClose，行为零变化）。
 */
export default function CreateClientModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  initial?: CustomerPrefill | null;
  onCancel?: () => void;
}) {
  const [newName, setNewName] = createSignal("");
  const [newAlias, setNewAlias] = createSignal("");
  const [newCountry, setNewCountry] = createSignal("");
  const [newContact, setNewContact] = createSignal("");
  const [newSource, setNewSource] = createSignal("");
  const [newType, setNewType] = createSignal<"" | "企业" | "个人">("");
  const [newPhone, setNewPhone] = createSignal("");
  const [newEmail, setNewEmail] = createSignal("");
  const [newAddress, setNewAddress] = createSignal("");
  const [newTags, setNewTags] = createSignal<string[]>([]);
  const [newNotes, setNewNotes] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  // v2.5.5（B1-B）：脏守卫——打开时表单初值快照 + 确认弹窗开关（纯表单输入弹窗覆盖）
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardOpen, setDiscardOpen] = createSignal(false);

  const handleCreate = async () => {
    if (saving()) return;
    const name = newName().trim();
    if (!name) return;
    setSaving(true);
    const req: CustomerCreateRequest = {
      name,
      alias: newAlias().trim() || undefined,
      country: newCountry().trim() || undefined,
      contact: newContact().trim() || undefined,
      source: newSource().trim() || undefined,
      // M2：type 空=未分类 → 提交 undefined（assertCustomerType 白名单仅 企业/个人/undefined）
      type: newType() || undefined,
      phone: newPhone().trim() || undefined,
      email: newEmail().trim() || undefined,
      address: newAddress().trim() || undefined,
      tags: newTags(),
      notes: newNotes().trim() || undefined,
    };
    const result = await api.clients.create(req);
    setSaving(false);
    if (result.success) {
      setNewName("");
      setNewAlias("");
      setNewCountry("");
      setNewContact("");
      setNewSource("");
      setNewType("");
      setNewPhone("");
      setNewEmail("");
      setNewAddress("");
      setNewTags([]);
      setNewNotes("");
      props.onClose();
      showToast("success", "客户已创建");
      props.onCreated();
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  // 打开时 seed 表单（v2.5.4：有 initial 预填则填全字段，无则清空——落实「复用弹窗防残留」原意图；
  // 依赖 open 与 initial 引用两者：批量推进时 open 无净变化、靠 initial 引用变化触发重填）
  createEffect(() => {
    if (!props.open) return;
    const init = props.initial;
    const seeded = {
      name: init?.name ?? "",
      alias: init?.alias ?? "",
      country: init?.country ?? "",
      contact: init?.contact ?? "",
      source: init?.source ?? "",
      type: (init?.type as "" | "企业" | "个人") || "",
      phone: init?.phone ?? "",
      email: init?.email ?? "",
      address: init?.address ?? "",
      tags: init?.tags ?? [],
      notes: init?.notes ?? "",
    };
    setNewName(seeded.name);
    setNewAlias(seeded.alias);
    setNewCountry(seeded.country);
    setNewContact(seeded.contact);
    setNewSource(seeded.source);
    setNewType(seeded.type as "" | "企业" | "个人");
    setNewPhone(seeded.phone);
    setNewEmail(seeded.email);
    setNewAddress(seeded.address);
    setNewTags(seeded.tags);
    setNewNotes(seeded.notes);
    setSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardOpen(false);
  });

  /** v2.5.5（B1-B）：脏判定 = 表单字段相对打开快照有改动 */
  const dirty = () => {
    const snap = snapshot();
    if (!snap) return false;
    return (
      newName() !== snap.name ||
      newAlias() !== snap.alias ||
      newCountry() !== snap.country ||
      newContact() !== snap.contact ||
      newSource() !== snap.source ||
      newType() !== snap.type ||
      newPhone() !== snap.phone ||
      newEmail() !== snap.email ||
      newAddress() !== snap.address ||
      newNotes() !== snap.notes ||
      JSON.stringify(newTags()) !== JSON.stringify(snap.tags)
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

  return (
    <Show when={props.open}>
      <>
        <Modal
          open
          title="新建客户"
          size="xl"
          onClose={realClose}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={dirty()}
          onCloseRequest={requestClose}
        >
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">新建客户</h2>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">客户名称</label>
            <Input value={newName()} placeholder="如：张三" onInput={(e) => setNewName(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">别名</label>
              <Input value={newAlias()} placeholder="如：三哥" onInput={(e) => setNewAlias(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">国家</label>
              <Input value={newCountry()} placeholder="如：中国" onInput={(e) => setNewCountry(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">联系方式</label>
              <Input value={newContact()} placeholder="如：展会、老客户" onInput={(e) => setNewContact(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">客户来源</label>
              <Input value={newSource()} placeholder="如：展会、老客户" onInput={(e) => setNewSource(e.currentTarget.value)} class="w-full" />
            </div>
            {/* v2.4.9 打磨 M2：新建弹窗补 type/电话/邮箱/地址（对齐编辑弹窗；type 默认空=未分类） */}
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">客户类型</label>
              <Select
                ariaLabel="客户类型"
                value={newType()}
                onChange={(e) => setNewType(e.currentTarget.value as "" | "企业" | "个人")}
                class="w-full"
              >
                <option value="">未分类</option>
                <option value="企业">企业</option>
                <option value="个人">个人</option>
              </Select>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">电话</label>
              <Input value={newPhone()} placeholder="如：13800138000" onInput={(e) => setNewPhone(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">邮箱</label>
              <Input value={newEmail()} placeholder="如：name@example.com" onInput={(e) => setNewEmail(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">地址</label>
              <Input value={newAddress()} placeholder="如：浙江省义乌市…" onInput={(e) => setNewAddress(e.currentTarget.value)} class="w-full" />
            </div>
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签</label>
            <TagInput value={newTags()} onChange={setNewTags} options={tagList()} placeholder="输入标签按回车" />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <Textarea value={newNotes()} rows={2} placeholder="添加备注..." onInput={(e) => setNewNotes(e.currentTarget.value)} class="w-full" />
          </div>
          <div class="flex gap-3 justify-end">
            {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestClose（二次确认） */}
            <button class="btn-secondary" onClick={requestClose}>取消</button>
            <button class="btn-primary" disabled={saving()} onClick={() => void handleCreate()}>
              {saving() ? "创建中..." : "确认创建"}
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
