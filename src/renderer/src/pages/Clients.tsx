import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { tagList, loadTagDefs } from "~/stores/tags";
import { currentWorkspace, workspaceConfig, productSets, loadProductSets } from "~/stores/workspace";
import { customers, loadCustomers } from "~/stores/clients";
import { showToast } from "~/stores/notifyBanner";
import TagChip from "~/components/TagChip";
import TagInput from "~/components/TagInput";
import EmptyState from "~/components/EmptyState";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
// v2.4.7（§5.2）：客户详情文件区——FileBrowser 抽取的共用组件，自含面包屑/子文件夹 Tab/文件区，
// 与 /files/customer/:name/:subFolder 路由页共用（tab 点击经组件内 navigate 直达完整文件管理页）
import FileBrowserView from "~/components/FileBrowserView";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { CustomerInfo, CustomerCreateRequest, CustomerUpdateRequest } from "~/types";

/** 档案字段展示行（值为空时显示灰占位符） */
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

export default function Clients() {
  const navigate = useNavigate();
  const params = useParams();
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newAlias, setNewAlias] = createSignal("");
  const [newCountry, setNewCountry] = createSignal("");
  const [newContact, setNewContact] = createSignal("");
  const [newSource, setNewSource] = createSignal("");
  const [newTags, setNewTags] = createSignal<string[]>([]);
  const [newNotes, setNewNotes] = createSignal("");

  const [editingName, setEditingName] = createSignal(false);
  const [editingNameValue, setEditingNameValue] = createSignal("");

  const [editingInfoCustomer, setEditingInfoCustomer] = createSignal<CustomerInfo | null>(null);
  const [editAlias, setEditAlias] = createSignal("");
  const [editCountry, setEditCountry] = createSignal("");
  const [editContact, setEditContact] = createSignal("");
  const [editSource, setEditSource] = createSignal("");
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");

  const [cSearch, setCSearch] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");

  // 详情：关联产品集下拉
  const [linkSelect, setLinkSelect] = createSignal("");

  // v2.4.7：删除客户确认弹窗状态（替代 window.confirm；fromDetail 区分详情页/卡片删除，成功后的处理不同）
  const [confirmDelete, setConfirmDelete] = createSignal<{ name: string; fromDetail: boolean } | null>(null);

  const contextMenu = useContextMenu<CustomerInfo>();

  const customerName = () => {
    const name = params.name || "";
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };

  const detailCustomer = () => customers().find((c) => c.name === customerName());

  const subFolders = () => workspaceConfig()?.customer_subfolders || ["报价", "合同", "沟通", "其他"];

  // v2.3.0：已定义标签名集合（孤儿标签警告）
  const definedTagNames = () => new Set(tagList().flatMap((t) => [t.name, ...(t.children ?? [])]));

  createEffect(() => {
    if (currentWorkspace()) {
      loadCustomers();
      loadProductSets();
      loadTagDefs();
    }
  });

  const allTags = () => {
    const set = new Set<string>();
    for (const c of customers()) {
      for (const tag of c.tags || []) {
        set.add(tag);
      }
    }
    return Array.from(set).sort();
  };

  const filteredCustomers = () => {
    const term = cSearch().trim().toLowerCase();
    const tag = tagFilter();
    return customers().filter((c) => {
      if (term && !c.name.toLowerCase().includes(term) && !(c.alias || "").toLowerCase().includes(term)) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      return true;
    });
  };

  // —— 新建 ——

  const handleCreate = async () => {
    const name = newName().trim();
    if (!name) return;
    const req: CustomerCreateRequest = {
      name,
      alias: newAlias().trim() || undefined,
      country: newCountry().trim() || undefined,
      contact: newContact().trim() || undefined,
      source: newSource().trim() || undefined,
      tags: newTags(),
      notes: newNotes().trim() || undefined,
    };
    const result = await api.clients.create(req);
    if (result.success) {
      setShowCreateModal(false);
      setNewName("");
      setNewAlias("");
      setNewCountry("");
      setNewContact("");
      setNewSource("");
      setNewTags([]);
      setNewNotes("");
      loadCustomers();
    } else {
      showToast("error", "创建失败", result.error || "未知错误");
    }
  };

  // —— 重命名（有文件不可重命名，错误文案来自服务层）——

  const handleRenameCustomer = async () => {
    const oldName = customerName();
    if (!oldName || !editingNameValue() || editingNameValue() === oldName) {
      setEditingName(false);
      return;
    }
    const result = await api.clients.rename(oldName, editingNameValue());
    if (result.success) {
      setEditingName(false);
      loadCustomers();
      navigate(`/clients/${encodeURIComponent(editingNameValue())}`);
    } else {
      showToast("error", "重命名失败", result.error || "未知错误");
      setEditingNameValue(oldName);
    }
  };

  // —— 删除（进回收站，kind='customer'；customers.json 条目保留，恢复即复原）——

  const handleDeleteCustomer = () => {
    const name = customerName();
    if (!name) return;
    setConfirmDelete({ name, fromDetail: true });
  };

  /** 确认后的删除执行（详情页删除：成功跳回客户列表） */
  const doDeleteCustomer = async (name: string) => {
    const result = await api.clients.delete(name);
    if (result.success) {
      navigate("/clients");
      loadCustomers();
    } else {
      showToast("error", "删除客户失败", result.error || "未知错误");
    }
  };

  const handleCardDelete = (c: CustomerInfo, e?: MouseEvent) => {
    e?.stopPropagation();
    contextMenu.close();
    setConfirmDelete({ name: c.name, fromDetail: false });
  };

  /** 确认后的删除执行（卡片删除：留在列表页） */
  const doCardDelete = async (name: string) => {
    const result = await api.clients.delete(name);
    if (result.success) {
      loadCustomers();
    } else {
      showToast("error", "删除客户失败", result.error || "未知错误");
    }
  };

  // —— 档案编辑 ——

  const openEditInfo = (c: CustomerInfo) => {
    setEditingInfoCustomer(c);
    setEditAlias(c.alias || "");
    setEditCountry(c.country || "");
    setEditContact(c.contact || "");
    setEditSource(c.source || "");
    setEditTags(c.tags ?? []);
    setEditNotes(c.notes || "");
  };

  const handleSaveInfo = async () => {
    const c = editingInfoCustomer();
    if (!c) return;
    const req: CustomerUpdateRequest = {
      name: c.name,
      alias: editAlias().trim() || undefined,
      country: editCountry().trim() || undefined,
      contact: editContact().trim() || undefined,
      source: editSource().trim() || undefined,
      tags: editTags(),
      notes: editNotes().trim() || undefined,
    };
    const result = await api.clients.update(req);
    if (result.success) {
      setEditingInfoCustomer(null);
      loadCustomers();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  // —— 关联产品集（唯一写点在客户侧；点击 chip 跳转产品集详情）——

  const relatedProductSets = () => detailCustomer()?.related_product_sets ?? [];

  const unlinkedProductSets = () => {
    const linked = new Set(relatedProductSets());
    return productSets().filter((ps) => !linked.has(ps.name));
  };

  const handleLink = async () => {
    const name = customerName();
    const ps = linkSelect();
    if (!name || !ps) return;
    const result = await api.clients.linkRelation(name, ps);
    if (result.success) {
      setLinkSelect("");
      loadCustomers();
    } else {
      showToast("error", "关联失败", result.error || "未知错误");
    }
  };

  const handleUnlink = async (ps: string) => {
    const name = customerName();
    if (!name) return;
    const result = await api.clients.unlinkRelation(name, ps);
    if (result.success) {
      loadCustomers();
    } else {
      showToast("error", "解除关联失败", result.error || "未知错误");
    }
  };

  // —— erp_ext 只读展示（v2.6 erp-bridge 写回命名空间，本体只读不校验）——

  const erpExtEntries = () => {
    const ext = detailCustomer()?.erp_ext;
    if (!ext || Object.keys(ext).length === 0) return [];
    return Object.entries(ext).map(([k, v]) => ({ key: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
  };

  return (
    <div class={`p-6 max-w-7xl mx-auto ${params.name ? "flex flex-col h-full" : ""}`}>
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">客户</h1>
          <p class="text-surface-500 mt-1">管理客户档案与合作文件</p>
        </div>
        <button class="btn-primary" onClick={() => setShowCreateModal(true)}>
          <span>➕</span> 新建客户
        </button>
      </div>

      <Show when={customers().length > 0} fallback={
        <EmptyState icon="🤝" title="暂无客户" desc="创建您第一个客户来开始管理">
          <button class="btn-primary" onClick={() => setShowCreateModal(true)}>新建客户</button>
        </EmptyState>
      }>
        <Show when={!params.name}>
          <div class="flex flex-col md:flex-row gap-3 mb-4">
            <input
              type="text"
              class="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm"
              placeholder="搜索客户名称或别名..."
              value={cSearch()}
              onInput={(e) => setCSearch(e.currentTarget.value)}
            />
            <select
              class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
              value={tagFilter()}
              onChange={(e) => setTagFilter(e.currentTarget.value)}
            >
              <option value="">全部标签</option>
              <For each={allTags()}>
                {(tag) => <option value={tag}>{tag}</option>}
              </For>
            </select>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <For each={filteredCustomers()}>
              {(c) => (
                <div
                  class="card p-5 cursor-pointer hover:shadow-card-hover transition-all group relative"
                  onClick={() => navigate(`/clients/${encodeURIComponent(c.name)}`)}
                  onContextMenu={(e) => contextMenu.open(e, c)}
                >
                  <div class="flex items-start justify-between">
                    <div class="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center text-2xl">
                      🤝
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-xs px-2 py-1 rounded-full bg-surface-100 text-surface-500">
                        {c.file_count} 文件
                      </span>
                      <button
                        class="text-surface-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => handleCardDelete(c, e)}
                        title="删除客户"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <h3 class="text-lg font-semibold mt-3 text-surface-900">{c.name}</h3>
                  <Show when={c.alias || c.country}>
                    <p class="text-sm text-surface-400 mt-1">
                      {c.alias}{c.alias && c.country ? " · " : ""}{c.country}
                    </p>
                  </Show>
                  <Show when={c.tags && c.tags.length > 0}>
                    <div class="flex flex-wrap gap-1.5 mt-3">
                      <For each={c.tags}>
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
                  <Show when={c.notes}>
                    <p class="text-xs text-surface-400 mt-2 line-clamp-2">{c.notes}</p>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* —— 详情态 —— */}
        <Show when={params.name}>
          <div class="flex items-center gap-2 mb-2 text-sm text-surface-500 shrink-0">
            <button class="hover:text-primary-600" onClick={() => navigate("/clients")}>客户</button>
            <span>/</span>
            <Show when={!editingName()} fallback={
              <input
                type="text"
                class="px-2 py-1 border border-surface-200 rounded text-sm"
                value={editingNameValue()}
                onInput={(e) => setEditingNameValue(e.currentTarget.value)}
                onBlur={handleRenameCustomer}
                onKeyDown={(e) => e.key === "Enter" && handleRenameCustomer()}
                autofocus
              />
            }>
              <span
                class="text-surface-900 font-medium cursor-pointer hover:text-primary-600"
                onClick={() => { setEditingName(true); setEditingNameValue(customerName() || ""); }}
              >
                {customerName()} ✏️
              </span>
            </Show>
          </div>

          <div class="flex items-center justify-between mb-6 shrink-0">
            <div>
              <h1 class="text-2xl font-bold text-surface-900">{customerName()}</h1>
              <p class="text-surface-500 mt-1">客户档案与文件管理</p>
            </div>
            <button
              class="btn-secondary text-red-600 hover:bg-red-50 hover:border-red-200"
              onClick={handleDeleteCustomer}
            >
              🗑️ 删除客户
            </button>
          </div>

          <Show when={detailCustomer()} fallback={
            <EmptyState icon="🤝" title="客户不存在" desc="该客户可能已被删除，或工作区已切换">
              <button class="btn-primary" onClick={() => navigate("/clients")}>返回客户列表</button>
            </EmptyState>
          }>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6 shrink-0">
              {/* ① 档案卡 */}
              <div class="lg:col-span-2 card p-6">
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-lg font-semibold text-surface-900">客户档案</h3>
                  <button class="btn-secondary text-sm" onClick={() => openEditInfo(detailCustomer()!)}>
                    ✏️ 编辑档案
                  </button>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                  <InfoRow label="别名" value={detailCustomer()!.alias} />
                  <InfoRow label="国家" value={detailCustomer()!.country} />
                  <InfoRow label="联系方式" value={detailCustomer()!.contact} />
                  <InfoRow label="客户来源" value={detailCustomer()!.source} />
                </div>
                <Show when={(detailCustomer()!.tags || []).length > 0}>
                  <div class="flex flex-wrap gap-1.5 mt-4">
                    <For each={detailCustomer()!.tags || []}>
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
                <Show when={detailCustomer()!.notes}>
                  <p class="text-sm text-surface-600 mt-4 whitespace-pre-wrap">{detailCustomer()!.notes}</p>
                </Show>
                {/* erp_ext 只读区：本体只读不校验（v2.6 erp-bridge 写回），无内容时不渲染 */}
                <Show when={erpExtEntries().length > 0}>
                  <div class="mt-4 pt-4 border-t border-surface-100">
                    <p class="text-xs font-medium text-surface-400 mb-2">ERP 扩展信息（只读，由仓迹写回）</p>
                    <div class="flex flex-wrap gap-2">
                      <For each={erpExtEntries()}>
                        {(e) => (
                          <span class="text-xs px-2 py-1 rounded-lg bg-surface-100 text-surface-600">
                            <span class="font-medium text-surface-500">{e.key}</span>: {e.value}
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <p class="text-xs text-surface-400 mt-4">
                  创建于 {detailCustomer()!.created_at} · 更新于 {detailCustomer()!.updated_at}
                </p>
              </div>

              {/* ③ 关联产品集 */}
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
                            class="text-surface-400 hover:text-red-500"
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

            {/* ② 子文件夹文件区：FileBrowserView 自含子文件夹 Tab（报价/合同/沟通/其他）与文件网格，
                tab 点击经组件内 navigate 直达 /files/customer/:name/:subFolder 完整文件管理页 */}
            <div class="flex-1 min-h-0">
              <FileBrowserView scope="customer" entity={customerName()} subFolder={subFolders()[0] || ""} />
            </div>
          </Show>
        </Show>
      </Show>

      {/* 新建客户弹窗 */}
      <Show when={showCreateModal()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden" onClick={() => setShowCreateModal(false)}>
          <div class="bg-white rounded-2xl w-full max-w-xl p-6 shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">新建客户</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">客户名称</label>
              <input
                type="text"
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="如：张三"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
              />
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">别名</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：三哥"
                  value={newAlias()}
                  onInput={(e) => setNewAlias(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">国家</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：中国"
                  value={newCountry()}
                  onInput={(e) => setNewCountry(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">联系方式</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：13800138000"
                  value={newContact()}
                  onInput={(e) => setNewContact(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">客户来源</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：展会、老客户"
                  value={newSource()}
                  onInput={(e) => setNewSource(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={newTags()}
                onChange={setNewTags}
                options={tagList()}
                placeholder="如：重点、外贸"
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
        </div>
      </Show>

      {/* 编辑档案弹窗 */}
      <Show when={editingInfoCustomer()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden" onClick={() => setEditingInfoCustomer(null)}>
          <div class="bg-white rounded-2xl w-full max-w-xl p-6 shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">编辑客户档案</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">别名</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editAlias()}
                  onInput={(e) => setEditAlias(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">国家</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editCountry()}
                  onInput={(e) => setEditCountry(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">联系方式</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editContact()}
                  onInput={(e) => setEditContact(e.currentTarget.value)}
                />
              </div>
              <div class="mb-4">
                <label class="block text-sm font-medium text-surface-700 mb-1">客户来源</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={editSource()}
                  onInput={(e) => setEditSource(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={editTags()}
                onChange={setEditTags}
                options={tagList()}
                placeholder="如：重点、外贸"
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
              <button class="btn-secondary" onClick={() => setEditingInfoCustomer(null)}>取消</button>
              <button class="btn-primary" onClick={handleSaveInfo}>保存</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Context Menu（统一组件，v2.3.x） */}
      <Show when={contextMenu.payload()}>
        {(c) => (
          <ContextMenu
            x={contextMenu.x()}
            y={contextMenu.y()}
            onClose={contextMenu.close}
            items={[
              {
                label: "编辑档案",
                icon: "✏️",
                action: () => openEditInfo(c()),
              },
              {
                label: "删除",
                icon: "🗑️",
                danger: true,
                action: () => void handleCardDelete(c()),
              },
            ]}
          />
        )}
      </Show>

      {/* 删除客户确认弹窗（v2.4.7 替代 window.confirm） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除客户"
          message={`确定删除客户 "${confirmDelete()!.name}" 吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const target = confirmDelete()!;
            setConfirmDelete(null);
            if (target.fromDetail) void doDeleteCustomer(target.name);
            else void doCardDelete(target.name);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
