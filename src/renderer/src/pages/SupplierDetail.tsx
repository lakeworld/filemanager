import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { tagList, loadTagDefs } from "~/stores/tags";
import { currentWorkspace } from "~/stores/workspace";
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { showToast } from "~/stores/notifyBanner";
import TagChip from "~/components/TagChip";
import TagInput from "~/components/TagInput";
import EmptyState from "~/components/EmptyState";
import ConfirmDialog from "~/components/ConfirmDialog";
// v2.4.9 S2：供应商详情文件区——FileBrowserView scope="supplier"（固定子文件夹集，core create 已建齐）
import FileBrowserView from "~/components/FileBrowserView";
import type { SupplierInfo, SupplierUpdateRequest } from "~/types";

/** 供应商固定子文件夹集首项（core SUPPLIER_SUBFOLDERS 镜像；决策 1：固定集不做 config 键） */
const SUPPLIER_FIRST_SUBFOLDER = "合同";

/** 档案字段展示行（值为空时显示灰占位符，同客户详情） */
function InfoRow(props: { label: string; value?: string }) {
  return (
    <div>
      <span class="text-xs text-surface-400 block">{props.label}</span>
      <span class={`text-sm ${props.value ? "text-surface-700" : "text-surface-300"}`}>
        {props.value || "—"}
      </span>
    </div>
  );
}

/**
 * 供应商详情页（v2.4.9 S2，PLAN §3.1）：档案卡（contact/phone/email/address/notes/tags + created/updated）
 * + 编辑弹窗 + 文件区（FileBrowserView scope="supplier"，子文件夹 合同/对账单/往来文件）。
 * 返回列表 / 删除（同列表页 ConfirmDialog「移入回收站」）。
 */
export default function SupplierDetail() {
  const navigate = useNavigate();
  const params = useParams();

  const [editingInfo, setEditingInfo] = createSignal<SupplierInfo | null>(null);
  const [editContact, setEditContact] = createSignal("");
  const [editPhone, setEditPhone] = createSignal("");
  const [editEmail, setEditEmail] = createSignal("");
  const [editAddress, setEditAddress] = createSignal("");
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");

  const [confirmDelete, setConfirmDelete] = createSignal<{ name: string } | null>(null);

  const supplierName = () => {
    const name = params.name || "";
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };

  const detailSupplier = () => suppliers().find((s) => s.name === supplierName());

  // v2.3.0：已定义标签名集合（孤儿标签警告）
  const definedTagNames = () => new Set(tagList().flatMap((t) => [t.name, ...(t.children ?? [])]));

  createEffect(() => {
    if (currentWorkspace()) {
      loadSuppliers();
      loadTagDefs();
    }
  });

  // —— 档案编辑 ——

  const openEditInfo = (s: SupplierInfo) => {
    setEditingInfo(s);
    setEditContact(s.contact || "");
    setEditPhone(s.phone || "");
    setEditEmail(s.email || "");
    setEditAddress(s.address || "");
    setEditTags(s.tags ?? []);
    setEditNotes(s.notes || "");
  };

  const handleSaveInfo = async () => {
    const s = editingInfo();
    if (!s) return;
    const req: SupplierUpdateRequest = {
      name: s.name,
      contact: editContact().trim() || undefined,
      phone: editPhone().trim() || undefined,
      email: editEmail().trim() || undefined,
      address: editAddress().trim() || undefined,
      tags: editTags(),
      notes: editNotes().trim() || undefined,
    };
    const result = await api.suppliers.update(req);
    if (result.success) {
      setEditingInfo(null);
      loadSuppliers();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  // —— 删除（进回收站，kind='supplier'；成功后跳回列表）——

  const handleDelete = () => {
    const name = supplierName();
    if (!name) return;
    setConfirmDelete({ name });
  };

  const doDelete = async (name: string) => {
    const result = await api.suppliers.delete(name);
    if (result.success) {
      navigate("/suppliers");
      loadSuppliers();
    } else {
      showToast("error", "删除供应商失败", result.error || "未知错误");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center gap-2 mb-2 text-sm text-surface-500 shrink-0">
        <button class="hover:text-primary-600" onClick={() => navigate("/suppliers")}>供应商</button>
        <span>/</span>
        <span class="text-surface-900 font-medium">{supplierName()}</span>
      </div>

      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">{supplierName()}</h1>
          <p class="text-surface-500 mt-1">供应商档案与文件管理</p>
        </div>
        <button
          class="btn-secondary text-red-600 hover:bg-red-50 hover:border-red-200"
          onClick={handleDelete}
        >
          🗑️ 删除供应商
        </button>
      </div>

      <Show when={detailSupplier()} fallback={
        <EmptyState icon="🏭" title="供应商不存在" desc="该供应商可能已被删除，或工作区已切换">
          <button class="btn-primary" onClick={() => navigate("/suppliers")}>返回供应商列表</button>
        </EmptyState>
      }>
        {/* 档案卡 */}
        <div class="card p-6 mb-6 shrink-0">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-semibold text-surface-900">供应商档案</h3>
            <button class="btn-secondary text-sm" onClick={() => openEditInfo(detailSupplier()!)}>
              ✏️ 编辑档案
            </button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            <InfoRow label="联系人" value={detailSupplier()!.contact} />
            <InfoRow label="电话" value={detailSupplier()!.phone} />
            <InfoRow label="邮箱" value={detailSupplier()!.email} />
            <InfoRow label="地址" value={detailSupplier()!.address} />
          </div>
          <Show when={(detailSupplier()!.tags || []).length > 0}>
            <div class="flex flex-wrap gap-1.5 mt-4">
              <For each={detailSupplier()!.tags || []}>
                {(tag) => (
                  <TagChip
                    name={tag}
                    warn={!definedTagNames().has(tag)}
                    title={definedTagNames().has(tag) ? undefined : "未在设置中定义，可在设置中转为正式标签"}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={detailSupplier()!.notes}>
            <p class="text-sm text-surface-600 mt-4 whitespace-pre-wrap">{detailSupplier()!.notes}</p>
          </Show>
          {/* erp_ext 只读区（v2.7 仓迹同步预留；无内容时不渲染） */}
          <Show when={detailSupplier()!.erp_ext && Object.keys(detailSupplier()!.erp_ext!).length > 0}>
            <div class="mt-4 pt-4 border-t border-surface-100">
              <p class="text-xs font-medium text-surface-400 mb-2">ERP 扩展信息（只读，由仓迹写回）</p>
              <div class="flex flex-wrap gap-2">
                <For each={Object.entries(detailSupplier()!.erp_ext!)}>
                  {([k, v]) => (
                    <span class="text-xs px-2 py-1 rounded-lg bg-surface-100 text-surface-600">
                      <span class="font-medium text-surface-500">{k}</span>: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </span>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <p class="text-xs text-surface-400 mt-4">
            创建于 {detailSupplier()!.created_at} · 更新于 {detailSupplier()!.updated_at}
          </p>
        </div>

        {/* 文件区：FileBrowserView scope="supplier"（子文件夹 合同/对账单/往来文件，core create 已建齐）；
            保底高度同客户（min-h-[420px]），内容超高时由外层 main 滚动 */}
        <div class="flex-1 min-h-[420px]">
          <FileBrowserView scope="supplier" entity={supplierName()} subFolder={SUPPLIER_FIRST_SUBFOLDER} />
        </div>
      </Show>

      {/* 编辑档案弹窗 */}
      <Show when={editingInfo()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden" onClick={() => setEditingInfo(null)}>
          <div class="bg-white rounded-2xl w-full max-w-xl p-6 shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">编辑供应商档案</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">联系人</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editContact()}
                  onInput={(e) => setEditContact(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">电话</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：13800138000"
                  value={editPhone()}
                  onInput={(e) => setEditPhone(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">邮箱</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：supplier@example.com"
                  value={editEmail()}
                  onInput={(e) => setEditEmail(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">地址</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：浙江省义乌市…"
                  value={editAddress()}
                  onInput={(e) => setEditAddress(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={editTags()}
                onChange={setEditTags}
                options={tagList()}
                placeholder="如：重点供应商、外贸"
              />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
              <textarea
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                rows={3}
                placeholder="添加备注..."
                value={editNotes()}
                onInput={(e) => setEditNotes(e.currentTarget.value)}
              />
            </div>
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setEditingInfo(null)}>取消</button>
              <button class="btn-primary" onClick={() => void handleSaveInfo()}>保存</button>
            </div>
          </div>
        </div>
      </Show>

      {/* 删除供应商确认弹窗（照客户：「移入回收站」可在回收站恢复） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除供应商"
          message={`确定删除供应商 "${confirmDelete()!.name}" 吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const target = confirmDelete()!;
            setConfirmDelete(null);
            void doDelete(target.name);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
