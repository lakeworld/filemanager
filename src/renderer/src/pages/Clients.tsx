import { Show, For, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import CreateClientModal from "./clients/CreateClientModal";
import EditInfoModal from "./clients/EditInfoModal";
import { tagList, loadTagDefs } from "~/stores/tags";
import { currentWorkspace, workspaceConfig, productSets, loadProductSets } from "~/stores/workspace";
import { customers, loadCustomers } from "~/stores/clients";
import { prefillVersion, currentPrefill, advancePrefill, clearPrefill, currentEditPrefill, clearEditPrefill } from "~/stores/createPrefill";
import type { CustomerPrefill } from "~/stores/createPrefillNormalize";
import { showToast } from "~/stores/notifyBanner";
import TagChip from "~/components/TagChip";
import TagInput from "~/components/TagInput";
import EmptyState from "~/components/EmptyState";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import VirtualGrid from "~/components/VirtualGrid";
// v2.4.7（§5.2）：客户详情文件区——FileBrowser 抽取的共用组件，自含面包屑/子文件夹 Tab/文件区，
// 与 /files/customer/:name/:subFolder 路由页共用（tab 点击经组件内 navigate 直达完整文件管理页）
import FileBrowserView from "~/components/FileBrowserView";
// v2.4.9 S3b：客户详情报价联动——报价状态徽标色复用列表页同款
import { statusChipClass } from "~/components/QuoteStatusActions";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { CustomerInfo, CustomerCreateRequest, CustomerUpdateRequest, QuoteRecord } from "~/types";

// v2.5.2：客户列表渲染口径——<200 条 For 全量、≥200 条 VirtualGrid 虚拟滚动（照 Suppliers/回收站先例，阈值统一 200）
const CLIENT_VIRTUAL_THRESHOLD = 200;
// 卡片高 ≈ p-5 上下 40px + 图标 48 + 标题 ~28 + 可选副行 ~20 + 标签行 ~30 + 备注 2 行 ~32 ≈ 198px，
// 行间距 16px 计入 itemHeight（估算取整防重叠，同回收站 TRASH_ROW_HEIGHT 做法）
const CLIENT_ROW_HEIGHT = 208;

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

/** 金额展示（v2.4.9 S3b：客户详情报价联动小计；仅展示） */
function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

// v2.5.3（P2-12）：报价加载序号模块级（照 Images imageLoadSeq 先例）——卸载清理递增后跨挂载延续计数，
// 旧实例在途链持有的旧值永远不会与新实例的计数撞号，过期结果必被丢弃
let clientQuoteLoadSeq = 0;

export default function Clients() {
  const navigate = useNavigate();
  const params = useParams();
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  // v2.5.4 预填（PLAN-v2.5.4 §3.4）：预填载荷（null = 手动新建空表）
  const [createInitial, setCreateInitial] = createSignal<CustomerPrefill | null>(null);
  // v2.5.1（T4）：列表加载守卫——初始 Skeleton 不闪空态（T0 坐实违规 Clients:337）
  const [loadingCustomers, setLoadingCustomers] = createSignal(true);
  const reloadCustomers = async () => {
    setLoadingCustomers(true);
    await loadCustomers();
    setLoadingCustomers(false);
  };
  const [newName, setNewName] = createSignal("");
  const [newAlias, setNewAlias] = createSignal("");
  const [newCountry, setNewCountry] = createSignal("");
  const [newContact, setNewContact] = createSignal("");
  const [newSource, setNewSource] = createSignal("");
  // v2.4.9 打磨 M2：新建弹窗补 type/phone/email/address（对齐编辑弹窗 S1 字段；type 默认空=未分类）
  const [newType, setNewType] = createSignal<"" | "企业" | "个人">("");
  const [newPhone, setNewPhone] = createSignal("");
  const [newEmail, setNewEmail] = createSignal("");
  const [newAddress, setNewAddress] = createSignal("");
  const [newTags, setNewTags] = createSignal<string[]>([]);
  const [newNotes, setNewNotes] = createSignal("");

  // v2.5.4 预填消费（PLAN-v2.5.4 §3.3）：版本变化 → 有预填则开弹窗填表；只开不关（关闭走显式路径）
  createEffect(() => {
    prefillVersion("customer");
    const cur = currentPrefill("customer") as CustomerPrefill | null;
    if (cur) {
      setCreateInitial(cur);
      setShowCreateModal(true);
    }
  });
  // v2.5.4（弹一 C-6）：编辑预填消费（单条制）——key=客户名 → 列表找记录 → 建议改动合并到记录注入编辑弹窗。
  // 等列表加载就绪再消费（loading 门控防竞态丢建议）；已加载仍未找到 = key 不存在 → 清空忽略。
  createEffect(() => {
    currentEditPrefill("customer");
    const edit = currentEditPrefill("customer");
    if (!edit) return;
    if (loadingCustomers()) return;
    const found = customers().find((c) => c.name === edit.key);
    if (found) {
      setEditingInfoCustomer({ ...found, ...(edit.payload as Partial<CustomerInfo>) });
    }
    clearEditPrefill("customer");
  });

  const [editingName, setEditingName] = createSignal(false);
  const [editingNameValue, setEditingNameValue] = createSignal("");

  const [editingInfoCustomer, setEditingInfoCustomer] = createSignal<CustomerInfo | null>(null);
  const [editAlias, setEditAlias] = createSignal("");
  const [editCountry, setEditCountry] = createSignal("");
  const [editContact, setEditContact] = createSignal("");
  const [editSource, setEditSource] = createSignal("");
  // v2.4.9 S1：客户对齐字段（type 下拉默认空=未分类）
  const [editType, setEditType] = createSignal<"" | "企业" | "个人">("");
  const [editPhone, setEditPhone] = createSignal("");
  const [editEmail, setEditEmail] = createSignal("");
  const [editAddress, setEditAddress] = createSignal("");
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");

  const [cSearch, setCSearch] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");
  // v2.4.9 打磨 M3：客户类型筛选；「未分类」用哨兵 "__none__" 映射 c.type === undefined（默认 ""=全部）
  const [typeFilter, setTypeFilter] = createSignal("");

  // 详情：关联产品集下拉
  const [linkSelect, setLinkSelect] = createSignal("");

  // v2.4.9 S3b：该客户报价（quotes.list 按 customer 名字引用过滤；改名级联由 core renameCustomer 编排）
  const [customerQuotes, setCustomerQuotes] = createSignal<QuoteRecord[]>([]);
  // v2.5.3（P2-12）：卸载即递增加载代（模块级）——未完成的报价加载链校验失效后立即退出
  onCleanup(() => {
    clientQuoteLoadSeq++;
  });

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
      void reloadCustomers();
      loadProductSets();
      loadTagDefs();
      loadCustomerQuotes();
    }
  });

  /** 该客户报价列表（名字引用过滤；改名成功后须重载——filter 依据跟随新名） */
  const loadCustomerQuotes = async () => {
    const s = ++clientQuoteLoadSeq;
    const name = customerName();
    if (!name) return;
    const r = await api.quotes.list();
    if (s !== clientQuoteLoadSeq) return;
    if (r.success && r.data) setCustomerQuotes(r.data.filter((q) => q.customer === name));
  };

  const allTags = () => {
    const set = new Set<string>();
    for (const c of customers()) {
      for (const tag of c.tags || []) {
        set.add(tag);
      }
    }
    return Array.from(set).sort();
  };

  // v2.5.2：filteredCustomers 包 createMemo——避免每次渲染重算过滤（列表/详情双态共用）
  const filteredCustomers = createMemo(() => {
    const term = cSearch().trim().toLowerCase();
    const tag = tagFilter();
    const type = typeFilter();
    return customers().filter((c) => {
      if (term && !c.name.toLowerCase().includes(term) && !(c.alias || "").toLowerCase().includes(term)) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      // M3：类型筛选与搜索/标签叠加；哨兵 "__none__" 命中 type 为 undefined（未分类）的客户
      if (type === "__none__" ? c.type !== undefined : type && c.type !== type) return false;
      return true;
    });
  });

  // v2.5.2：客户卡片渲染——小列表 For 与超阈值 VirtualGrid 共用（避免两份 JSX 漂移，照 Suppliers renderCard 模式）
  const renderCard = (c: CustomerInfo) => (
    <div
      class="card p-5 cursor-pointer hover:shadow-card-hover group relative"
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
            class="text-surface-400 hover:text-danger-500 opacity-0 group-hover:opacity-100 transition-opacity"
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
  );

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
      // M2：type 空=未分类 → 提交 undefined（assertCustomerType 白名单仅 企业/个人/undefined）
      type: newType() || undefined,
      phone: newPhone().trim() || undefined,
      email: newEmail().trim() || undefined,
      address: newAddress().trim() || undefined,
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
      setNewType("");
      setNewPhone("");
      setNewEmail("");
      setNewAddress("");
      setNewTags([]);
      setNewNotes("");
      void reloadCustomers();
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
      void reloadCustomers();
      // v2.4.9 S3b：改名级联报价台账（core renameCustomer 编排），详情联动按新名重载
      loadCustomerQuotes();
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
      void reloadCustomers();
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
      void reloadCustomers();
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
    setEditType(c.type || "");
    setEditPhone(c.phone || "");
    setEditEmail(c.email || "");
    setEditAddress(c.address || "");
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
      type: editType() || undefined,
      phone: editPhone().trim() || undefined,
      email: editEmail().trim() || undefined,
      address: editAddress().trim() || undefined,
      tags: editTags(),
      notes: editNotes().trim() || undefined,
    };
    const result = await api.clients.update(req);
    if (result.success) {
      setEditingInfoCustomer(null);
      void reloadCustomers();
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
      void reloadCustomers();
    } else {
      showToast("error", "关联失败", result.error || "未知错误");
    }
  };

  const handleUnlink = async (ps: string) => {
    const name = customerName();
    if (!name) return;
    const result = await api.clients.unlinkRelation(name, ps);
    if (result.success) {
      void reloadCustomers();
    } else {
      showToast("error", "解除关联失败", result.error || "未知错误");
    }
  };

  // —— erp_ext 只读展示（v2.7 erp-bridge 写回命名空间，本体只读不校验）——

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
        <button class="btn-primary" onClick={() => { clearPrefill("customer"); setCreateInitial(null); setShowCreateModal(true); }}>
          <span>➕</span> 新建客户
        </button>
      </div>

      <Show when={!loadingCustomers()} fallback={
        <div class="flex flex-col gap-3 py-8">
          <div class="skeleton h-20 w-full rounded-xl" />
          <div class="skeleton h-20 w-full rounded-xl" />
          <div class="skeleton h-20 w-full rounded-xl" />
        </div>
      }>
        <Show when={customers().length > 0} fallback={
          <EmptyState icon="🤝" title="暂无客户" desc="创建您第一个客户来开始管理">
            <button class="btn-primary" onClick={() => { clearPrefill("customer"); setCreateInitial(null); setShowCreateModal(true); }}>新建客户</button>
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
            {/* v2.4.9 打磨 M3：客户类型筛选（r3 拍板：新 select 必补 aria-label 供 e2e 定位） */}
            <select
              aria-label="客户类型"
              class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
              value={typeFilter()}
              onChange={(e) => setTypeFilter(e.currentTarget.value)}
            >
              <option value="">全部类型</option>
              <option value="__none__">未分类</option>
              <option value="企业">企业</option>
              <option value="个人">个人</option>
            </select>
          </div>
          <Show
            when={filteredCustomers().length >= CLIENT_VIRTUAL_THRESHOLD}
            fallback={
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <For each={filteredCustomers()}>{(c) => renderCard(c)}</For>
              </div>
            }
          >
            {/* v2.5.2：≥200 条走虚拟滚动——只渲染可见行，客户数无上限（照 Suppliers 先例） */}
            <div class="flex-1 min-h-0">
              <VirtualGrid
                items={filteredCustomers()}
                itemHeight={CLIENT_ROW_HEIGHT}
                columns={{ base: 1, md: 2, lg: 3 }}
                gap={16}
                // v2.5.3（P2-11）：搜索/筛选切换时滚动归零（照 Quotes/Invoices scrollResetKey 先例）
                scrollResetKey={`${cSearch()}|${tagFilter()}|${typeFilter()}`}
                renderItem={(c) => renderCard(c)}
              />
            </div>
          </Show>
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
              class="btn-secondary text-danger-600 hover:bg-danger-50 hover:border-danger-200"
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
                  <InfoRow label="客户类型" value={detailCustomer()!.type} />
                  <InfoRow label="联系方式" value={detailCustomer()!.contact} />
                  <InfoRow label="电话" value={detailCustomer()!.phone} />
                  <InfoRow label="邮箱" value={detailCustomer()!.email} />
                  <InfoRow label="地址" value={detailCustomer()!.address} />
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
                {/* erp_ext 只读区：本体只读不校验（v2.7 erp-bridge 写回），无内容时不渲染 */}
                <Show when={erpExtEntries().length > 0}>
                  <div class="mt-4 pt-4 border-t border-surface-100">
                    <p class="text-xs font-medium text-surface-400 mb-2">ERP 扩展信息（只读，由启禾 OS写回）</p>
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

              {/* ④ 报价单（v2.4.9 S3b：该客户报价数 + 列表，点击跳报价详情；改名级联由 core 编排） */}
              <div class="card p-6">
                <div class="flex items-center justify-between mb-1">
                  <h3 class="text-lg font-semibold text-surface-900">报价单</h3>
                  <button
                    class="text-xs text-primary-600 hover:text-primary-700 shrink-0"
                    onClick={() => navigate("/quotes")}
                  >
                    去报价台账 →
                  </button>
                </div>
                <p class="text-xs text-surface-400 mb-3">共 {customerQuotes().length} 张报价单</p>
                <Show when={customerQuotes().length > 0} fallback={
                  <p class="text-sm text-surface-400">暂无报价单</p>
                }>
                  <div class="flex flex-col -mx-2">
                    <For each={customerQuotes()}>
                      {(q) => (
                        <button
                          class="px-2 py-2 rounded-lg hover:bg-surface-50 text-left transition-colors w-full"
                          title="打开报价详情"
                          onClick={() => navigate(`/quotes/${encodeURIComponent(q.quotation_no)}`)}
                        >
                          <div class="flex items-center gap-2">
                            <span class="flex-1 min-w-0 truncate font-medium text-primary-700 text-sm">{q.quotation_no}</span>
                            <span class="tabular-nums text-surface-900 text-sm shrink-0">¥{fmtMoney(q.total_amount)}</span>
                          </div>
                          <div class="flex items-center gap-2 mt-0.5">
                            <span class="text-surface-500 text-xs shrink-0">{q.date}</span>
                            <span class={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${statusChipClass(q.status)}`}>
                              {q.status}
                            </span>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            {/* ② 子文件夹文件区：FileBrowserView 自含子文件夹 Tab（报价/合同/沟通/其他）与文件网格，
                tab 点击经组件内 navigate 直达 /files/customer/:name/:subFolder 完整文件管理页
                v2.4.8：保底高度——档案卡高时 flex-1 把文件区压缩成小条，拖放提示溢出虚线框外；
                改 min-h-[420px]（空态 ~180px + 面包屑/Tab ~100px 后仍有富余），内容超高时由外层 main 滚动 */}
            <div class="flex-1 min-h-[420px]">
              <FileBrowserView scope="customer" entity={customerName()} subFolder={subFolders()[0] || ""} />
            </div>
          </Show>
        </Show>
      </Show>
      </Show>

      {/* 新建客户弹窗 */}
      <CreateClientModal
        open={showCreateModal()}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => {
          void reloadCustomers();
          advancePrefill("customer");
        }}
        initial={createInitial()}
        onCancel={() => {
          clearPrefill("customer");
          setCreateInitial(null);
          setShowCreateModal(false);
        }}
      />
      <EditInfoModal customer={editingInfoCustomer()} onClose={() => setEditingInfoCustomer(null)} onSaved={loadCustomers} />
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
