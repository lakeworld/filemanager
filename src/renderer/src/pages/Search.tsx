import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace, workspaceConfig, loadWorkspaceConfig, productSets, loadProductSets } from "~/stores/workspace";
import { requireLogin } from "~/stores/account";
import { FEATURE_AI } from "~/features";
import { loadTagDefs, tagList } from "~/stores/tags";
import { openPreview } from "~/stores/preview";
import FileThumbnail from "~/components/FileThumbnail";
import ContextMenu from "~/components/ContextMenu";
import type { SearchResult, FileEntry, ProductSetInfo, AiSearchResult } from "~/types";

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
  const [aiSearching, setAiSearching] = createSignal(false);
  const [aiTranslation, setAiTranslation] = createSignal("");

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
      // 防抖：连续输入只触发最后一次搜索
      const t = setTimeout(() => doSearch(q), 300);
      onCleanup(() => clearTimeout(t));
    }
  });

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const q = query();
    if (q && typeof q === "string") {
      doSearch(q);
    }
  };

  // —— v2.2.0：AI 语义搜索（自然语言 → 关键词组合 + 过滤）——
  const handleAiSearch = async () => {
    if (!requireLogin()) return;
    const q = query().trim();
    if (!q) return;
    setAiSearching(true);
    setAiTranslation("");
    try {
      await Promise.all([loadProductSets(), loadTagDefs()]);
      const r = await api.ai.call("search", {
        query: q,
        index: {
          product_sets: productSets().map((p) => p.name),
          tags: tagList().map((t) => t.name),
          types: ["image", "pdf", "cert"],
        },
      });
      if (!r.success || !r.data) {
        window.alert(r.error || "AI 搜索失败，请稍后重试");
        return;
      }
      const sr = r.data as AiSearchResult;
      const keywords = (sr.keywords ?? []).filter((k) => k.trim());
      if (keywords.length === 0) {
        window.alert("AI 未能理解查询，请换一种说法");
        return;
      }
      // 逐关键词本地搜索并合并去重
      const mergedFiles = new Map<string, FileEntry>();
      const mergedSets = new Map<string, ProductSetInfo>();
      for (const kw of keywords) {
        const res = await api.search(kw);
        if (res.success && res.data) {
          for (const f of res.data.files) mergedFiles.set(f.path, f);
          for (const s of res.data.product_sets) mergedSets.set(s.name, s);
        }
      }
      // 应用 filters
      let files = [...mergedFiles.values()];
      if (sr.filters?.type) {
        files = files.filter((f) => f.file_type === sr.filters.type);
      }
      if (sr.filters?.product_set) {
        files = files.filter((f) => f.path.includes(sr.filters!.product_set!));
      }
      setResults({ files, product_sets: [...mergedSets.values()] });
      const cond = [
        keywords.join("、"),
        sr.filters?.type ? `类型=${sr.filters.type}` : "",
        sr.filters?.recent_days ? `近${sr.filters.recent_days}天` : "",
        sr.filters?.product_set ? `产品集=${sr.filters.product_set}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      setAiTranslation(`AI 翻译：「${q}」→ ${cond}`);
    } finally {
      setAiSearching(false);
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
            placeholder="输入关键词搜索，或用 AI 自然语言查找..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div class="flex items-center gap-2 mt-2">
          <button
            type="submit"
            class="btn-primary px-4 py-1.5 text-sm"
          >
            搜索
          </button>
          <Show when={FEATURE_AI}>
            <button
              type="button"
              class="px-4 py-1.5 text-sm rounded-lg bg-primary-50 text-primary-700 border border-primary-200 hover:bg-primary-100 transition-colors"
              onClick={() => void handleAiSearch()}
              disabled={aiSearching()}
            >
              {aiSearching() ? "AI 理解中..." : "🤖 AI 搜索"}
            </button>
          </Show>
          <Show when={aiTranslation()}>
            <span class="text-xs text-primary-600 truncate">{aiTranslation()}</span>
          </Show>
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
                    <FileThumbnail filePath={file.path} fileType={file.file_type} />
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
        <ContextMenu
          x={contextMenu().x}
          y={contextMenu().y}
          onClose={closeContextMenu}
          items={[
            {
              label: "预览",
              icon: "👁️",
              action: () => {
                const f = contextMenu().file;
                if (f) openFilePreview(f);
              },
            },
            {
              label: "用默认程序打开",
              icon: "🖥️",
              action: () => {
                const f = contextMenu().file;
                if (f) void api.files.openWithDefaultApp(f.path);
              },
            },
            {
              label: "复制",
              icon: "📋",
              action: () => {
                const f = contextMenu().file;
                if (f) handleCopy([f.path]);
              },
            },
            {
              label: "复制路径",
              icon: "🔗",
              action: () => {
                const f = contextMenu().file;
                if (f) void api.files.copyPaths([f.path]);
              },
            },
            {
              label: "在文件夹中显示",
              icon: "📂",
              action: () => {
                const f = contextMenu().file;
                if (f) handleShowInExplorer([f.path]);
              },
            },
            {
              label: "重命名",
              icon: "✏️",
              action: () => {
                const f = contextMenu().file;
                if (f) handleRename(f);
              },
            },
            {
              label: "删除",
              icon: "🗑️",
              danger: true,
              action: () => {
                const f = contextMenu().file;
                if (f) handleDelete([f.path]);
              },
            },
          ]}
        />
      </Show>
    </div>
  );
}
