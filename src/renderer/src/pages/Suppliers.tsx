import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import Modal from "~/components/ui/Modal";
import { tagList, loadTagDefs } from "~/stores/tags";
import { currentWorkspace } from "~/stores/workspace";
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { showToast } from "~/stores/notifyBanner";
import TagChip from "~/components/TagChip";
import TagInput from "~/components/TagInput";
import EmptyState from "~/components/EmptyState";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import VirtualGrid from "~/components/VirtualGrid";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { SupplierInfo, SupplierCreateRequest } from "~/types";

// v2.4.9 S2（决策 14）：供应商列表渲染口径——<200 条用 For 全量、≥200 条走 VirtualGrid 虚拟滚动。
// 参照回收站先例（Trash.tsx TRASH_VIRTUAL_THRESHOLD）：阈值统一 200。
const SUPPLIER_VIRTUAL_THRESHOLD = 200;
// 卡片高 ≈ p-5 上下 40px + 图标 48 + 标题 ~40 + 联系人 ~24 + 标签行 ~36 + 备注 2 行 ~40 ≈ 228px，
// 行间距 16px 计入 itemHeight（估算取整防重叠，同回收站 TRASH_ROW_HEIGHT 做法）
const SUPPLIER_ROW_HEIGHT = 244;

/**
 * 供应商列表页（v2.4.9 S2，PLAN §3.1）：
 * 卡片网格（名称/联系人/标签/文件数）+ 新建弹窗（name/contact/phone/email/address/tags/notes）
 * + 删除（ConfirmDialog「移入回收站」）+ 重命名（弹窗；级联 inbound.supplier_id 在 core BoxService.renameSupplier）。
 * 详情页独立（SupplierDetail.tsx，/suppliers/:name），与客户同范式。
 */
export default function Suppliers() {
  const navigate = useNavigate();

  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newContact, setNewContact] = createSignal("");
  const [newPhone, setNewPhone] = createSignal("");
  const [newEmail, setNewEmail] = createSignal("");
  const [newAddress, setNewAddress] = createSignal("");
  const [newNotes, setNewNotes] = createSignal("");
  // v2.4.9 打磨 M1：新建弹窗标签（TagInput，同客户弹窗范式）
  const [newTags, setNewTags] = createSignal<string[]>([]);

  // 重命名弹窗状态（列表入口；改名后走 qihebox:suppliers:rename，级联在 core 已做）
  const [renameTarget, setRenameTarget] = createSignal<SupplierInfo | null>(null);
  const [renameValue, setRenameValue] = createSignal("");

  // 删除确认弹窗（照客户：ConfirmDialog + 「移入回收站」文案）
  const [confirmDelete, setConfirmDelete] = createSignal<{ name: string } | null>(null);

  const contextMenu = useContextMenu<SupplierInfo>();

  // v2.3.0：已定义标签名集合（孤儿标签警告，同客户/产品集）
  const definedTagNames = () => new Set(tagList().flatMap((t) => [t.name, ...(t.children ?? [])]));

  createEffect(() => {
    if (currentWorkspace()) {
      loadSuppliers();
      loadTagDefs();
    }
  });

  // —— 新建 ——

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;
    const req: SupplierCreateRequest = {
      name,
      contact: newContact().trim() || undefined,
      phone: newPhone().trim() || undefined,
      email: newEmail().trim() || undefined,
      address: newAddress().trim() || undefined,
      tags: newTags(),
      notes: newNotes().trim() || undefined,
    };
    const result = await api.suppliers.create(req);
    if (result.success) {
      setShowCreateModal(false);
      setNewName("");
      setNewContact("");
      setNewPhone("");
      setNewEmail("");
      setNewAddress("");
      setNewNotes("");
      setNewTags([]);
      loadSuppliers();
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  // —— 重命名 ——

  const openRename = (s: SupplierInfo) => {
    setRenameTarget(s);
    setRenameValue(s.name);
  };

  const handleRename = async () => {
    const target = renameTarget();
    if (!target) return;
    const newName = renameValue().trim();
    if (!newName || newName === target.name) {
      setRenameTarget(null);
      return;
    }
    const result = await api.suppliers.rename(target.name, newName);
    if (result.success) {
      setRenameTarget(null);
      loadSuppliers();
      showToast("success", "重命名成功", `供应商已重命名为「${newName}」，关联入库单已同步`);
    } else {
      showToast("error", "重命名失败", result.error || "未知错误");
      setRenameValue(target.name);
    }
  };

  // —— 删除（进回收站，kind='supplier'；suppliers.json 条目保留，恢复即复原）——

  const handleCardDelete = (s: SupplierInfo, e?: MouseEvent) => {
    e?.stopPropagation();
    contextMenu.close();
    setConfirmDelete({ name: s.name });
  };

  const doDelete = async (name: string) => {
    const result = await api.suppliers.delete(name);
    if (result.success) {
      loadSuppliers();
    } else {
      showToast("error", "删除供应商失败", result.error || "未知错误");
    }
  };

  // —— 卡片渲染（For 与 VirtualGrid 共用，避免两份 JSX 漂移；参照 Trash renderEntry 先例）——

  const renderCard = (s: SupplierInfo) => (
    <div
      class="card p-5 cursor-pointer hover:shadow-card-hover group relative"
      onClick={() => navigate(`/suppliers/${encodeURIComponent(s.name)}`)}
      onContextMenu={(e) => contextMenu.open(e, s)}
    >
      <div class="flex items-start justify-between">
        <div class="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center text-2xl">
          🏭
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-1 rounded-full bg-surface-100 text-surface-500">
            {s.file_count} 文件
          </span>
          <button
            class="text-surface-400 hover:text-danger-500 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => handleCardDelete(s, e)}
            title="删除供应商"
          >
            🗑️
          </button>
        </div>
      </div>
      <h3 class="text-lg font-semibold mt-3 text-surface-900">{s.name}</h3>
      <Show when={s.contact}>
        <p class="text-sm text-surface-400 mt-1">{s.contact}</p>
      </Show>
      <Show when={s.tags && s.tags.length > 0}>
        <div class="flex flex-wrap gap-1.5 mt-3">
          <For each={s.tags}>
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
      <Show when={s.notes}>
        <p class="text-xs text-surface-400 mt-2 line-clamp-2">{s.notes}</p>
      </Show>
    </div>
  );

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">供应商</h1>
          <p class="text-surface-500 mt-1">管理供应商档案与往来文件（合同/对账单/往来文件）</p>
        </div>
        <button class="btn-primary" onClick={() => setShowCreateModal(true)}>
          <span>➕</span> 新建供应商
        </button>
      </div>

      <Show when={suppliers().length > 0} fallback={
        <EmptyState icon="🏭" title="暂无供应商" desc="创建您第一个供应商来开始管理">
          <button class="btn-primary" onClick={() => setShowCreateModal(true)}>新建供应商</button>
        </EmptyState>
      }>
        <Show
          when={suppliers().length >= SUPPLIER_VIRTUAL_THRESHOLD}
          fallback={
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <For each={suppliers()}>
                {(s) => renderCard(s)}
              </For>
            </div>
          }
        >
          {/* v2.4.9 S2（决策 14）：≥200 条走虚拟滚动——只渲染可见行，供应商数无上限 */}
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={suppliers()}
              itemHeight={SUPPLIER_ROW_HEIGHT}
              columns={{ base: 1, md: 2, lg: 3 }}
              gap={16}
              renderItem={(s) => renderCard(s)}
            />
          </div>
        </Show>
      </Show>

      {/* 新建供应商弹窗（字段：名称/联系人/电话/邮箱/地址/标签/备注） */}
      <Show when={showCreateModal()}>
        <Modal open title="新建供应商" size="xl" onClose={() => setShowCreateModal(false)}>
          <div class="bg-white rounded-2xl w-full max-w-xl p-6 shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">新建供应商</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">供应商名称</label>
              <input
                type="text"
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="如：义乌恒通供应链"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
              />
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">联系人</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：王经理"
                  value={newContact()}
                  onInput={(e) => setNewContact(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">电话</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：13800138000"
                  value={newPhone()}
                  onInput={(e) => setNewPhone(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">邮箱</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：supplier@example.com"
                  value={newEmail()}
                  onInput={(e) => setNewEmail(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">地址</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：浙江省义乌市…"
                  value={newAddress()}
                  onInput={(e) => setNewAddress(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={newTags()}
                onChange={setNewTags}
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
                value={newNotes()}
                onInput={(e) => setNewNotes(e.currentTarget.value)}
              />
            </div>
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setShowCreateModal(false)}>取消</button>
              <button class="btn-primary" onClick={handleCreate}>确认创建</button>
            </div>
          </div>
        </Modal>
      </Show>

      {/* 重命名弹窗（入口：卡片右键菜单；改名后 inbound 级联在 core BoxService.renameSupplier） */}
      <Show when={renameTarget()}>
        <Modal open title="重命名供应商" size="md" onClose={() => setRenameTarget(null)}>
          <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">重命名供应商</h2>
            <p class="text-sm text-surface-500 mb-3">
              「{renameTarget()!.name}」→ 新名称（关联入库单的供应商引用将同步更新）
            </p>
            <input
              type="text"
              class="w-full px-3 py-2 border border-surface-200 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={renameValue()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleRename()}
              autofocus
            />
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setRenameTarget(null)}>取消</button>
              <button class="btn-primary" onClick={() => void handleRename()}>确认重命名</button>
            </div>
          </div>
        </Modal>
      </Show>

      {/* Context Menu（统一组件） */}
      <Show when={contextMenu.payload()}>
        {(s) => (
          <ContextMenu
            x={contextMenu.x()}
            y={contextMenu.y()}
            onClose={contextMenu.close}
            items={[
              {
                label: "编辑档案",
                icon: "✏️",
                action: () => navigate(`/suppliers/${encodeURIComponent(s().name)}`),
              },
              {
                label: "重命名",
                icon: "🔤",
                action: () => openRename(s()),
              },
              {
                label: "删除",
                icon: "🗑️",
                danger: true,
                action: () => void handleCardDelete(s()),
              },
            ]}
          />
        )}
      </Show>

      {/* 删除确认弹窗（照客户：「移入回收站」可在回收站恢复） */}
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
