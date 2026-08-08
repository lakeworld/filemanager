import { Show, For, createSignal, createEffect, onMount } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace, workspaceConfig, loadWorkspaceConfig } from "~/stores/workspace";
import { openPreview } from "~/stores/preview";
import FileThumbnail from "~/components/FileThumbnail";
import type { SearchResult, FileEntry, ProductSetInfo } from "~/types";

export default function Search() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = createSignal<string>((searchParams.q as string) || "");
  const [results, setResults] = createSignal<SearchResult>({ files: [], product_sets: [] });
  const [loading, setLoading] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<{
    show: boolean;
    x: number;
    y: number;
    file: FileEntry | null;
  }>({ show: false, x: 0, y: 0, file: null });

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, show: false }));

  onMount(() => {
    const onClick = () => closeContextMenu();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  });

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
    }
  });

  const doSearch = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    const result = await api.search(q);
    if (result.success && result.data) {
      setResults(result.data);
    }
    setLoading(false);
  };

  createEffect(() => {
    const q = searchParams.q;
    if (q && typeof q === "string") {
      setQuery(q);
      doSearch(q);
    }
  });

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const q = query();
    if (q && typeof q === "string") {
      doSearch(q);
    }
  };

  const handleCopy = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.copyFilesToClipboard(paths);
    if (!result.success) {
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
      doSearch(query());
    }
  };

  const handleRename = async (file: FileEntry) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      doSearch(query());
    } else {
      window.alert(result.error || "重命名失败");
    }
  };

  const openFilePreview = (file: FileEntry) => {
    openPreview(file, { onDelete: () => doSearch(query()) });
  };

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-surface-900">搜索</h1>
        <p class="text-surface-500 mt-1">搜索产品集和文件</p>
      </div>

      <form onSubmit={handleSubmit} class="mb-6">
        <div class="relative">
          <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <span class="text-surface-400">🔍</span>
          </div>
          <input
            type="text"
            class="w-full pl-10 pr-4 py-3 bg-surface-0 border border-surface-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all shadow-sm"
            placeholder="输入关键词搜索..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </form>

      <Show when={loading()}>
        <div class="text-center py-12 text-surface-400">搜索中...</div>
      </Show>

      <Show when={!loading() && results().product_sets.length > 0}>
        <div class="mb-6">
          <h2 class="text-lg font-semibold mb-3">产品集 ({results().product_sets.length})</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <For each={results().product_sets}>
              {(ps: ProductSetInfo) => (
                <div class="card p-4 cursor-pointer hover:shadow-card-hover" onClick={() => navigate(`/product-sets/${ps.name}`)}>
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-lg">📦</div>
                    <div>
                      <div class="font-medium">{ps.name}</div>
                      <div class="text-sm text-surface-400">{ps.image_count} 图 / {ps.cert_count} 证</div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!loading() && results().files.length > 0}>
        <div class="mb-6">
          <h2 class="text-lg font-semibold mb-3">文件 ({results().files.length})</h2>
          <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <For each={results().files}>
              {(file: FileEntry) => (
                <div
                  class="card p-3 cursor-pointer hover:shadow-card-hover transition-all"
                  onClick={() => openFilePreview(file)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ show: true, x: e.clientX, y: e.clientY, file });
                  }}
                >
                  <div class="aspect-square rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden mb-2">
                    <FileThumbnail path={file.thumbnail_path} fileType={file.file_type} />
                  </div>
                  <div class="text-sm font-medium truncate">{file.name}</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!loading() && query() && results().files.length === 0 && results().product_sets.length === 0}>
        <div class="text-center py-12 text-surface-400">
          <div class="text-4xl mb-3">🔍</div>
          <p>未找到与 "{query()}" 相关的结果</p>
        </div>
      </Show>

      {/* Context Menu */}
      <Show when={contextMenu().show && contextMenu().file}>
        <div
          class="fixed z-50 bg-white shadow-lg rounded-lg border border-surface-200 py-1 min-w-[160px]"
          style={{ left: `${contextMenu().x}px`, top: `${contextMenu().y}px` }}
        >
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const f = contextMenu().file;
              if (f) openFilePreview(f);
              closeContextMenu();
            }}
          >
            👁️ 预览
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const f = contextMenu().file;
              if (f) handleCopy([f.path]);
              closeContextMenu();
            }}
          >
            📋 复制
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const f = contextMenu().file;
              if (f) handleShowInExplorer([f.path]);
              closeContextMenu();
            }}
          >
            📂 在文件夹中显示
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
            onClick={() => {
              const f = contextMenu().file;
              if (f) handleRename(f);
              closeContextMenu();
            }}
          >
            ✏️ 重命名
          </button>
          <button
            class="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            onClick={() => {
              const f = contextMenu().file;
              if (f) handleDelete([f.path]);
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
