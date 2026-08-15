import { createSignal, Show, onMount } from "solid-js";
import Modal from "~/components/ui/Modal";
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import Select from "~/components/ui/Select";
import TagInput from "~/components/TagInput";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { tagList } from "~/stores/tags";
import type { CustomerCreateRequest } from "~/types";

/**
 * 新建客户弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 字段信号与提交逻辑从 Clients.tsx 纯搬迁（信号仅本弹窗使用）；成功回调 onCreated。
 * 逻辑零改动：字段集与 handleCreate 校验/提交原样。
 */
export default function CreateClientModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
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

  // 打开时清空表单（复用弹窗实例，防上次残留）
  onMount(() => {
    if (props.open) {
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
    }
  });

  return (
    <Show when={props.open}>
      <Modal open title="新建客户" size="xl" onClose={props.onClose}>
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
              <Input value={newPhone()} placeholder="如：13800000000" onInput={(e) => setNewPhone(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">邮箱</label>
              <Input value={newEmail()} placeholder="如：name@example.com" onInput={(e) => setNewEmail(e.currentTarget.value)} class="w-full" />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">地址</label>
              <Input value={newAddress()} placeholder="如：广东省深圳市" onInput={(e) => setNewAddress(e.currentTarget.value)} class="w-full" />
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
            <button class="btn-secondary" onClick={props.onClose}>取消</button>
            <button class="btn-primary" disabled={saving()} onClick={() => void handleCreate()}>
              {saving() ? "创建中..." : "创建"}
            </button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
