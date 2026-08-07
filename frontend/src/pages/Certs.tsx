import { Show, For, createSignal, createEffect, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  productSets,
  loadProductSets,
} from "~/stores/workspace";
import { openPreview } from "~/stores/preview";
import FileThumbnail from "~/components/FileThumbnail";
import type { FileEntry, ProductSetInfo } from "~/types";

interface CertItem extends FileEntry {
  productSet: string;
  subFolder: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function Certs() {
  const navigate = useNavigate();
  const [items, setItems] = createSignal<CertItem[]>([]);
  const [search, setSearch] = createSignal("");
  const [productSetFilter, setProductSetFilter] = createSignal<string>("");
  const [subFolderFilter, setSubFolderFilter] = createSignal<string>("");
  const [sortBy, setSortBy] = createSignal<"modified" | "name" | "size">("modified");
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  const [actionMessage, setActionMessage] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<{
    show: boolean;
    x: number;
    y: number;
    path: string;
  }>({ show: false, x: 0, y: 0, path: "" });

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, show: false }));

  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(""), 2000);
  };

  onMount(() => {
    const onClick = () => closeContextMenu();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  });

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
    }
  });

  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  const loadAllCerts = async () => {
    if (!currentWorkspace()) return;
    const result = await api.productSets.list();
    if (!result.success || !result.data) return;

    const all: CertItem[] = [];
    for (const ps of result.data) {
      for (const sub of certFolders()) {
        const fileResult = await api.files.list({
          product_set: ps.name,
          file_type: "cert",
          sub_folder: sub,
        });
        if (fileResult.success && fileResult.data) {
          for (const f of fileResult.data) {
            all.push({ ...f, productSet: ps.name, subFolder: sub });
          }
        }
      }
    }
    setItems(all);
    setSelectedPaths([]);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadAllCerts();
    }
  });

  const filteredItems = () => {
    const term = search().trim().toLowerCase();
    const ps = productSetFilter();
    const sub = subFolderFilter();
    let list = items().filter((it) => {
      if (ps && it.productSet !== ps) return false;
      if (sub && it.subFolder !== sub) return false;
      if (term && !it.name.toLowerCase().includes(term)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sortBy()) {
        case "name":
          return a.name.localeCompare(b.name);
        case "size":
          return b.size - a.size;
        case "modified":
        default:
          return new Date(b.modified).getTime() - new Date(a.modified).getTime();
      }
    });
    return list;
  };

  const toggleSelection = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const selectAllVisible = () => {
    setSelectedPaths(filteredItems().map((it) => it.path));
  };

  const clearSelection = () => setSelectedPaths([]);

  const handleCopy = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.copyFilesToClipboard(paths);
    if (result.success) {
      showActionMessage(`已复制 ${paths.length} 个文件到剪贴板`);
    } else {
      window.alert(result.error || "复制失败");
    }
  };

  const handleShowInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.showFilesInExplorer(paths);
    if (!result.success) {
      window.alert(result.error || "打开文件夹失败");
    }
  };

  const handleDelete = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!window.confirm(`确定要删除选中的 ${paths.length} 个文件吗？此操作不可恢复。`)) return;
    const result = await api.files.delete(paths);
    if (result.success) {
      setSelectedPaths([]);
      loadAllCerts();
    }
  };

  const handleRename = async (file: CertItem) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      setSelectedPaths([]);
      loadAllCerts();
    } else {
      window.alert(result.error || "重命名失败");
    }
  };

  const selectedCount = () => selectedPaths().length;
  const visibleCount = () => filteredItems().length;

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">证书库</h1>
          <p class="text-surface-500 mt-1">所有证书文件</p>
        </div>
      </div>

      {/* Filters */}
      <div class="flex flex-col md:flex-row gap-3 mb-4">
        <input
          type="text"
          class="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm"
          placeholder="搜索文件名..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={productSetFilter()}
          onChange={(e) => setProductSetFilter(e.currentTarget.value)}
        >
          <option value="">全部产品集</option>
          <For each={productSets()}>
            {(ps: ProductSetInfo) => <option value={ps.name}>{ps.name}</option>}
          </For>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={subFolderFilter()}
          onChange={(e) => setSubFolderFilter(e.currentTarget.value)}
        >
          <option value="">全部子文件夹</option>
          <For each={certFolders()}>
            {(folder) => <option value={folder}>{folder}</option>}
          </For>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={sortBy()}
          onChange={(e) => setSortBy(e.currentTarget.value as any)}
        >
          <option value="modified">按修改时间</option>
          <option value="name">按文件名</option>
          <option value="size">按文件大小</option>
        </select>
      </div>

      <Show when={selectedCount() > 0}>
        <div class="flex items-center justify-between mb-4 p-3 bg-primary-50 border border-primary-100 rounded-xl">
          <div class="flex flex-col gap-1">
            <span class="text-sm text-primary-700">已选择 {selectedCount()} 个文件</span>
            <Show when={actionMessage()}>
              <span class="text-xs text-primary-600">{actionMessage()}</span>
            </Show>
          </div>
          <div class="flex gap-2">
            <button class="px-3 py-1.5 text-sm text-surface-600 hover:bg-white rounded-lg" onClick={clearSelection}>
              取消选择
            </button>
            <button class="px-3 py-1.5 text-sm text-white bg-primary-500 hover:bg-primary-600 rounded-lg" onClick={() => handleCopy(selectedPaths())}>
              📋 复制
            </button>
            <button class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg" onClick={() => handleShowInExplorer(selectedPaths())}>
              📂 在文件夹中显示
            </button>
            <button class="px-3 py-1.5 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg" onClick={() => handleDelete(selectedPaths())}>
              🗑️ 删除
            </button>
          </div>
        </div>
      </Show>

      <Show when={visibleCount() > 0} fallback={
        <div class="card p-12 text-center">
          <div class="text-4xl mb-3">📜</div>
          <h3 class="text-lg font-medium text-surface-700">暂无证书</h3>
          <p class="text-sm text-surface-400 mt-1">导入证书到产品集中</p>
        </div>
      }>
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm text-surface-500">{visibleCount()} 个文件</span>
          <button class="text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
            全选当前结果
          </button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <For each={filteredItems()}>
            {(cert) => (
              <div
                class={`card p-4 flex items-center gap-4 cursor-pointer select-none hover:shadow-card-hover transition-all ${selectedPaths().includes(cert.path) ? "border-primary-500 bg-primary-50" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ show: true, x: e.clientX, y: e.clientY, path: cert.path });
                }}
                onClick={() => openPreview(cert, { onDelete: loadAllCerts })}
              >
                <div class="w-12 h-12 rounded-lg bg-orange-50 flex items-center justify-center text-2xl overflow-hidden shrink-0">
                  <FileThumbnail path={cert.thumbnail_path} fileType={cert.file_type} class="w-full h-full object-cover" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{cert.name}</div>
                  <div class="text-xs text-surface-400 mt-1">{cert.productSet} / {cert.subFolder}</div>
                  <div class="text-xs text-surface-400">{formatBytes(cert.size)} · {cert.modified}</div>
                </div>
                <input
                  type="checkbox"
                  class="w-4 h-4 accent-primary-600 cursor-pointer shrink-0"
                  checked={selectedPaths().includes(cert.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelection(cert.path)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Context Menu */}
      <Show when={contextMenu().show}>
        <div
          class="fixed z-50 bg-white shadow-lg rounded-lg border border-surface-200 py-1 min-w-[160px]"
          style={{ left: `${contextMenu().x}px`, top: `${contextMenu().y}px` }}
        >
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const cert = items().find((c) => c.path === contextMenu().path);
              if (cert) openPreview(cert, { onDelete: loadAllCerts });
              closeContextMenu();
            }}
          >
            👁️ 预览
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              handleCopy([contextMenu().path]);
              closeContextMenu();
            }}
          >
            📋 复制
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              handleShowInExplorer([contextMenu().path]);
              closeContextMenu();
            }}
          >
            📂 在文件夹中显示
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const cert = items().find((c) => c.path === contextMenu().path);
              if (cert) handleRename(cert);
              closeContextMenu();
            }}
          >
            ✏️ 重命名
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              handleDelete([contextMenu().path]);
              closeContextMenu();
            }}
          >
            🗑️ 删除
          </button>
        </div>
      </Show>
    </div>
  );
}
