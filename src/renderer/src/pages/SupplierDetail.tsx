import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import Modal from "~/components/ui/Modal";
import { tagList, loadTagDefs } from "~/stores/tags";
import { currentWorkspace, productSets, loadProductSets } from "~/stores/workspace";
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { showToast } from "~/stores/notifyBanner";
import { currentEditPrefill, clearEditPrefill } from "~/stores/createPrefill";
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
  // v2.5.5（B1-B）：脏守卫——编辑弹窗打开时表单初值快照 + 确认弹窗开关
  const [editSnapshot, setEditSnapshot] = createSignal<Record<string, unknown> | null>(null);
  const [discardEdit, setDiscardEdit] = createSignal(false);

  const [confirmDelete, setConfirmDelete] = createSignal<{ name: string } | null>(null);

  // v2.4.9 打磨 M8：关联产品集下拉（镜像客户详情 linkSelect）
  const [linkSelect, setLinkSelect] = createSignal("");

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
      loadProductSets();
      loadTagDefs();
    }
  });
  // v2.5.4（弹一 C-6）：编辑预填消费（单条制）——key=供应商名 → 建议改动合并到记录后打开编辑弹窗。
  // 记录异步加载（suppliers store）：未就绪不消费不清（等待 next 信号变化重跑）；始终找不到 = 忽略（不崩）。
  createEffect(() => {
    currentEditPrefill("supplier");
    const edit = currentEditPrefill("supplier");
    if (!edit) return;
    const found = detailSupplier();
    if (!found) return;
    openEditInfo({ ...found, ...(edit.payload as Partial<SupplierInfo>) });
    clearEditPrefill("supplier");
  });

  // —— 档案编辑 ——

  const openEditInfo = (s: SupplierInfo) => {
    const seeded = {
      contact: s.contact || "",
      phone: s.phone || "",
      email: s.email || "",
      address: s.address || "",
      tags: s.tags ?? [],
      notes: s.notes || "",
    };
    setEditingInfo(s);
    setEditContact(seeded.contact);
    setEditPhone(seeded.phone);
    setEditEmail(seeded.email);
    setEditAddress(seeded.address);
    setEditTags(seeded.tags);
    setEditNotes(seeded.notes);
    setEditSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setDiscardEdit(false);
  };

  /** v2.5.5（B1-B）：编辑弹窗脏判定 = 表单字段相对打开快照有改动 */
  const editDirty = () => {
    const snap = editSnapshot();
    if (!snap) return false;
    return (
      editContact() !== snap.contact ||
      editPhone() !== snap.phone ||
      editEmail() !== snap.email ||
      editAddress() !== snap.address ||
      editNotes() !== snap.notes ||
      JSON.stringify(editTags()) !== JSON.stringify(snap.tags)
    );
  };

  /** 关闭请求：dirty → 弹「放弃未保存内容？」；否则直关（取消按钮与遮罩/Esc 同路） */
  const requestCloseEdit = () => {
    if (discardEdit()) return; // 确认弹窗打开期间防叠加触发
    if (editDirty()) setDiscardEdit(true);
    else setEditingInfo(null);
  };

  /** 放弃修改（确认后）：真实关闭 */
  const confirmDiscardEdit = () => {
    setDiscardEdit(false);
    setEditingInfo(null);
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

  // —— 关联产品集（v2.4.9 打磨 M8：唯一写点在供应商侧；产品集侧只读反查留 v2.7，镜像客户 Clients.tsx:265-296）——

  const relatedProductSets = () => detailSupplier()?.related_product_sets ?? [];

  const unlinkedProductSets = () => {
    const linked = new Set(relatedProductSets());
    return productSets().filter((ps) => !linked.has(ps.name));
  };

  const handleLink = async () => {
    const name = supplierName();
    const ps = linkSelect();
    if (!name || !ps) return;
    const result = await api.suppliers.linkRelation(name, ps);
    if (result.success) {
      setLinkSelect("");
      loadSuppliers();
    } else {
      showToast("error", "关联失败", result.error || "未知错误");
    }
  };

  const handleUnlink = async (ps: string) => {
    const name = supplierName();
    if (!name) return;
    const result = await api.suppliers.unlinkRelation(name, ps);
    if (result.success) {
      loadSuppliers();
    } else {
      showToast("error", "解除关联失败", result.error || "未知错误");
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
          class="btn-secondary text-danger-600 hover:bg-danger-50 hover:border-danger-200"
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
        {/* 档案卡 + 关联产品集（v2.4.9 打磨 M8：布局镜像客户详情 Clients.tsx:439 三列网格） */}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6 shrink-0">
          {/* 档案卡 */}
          <div class="lg:col-span-2 card p-6">
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
            {/* erp_ext 只读区（v2.7 启禾 OS同步预留；无内容时不渲染） */}
            <Show when={detailSupplier()!.erp_ext && Object.keys(detailSupplier()!.erp_ext!).length > 0}>
              <div class="mt-4 pt-4 border-t border-surface-100">
                <p class="text-xs font-medium text-surface-400 mb-2">ERP 扩展信息（只读，由启禾 OS写回）</p>
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

          {/* 关联产品集（镜像客户 Clients.tsx:494-534 独立卡片即点即存；唯一写点在供应商侧） */}
          <div class="card p-6">
            <h3 class="text-lg font-semibold text-surface-900 mb-4">关联产品集</h3>
            <Show when={relatedProductSets().length > 0} fallback={
              <p class="text-sm text-surface-400">暂未关联产品集</p>
            }>
              <div class="flex flex-wrap gap-2">
                <For each={relatedProductSets()}>
                  {(ps) => (
                    <span
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-50 text-primary-700 text-sm cursor-pointer hover:bg-primary-100 transition-colors"
                      title={`打开产品集 ${ps}`}
                      onClick={() => navigate(`/product-sets/${encodeURIComponent(ps)}`)}
                    >
                      {ps}
                      <button
                        class="text-surface-400 hover:text-danger-500"
                        title="解除关联"
                        onClick={(e) => { e.stopPropagation(); void handleUnlink(ps); }}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex gap-2 mt-4">
              <select
                class="flex-1 px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white"
                value={linkSelect()}
                onChange={(e) => setLinkSelect(e.currentTarget.value)}
              >
                <option value="">选择产品集…</option>
                <For each={unlinkedProductSets()}>
                  {(ps) => <option value={ps.name}>{ps.name}</option>}
                </For>
              </select>
              <button class="btn-primary text-sm" onClick={handleLink} disabled={!linkSelect()}>添加</button>
            </div>
          </div>
        </div>

        {/* 文件区：FileBrowserView scope="supplier"（子文件夹 合同/对账单/往来文件，core create 已建齐）；
            保底高度同客户（min-h-[420px]），内容超高时由外层 main 滚动 */}
        <div class="flex-1 min-h-[420px]">
          <FileBrowserView scope="supplier" entity={supplierName()} subFolder={SUPPLIER_FIRST_SUBFOLDER} />
        </div>
      </Show>

      {/* 编辑档案弹窗 */}
      <Show when={editingInfo()}>
        <Modal
          open
          title="编辑供应商档案"
          size="xl"
          onClose={() => setEditingInfo(null)}
          // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
          dirty={editDirty()}
          onCloseRequest={requestCloseEdit}
        >
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
                scope="supplier" // v2.5.7（A3）：供应商域标签
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
              {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestCloseEdit（二次确认） */}
              <button class="btn-secondary" onClick={requestCloseEdit}>取消</button>
              <button class="btn-primary" onClick={() => void handleSaveInfo()}>保存</button>
            </div>
          </div>
        </Modal>
      </Show>

      {/* v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（编辑供应商档案；独立 Modal 叠层） */}
      <Show when={discardEdit()}>
        <ConfirmDialog
          title="放弃未保存内容？"
          message="该弹窗有未保存的修改，放弃后将不会保存任何内容。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          danger
          onConfirm={confirmDiscardEdit}
          onCancel={() => setDiscardEdit(false)}
        />
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
