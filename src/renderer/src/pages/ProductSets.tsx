import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { tagList } from "~/stores/tags";
import TagChip from "~/components/TagChip";
import ContextMenu from "~/components/ContextMenu";
import TagInput from "~/components/TagInput";
import EmptyState from "~/components/EmptyState";
import { useContextMenu } from "~/hooks/useContextMenu";
import {
  currentWorkspace,
  productSets,
  loadProductSets,
  setSelectedProductSet,
  workspaceConfig,
} from "~/stores/workspace";
import type { ApiResult, CustomerInfo, ProductSetInfo, ProductSetCreateRequest } from "~/types";

export default function ProductSets() {
  const navigate = useNavigate();
  const params = useParams();
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [newPsName, setNewPsName] = createSignal("");
  const [newPsTags, setNewPsTags] = createSignal<string[]>([]);
  const [newPsNotes, setNewPsNotes] = createSignal("");

  const [editingPs, setEditingPs] = createSignal(false);
  const [editingPsName, setEditingPsName] = createSignal("");

  const [editingInfoPs, setEditingInfoPs] = createSignal<ProductSetInfo | null>(null);
  const [editTags, setEditTags] = createSignal<string[]>([]);
  const [editNotes, setEditNotes] = createSignal("");

  const [psSearch, setPsSearch] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal<string>("");

  // v2.4.7（§5.2）：详情态「关联客户」只读区块——customers.json 反查 related_product_sets 含本集的客户
  // （写操作只在客户侧，单一写点，无双向同步；点击跳客户详情）
  const [relatedCustomers, setRelatedCustomers] = createSignal<CustomerInfo[]>([]);

  const contextMenu = useContextMenu<ProductSetInfo>();

  const psName = () => {
    const name = params.name || "";
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  };

  // v2.3.0：已定义标签名集合（孤儿标签警告）
  const definedTagNames = () => new Set(tagList().flatMap((t) => [t.name, ...(t.children ?? [])]));

  createEffect(() => {
    if (currentWorkspace()) {
      loadProductSets();
    }
  });

  createEffect(() => {
    if (psName()) {
      setSelectedProductSet(psName());
    }
  });

  // v2.4.7（§5.2）：关联客户反查加载（目录扫描为实；api.clients 门面由并行 IPC 代理产出，见报告交接点）
  createEffect(() => {
    const name = psName();
    if (!name) {
      setRelatedCustomers([]);
      return;
    }
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    api.clients.list().then((result: ApiResult<CustomerInfo[]>) => {
      if (cancelled || !result.success || !result.data) return;
      setRelatedCustomers(result.data.filter((c) => (c.related_product_sets ?? []).includes(name)));
    });
  });

  const allTags = () => {
    const set = new Set<string>();
    for (const ps of productSets()) {
      for (const tag of ps.tags || []) {
        set.add(tag);
      }
    }
    return Array.from(set).sort();
  };

  const filteredProductSets = () => {
    const term = psSearch().trim().toLowerCase();
    const tag = tagFilter();
    return productSets().filter((ps) => {
      if (term && !ps.name.toLowerCase().includes(term)) return false;
      if (tag && !(ps.tags || []).includes(tag)) return false;
      return true;
    });
  };

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];
  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  const handleCreate = async () => {
    const name = newPsName().trim();
    if (!name) return;
    const req: ProductSetCreateRequest = {
      name,
      tags: newPsTags(),
      notes: newPsNotes().trim(),
    };
    const result = await api.productSets.create(req);
    if (result.success) {
      setShowCreateModal(false);
      setNewPsName("");
      setNewPsTags([]);
      setNewPsNotes("");
      loadProductSets();
    } else {
      window.alert(result.error || "创建失败");
    }
  };

  const handleDownloadTemplate = async () => {
    const result = await api.csvTemplate();
    if (result.success && result.data) {
      const path = await api.dialog.saveFile("保存 CSV 模板", "product_set_template.csv");
      if (path) {
        const saved = await api.files.saveTextFile(path, result.data);
        if (!saved.success) window.alert(saved.error || "保存模板失败");
      }
    } else {
      window.alert(result.error || "获取 CSV 模板失败");
    }
  };

  const handleExportXlsxTemplate = async () => {
    const path = await api.dialog.saveFile("保存 XLSX 模板", "product_set_template.xlsx");
    if (path) {
      const result = await api.xlsx.exportTemplate(path);
      if (!result.success) {
        window.alert(result.error || "导出模板失败");
      }
    }
  };

  const handleImportXlsx = async () => {
    const path = await api.dialog.openFile("选择 XLSX 文件", [
      { displayName: "Excel 文件", pattern: "*.xlsx" },
    ]);
    if (path) {
      const result = await api.xlsx.import(path);
      if (result.success) {
        loadProductSets();
      } else {
        window.alert(result.error || "导入失败");
      }
    }
  };

  const handleRenameProductSet = async () => {
    const ps = psName();
    if (!ps || !editingPsName() || editingPsName() === ps) {
      setEditingPs(false);
      return;
    }
    const result = await api.productSets.rename(ps, editingPsName());
    if (result.success) {
      setEditingPs(false);
      loadProductSets();
      navigate(`/product-sets/${encodeURIComponent(editingPsName())}`);
    } else {
      window.alert(result.error || "重命名失败");
      setEditingPsName(ps);
    }
  };

  const handleDeleteProductSet = async () => {
    const ps = psName();
    if (!ps) return;
    if (!window.confirm(`确定删除产品集 "${ps}" 吗？将移入回收站，可在回收站恢复。`)) return;
    const result = await api.productSets.delete(ps);
    if (result.success) {
      navigate("/product-sets");
      loadProductSets();
    } else {
      window.alert(result.error || "删除产品集失败");
    }
  };

  const openEditInfo = (ps: ProductSetInfo) => {
    setEditingInfoPs(ps);
    setEditTags(ps.tags ?? []);
    setEditNotes(ps.notes || "");
  };

  const handleSaveInfo = async () => {
    const ps = editingInfoPs();
    if (!ps) return;
    const result = await api.productSets.updateInfo({
      name: ps.name,
      tags: editTags(),
      notes: editNotes().trim(),
    });
    if (result.success) {
      setEditingInfoPs(null);
      loadProductSets();
    } else {
      window.alert(result.error || "保存失败");
    }
  };

  const handleCardDelete = async (ps: ProductSetInfo, e?: MouseEvent) => {
    e?.stopPropagation();
    contextMenu.close();
    if (!window.confirm(`确定删除产品集 "${ps.name}" 吗？将移入回收站，可在回收站恢复。`)) return;
    const result = await api.productSets.delete(ps.name);
    if (result.success) {
      loadProductSets();
    } else {
      window.alert(result.error || "删除产品集失败");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">产品集</h1>
          <p class="text-surface-500 mt-1">管理您的产品系列</p>
        </div>
        <div class="flex gap-3">
          <button class="btn-secondary" onClick={handleDownloadTemplate}>
            📥 CSV 模板
          </button>
          <button class="btn-secondary" onClick={handleExportXlsxTemplate}>
            📊 XLSX 模板
          </button>
          <button class="btn-secondary" onClick={handleImportXlsx}>
            📂 XLSX 导入
          </button>
          <button class="btn-primary" onClick={() => setShowCreateModal(true)}>
            <span>➕</span> 新建产品集
          </button>
        </div>
      </div>

      <Show when={productSets().length > 0} fallback={
        <EmptyState icon="📦" title="暂无产品集" desc="创建您第一个产品集来开始管理">
          <button class="btn-primary" onClick={() => setShowCreateModal(true)}>新建产品集</button>
        </EmptyState>
      }>
        <Show when={!params.name}>
          <div class="flex flex-col md:flex-row gap-3 mb-4">
            <input
              type="text"
              class="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm"
              placeholder="搜索产品集名称..."
              value={psSearch()}
              onInput={(e) => setPsSearch(e.currentTarget.value)}
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
            <For each={filteredProductSets()}>
              {(ps) => (
                <div
                  class="card p-5 cursor-pointer hover:shadow-card-hover transition-all group relative"
                  onClick={() => navigate(`/product-sets/${encodeURIComponent(ps.name)}`)}
                  onContextMenu={(e) => contextMenu.open(e, ps)}
                >
                  <div class="flex items-start justify-between">
                    <div class="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center text-2xl">
                      📦
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-xs px-2 py-1 rounded-full bg-surface-100 text-surface-500">
                        {ps.image_count} 图 / {ps.cert_count} 证
                      </span>
                      <button
                        class="text-surface-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => handleCardDelete(ps, e)}
                        title="删除产品集"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <h3 class="text-lg font-semibold mt-3 text-surface-900">{ps.name}</h3>
                  <p class="text-sm text-surface-400 mt-1">{ps.created_at}</p>
                  <Show when={ps.tags && ps.tags.length > 0}>
                    <div class="flex flex-wrap gap-1.5 mt-3">
                      <For each={ps.tags}>
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
                  <Show when={ps.notes}>
                    <p class="text-xs text-surface-400 mt-2 line-clamp-2">{ps.notes}</p>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={params.name}>
          <div class="flex items-center gap-2 mb-2 text-sm text-surface-500">
            <button class="hover:text-primary-600" onClick={() => navigate("/product-sets")}>产品集</button>
            <span>/</span>
            <Show when={!editingPs()} fallback={
              <input
                type="text"
                class="px-2 py-1 border border-surface-200 rounded text-sm"
                value={editingPsName()}
                onInput={(e) => setEditingPsName(e.currentTarget.value)}
                onBlur={handleRenameProductSet}
                onKeyDown={(e) => e.key === "Enter" && handleRenameProductSet()}
                autofocus
              />
            }>
              <span
                class="text-surface-900 font-medium cursor-pointer hover:text-primary-600"
                onClick={() => { setEditingPs(true); setEditingPsName(psName() || ""); }}
              >
                {psName()} ✏️
              </span>
            </Show>
          </div>
          <div class="flex items-center justify-between mb-6">
            <div>
              <h1 class="text-2xl font-bold text-surface-900">{psName()}</h1>
              <p class="text-surface-500 mt-1">选择下方入口管理文件</p>
            </div>
            <div class="flex gap-3">
              <button
                class="btn-secondary text-red-600 hover:bg-red-50 hover:border-red-200"
                onClick={handleDeleteProductSet}
              >
                🗑️ 删除产品集
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Image entry card */}
            <div
              class="card p-8 cursor-pointer hover:shadow-card-hover transition-all bg-gradient-to-br from-blue-50 to-white"
              onClick={() => {
                const folders = imageFolders();
                navigate(`/files/image/${encodeURIComponent(psName())}/${folders[0]}`);
              }}
            >
              <div class="flex items-center gap-4">
                <div class="w-16 h-16 rounded-2xl bg-blue-100 flex items-center justify-center text-4xl">🖼️</div>
                <div>
                  <h3 class="text-xl font-bold text-surface-900">图包</h3>
                  <p class="text-sm text-surface-500 mt-1">管理产品图片资源</p>
                </div>
              </div>
              <div class="mt-6 flex gap-3 flex-wrap">
                <For each={imageFolders()}>
                  {(folder) => (
                    <span class="text-xs px-3 py-1.5 rounded-full bg-blue-100 text-blue-700">{folder}</span>
                  )}
                </For>
              </div>
            </div>

            {/* Cert entry card */}
            <div
              class="card p-8 cursor-pointer hover:shadow-card-hover transition-all bg-gradient-to-br from-orange-50 to-white"
              onClick={() => {
                const folders = certFolders();
                navigate(`/files/cert/${encodeURIComponent(psName())}/${folders[0]}`);
              }}
            >
              <div class="flex items-center gap-4">
                <div class="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center text-4xl">📜</div>
                <div>
                  <h3 class="text-xl font-bold text-surface-900">证书</h3>
                  <p class="text-sm text-surface-500 mt-1">管理认证与检测报告</p>
                </div>
              </div>
              <div class="mt-6 flex gap-3 flex-wrap">
                <For each={certFolders()}>
                  {(folder) => (
                    <span class="text-xs px-3 py-1.5 rounded-full bg-orange-100 text-orange-700">{folder}</span>
                  )}
                </For>
              </div>
            </div>
          </div>

          {/* v2.4.7（§5.2）：关联客户只读区块（customers.json 反查 related_product_sets；写操作只在客户侧） */}
          <div class="card p-5">
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-lg font-semibold">关联客户</h2>
              <span class="text-sm text-surface-400">在客户详情页维护关联</span>
            </div>
            <Show when={relatedCustomers().length > 0} fallback={
              <EmptyState icon="🤝" title="暂无关联客户" desc="可在客户详情页的关联产品集区域添加" />
            }>
              <div class="flex flex-wrap gap-2">
                <For each={relatedCustomers()}>
                  {(c) => (
                    <button
                      class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors text-sm"
                      onClick={() => navigate(`/clients/${encodeURIComponent(c.name)}`)}
                      title={`查看客户「${c.name}」`}
                    >
                      <span>🤝</span>
                      <span class="font-medium">{c.name}</span>
                      <Show when={c.file_count > 0}>
                        <span class="text-xs text-emerald-500">{c.file_count} 文件</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      {/* Create Product Set Modal */}
      <Show when={showCreateModal()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden" onClick={() => setShowCreateModal(false)}>
          <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl max-h-[90vh] overflow-y-auto overflow-x-hidden" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">新建产品集</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">产品集名称</label>
              <input
                type="text"
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="如：夏季T恤系列"
                value={newPsName()}
                onInput={(e) => setNewPsName(e.currentTarget.value)}
              />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={newPsTags()}
                onChange={setNewPsTags}
                options={tagList()}
                placeholder="如：客户、重点"
              />
            </div>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
              <textarea
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                rows={3}
                placeholder="添加备注..."
                value={newPsNotes()}
                onInput={(e) => setNewPsNotes(e.currentTarget.value)}
              />
            </div>
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setShowCreateModal(false)}>取消</button>
              <button class="btn-primary" onClick={handleCreate}>确认创建</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Edit Product Set Info Modal */}
      <Show when={editingInfoPs()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-hidden" onClick={() => setEditingInfoPs(null)}>
          <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">编辑产品集信息</h2>
            <div class="mb-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签（建议从已定义标签中选择）</label>
              <TagInput
                value={editTags()}
                onChange={setEditTags}
                options={tagList()}
                placeholder="如：客户、重点"
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
              <button class="btn-secondary" onClick={() => setEditingInfoPs(null)}>取消</button>
              <button class="btn-primary" onClick={handleSaveInfo}>保存</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Context Menu（统一组件，v2.3.x） */}
      <Show when={contextMenu.payload()}>
        {(ps) => (
          <ContextMenu
            x={contextMenu.x()}
            y={contextMenu.y()}
            onClose={contextMenu.close}
            items={[
              {
                label: "编辑信息",
                icon: "✏️",
                action: () => openEditInfo(ps()),
              },
              {
                label: "删除",
                icon: "🗑️",
                danger: true,
                action: () => void handleCardDelete(ps()),
              },
            ]}
          />
        )}
      </Show>
    </div>
  );
}
