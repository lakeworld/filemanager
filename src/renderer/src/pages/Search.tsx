import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace, workspaceConfig, loadWorkspaceConfig, productSets, loadProductSets } from "~/stores/workspace";
import { loadTagDefs, tagList } from "~/stores/tags";
import { openPreview, openFileSmart } from "~/stores/preview";
import { showToast } from "~/stores/notifyBanner";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import MoveDialog from "~/components/MoveDialog";
import ConfirmDialog from "~/components/ConfirmDialog";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { SearchResult, FileEntry, ProductSetInfo, CustomerInfo } from "~/types";
import { buildFileContextMenuItems, productSetFromFilePath } from "~/utils/fileContextMenu";

/** 解析 core formatTime 输出的 "YYYY-MM-DD HH:mm:ss"（本地时间），失败返回 NaN */
function parseModified(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

export default function Search() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = createSignal<string>((searchParams.q as string) || "");
  const [results, setResults] = createSignal<SearchResult>({ files: [], product_sets: [], customers: [] });
  const [loading, setLoading] = createSignal(false);
  const contextMenu = useContextMenu<FileEntry>();
  const [movePaths, setMovePaths] = createSignal<string[] | null>(null);
  // 删除确认弹窗状态（统一确认体系，替代 window.confirm；确认后异步执行删除）
  const [confirmDelete, setConfirmDelete] = createSignal<{ paths: string[] } | null>(null);
  // v2.4.1：搜索结果文件项单击选择 / 双击打开
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  let clickTimer: number | undefined;
  const toggleSelection = (path: string) =>
    setSelectedPaths((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
    }
  });

  const doSearch = async (q: string) => {
    if (!q.trim()) return;
    if (!currentWorkspace()) {
      showToast("info", "请先打开工作区");
      return;
    }
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

  const handleCopy = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.copyFilesToClipboard(paths);
    if (!result.success) {
      showToast("error", "复制失败", result.error ?? undefined);
    }
  };

  const handleShowInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.showFilesInExplorer(paths);
    if (!result.success) {
      showToast("error", "打开文件夹失败", result.error ?? undefined);
    }
  };

  const handleDelete = (paths: string[]) => {
    if (paths.length === 0) return;
    // 打开确认弹窗，确认后由 DeleteConfirm 异步执行删除（保持原语义：确认才删除）
    setConfirmDelete({ paths });
  };

  /** 删除确认弹窗内容（target 由 Show 保证非空）；删除类文案与项目统一：将移入回收站，可在回收站恢复 */
  const DeleteConfirm = (props: { paths: string[]; onDone: () => void }) => {
    return (
      <ConfirmDialog
        title="删除文件"
        message={`确定要删除选中的 ${props.paths.length} 个文件吗？将移入回收站，可在回收站恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          // Solid props 惰性 getter：先取快照再 onDone（同 FileBrowserView 2026-08-15 修复）
          const paths = props.paths;
          props.onDone();
          void (async () => {
            const result = await api.files.delete(paths);
            if (result.success) {
              doSearch(query());
            } else {
              showToast("error", "删除失败", result.error ?? undefined);
            }
          })();
        }}
        onCancel={props.onDone}
      />
    );
  };

  const handleRename = async (file: FileEntry) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      doSearch(query());
    } else {
      showToast("error", "重命名失败", result.error ?? undefined);
    }
  };

  const openFilePreview = (file: FileEntry) => {
    // v2.5.1（F3）：双击分流（other 类型 → 默认应用打开）
    openFileSmart(file, { onDelete: () => doSearch(query()) });
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="mb-6 shrink-0">
        <h1 class="text-2xl font-bold text-surface-900">搜索</h1>
        <p class="text-surface-500 mt-1">搜索产品集和文件</p>
      </div>

      <form onSubmit={handleSubmit} class="mb-6 shrink-0">
        <div class="relative">
          <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <span class="text-surface-400">🔍</span>
          </div>
          <input
            type="text"
            class="w-full pl-10 pr-4 py-3 bg-surface-0 border border-surface-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-colors shadow-sm"
            placeholder="输入关键词搜索..."
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
        </div>
      </form>

      <Show when={loading()}>
        <Loading text="搜索中..." />
      </Show>

      <Show when={!loading() && results().product_sets.length > 0}>
        <div class="mb-6 shrink-0">
          <h2 class="text-lg font-semibold mb-3">产品集 ({results().product_sets.length})</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <For each={results().product_sets}>
              {(ps: ProductSetInfo) => (
                <div class="card p-4 cursor-pointer hover:shadow-card-hover" onClick={() => navigate(`/product-sets/${ps.name}`)}>
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-lg">📦</div>
                    <div>
                      <div class="font-medium">{ps.name}</div>
                      <div class="text-sm text-surface-400">{ps.image_count} 图 / {ps.cert_count} 证 / {ps.doc_count ?? 0} 文</div>
                    </div>
                  </div>
                  {/* v2.4.4（验收修复 T2）：搜索结果产品集卡片展示标签 chips */}
                  <TagChips tags={ps.tags} />
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* v2.4.7：客户实体命中（core/search.ts 产出 customers：客户名/别名/标签命中，含文件命中带出的客户）——
          卡片形态对齐产品集结果卡，点击跳客户详情 */}
      <Show when={!loading() && (results().customers ?? []).length > 0}>
        <div class="mb-6 shrink-0">
          <h2 class="text-lg font-semibold mb-3">客户 ({results().customers?.length ?? 0})</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <For each={results().customers ?? []}>
              {(c: CustomerInfo) => (
                <div class="card p-4 cursor-pointer hover:shadow-card-hover" onClick={() => navigate(`/clients/${encodeURIComponent(c.name)}`)}>
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-lg">🤝</div>
                    <div>
                      <div class="font-medium">{c.name}</div>
                      <div class="text-sm text-surface-400">{c.file_count} 文件</div>
                    </div>
                  </div>
                  <TagChips tags={c.tags} />
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!loading() && results().files.length > 0}>
        {/* v2.4.6：结果文件网格虚拟化——几千命中时 <For> 全量渲染 DOM 爆炸，且每个 FileThumbnail
            挂载即发缩略图 IPC；VirtualGrid 只渲染可见行（自带滚动容器，本节占满剩余高度）。
            卡片结构/单击选中/双击预览/右键交互不变；缩略图框 aspect-square → h-36 固定高
            （VirtualGrid 行高固定，对齐 FileBrowser 卡片规格） */}
        <div class="mb-6 flex-1 min-h-0 flex flex-col">
          <h2 class="text-lg font-semibold mb-3 shrink-0">文件 ({results().files.length})</h2>
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={results().files}
              itemHeight={252}
              columns={{ base: 2, md: 4, lg: 5 }}
              gap={12}
              scrollResetKey={results().files}
              renderItem={(file: FileEntry) => (
                <div
                  class={`card p-3 cursor-pointer hover:shadow-card-hover select-none ${
                    selectedPaths().includes(file.path) ? "border-primary-500 bg-primary-50" : ""
                  }`}
                  onClick={() => {
                    window.clearTimeout(clickTimer);
                    clickTimer = window.setTimeout(() => toggleSelection(file.path), 250);
                  }}
                  onDblClick={() => {
                    window.clearTimeout(clickTimer);
                    openFilePreview(file);
                  }}
                  onContextMenu={(e) => contextMenu.open(e, file)}
                >
                  <div class="h-36 rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden mb-2">
                    <FileThumbnail filePath={file.path} fileType={file.file_type} />
                  </div>
                  <div class="text-sm font-medium truncate">{file.name}</div>
                  {/* v2.4.4（验收修复 T2）：搜索结果文件卡片展示标签 chips */}
                  <TagChips tags={file.tags} />
                </div>
              )}
            />
          </div>
        </div>
      </Show>

      {/* v2.4.9 打磨 M6：未输入 → 空状态引导（可搜索范围 + 可命中示例）。
          可命中范围对齐 core/search.ts 索引：产品集名/客户名/别名/标签/文件名/标签 + 客户、供应商、发票、入库、报价区文件本体；
          供应商名/报价单号不参与匹配，示例不能用它们（审查 P1） */}
      <Show when={!loading() && !query()}>
        <EmptyState
          icon="🔍"
          title="搜索产品集、客户和文件"
          desc="可搜索：产品集名、客户名/别名/标签、文件名/标签，以及客户、供应商、发票、入库、报价区中的文件本体"
        >
          <p class="text-sm text-surface-400">试试搜：夏季T恤 / 客户名 / 产品文件名</p>
        </EmptyState>
      </Show>

      {/* v2.4.9 打磨 M6：零结果（有搜索词但无匹配）→ 「无匹配」提示换词，与未输入引导区分两种文案 */}
      <Show when={!loading() && query() && results().files.length === 0 && results().product_sets.length === 0 && (results().customers ?? []).length === 0}>
        <EmptyState icon="🔍" title={`无匹配：未找到与 "${query()}" 相关的结果`} desc="试试换个关键词——可搜产品集名、客户名或文件名" />
      </Show>

      {/* Context Menu（统一组件，v2.3.x 由 builder 生成） */}
      <Show when={contextMenu.payload()}>
        {(f) => (
          <ContextMenu
            x={contextMenu.x()}
            y={contextMenu.y()}
            onClose={contextMenu.close}
            items={buildFileContextMenuItems({
              file: f(),
              paths: selectedPaths().includes(f().path) ? selectedPaths() : [f().path],
              onPreview: openFilePreview,
              onEditInfo: (file) =>
                openPreview(file, {
                  productSet: productSetFromFilePath(file.path),
                  editMetadata: true,
                  onDelete: () => doSearch(query()),
                }),
              onOpenDefault: (file) => void api.files.openWithDefaultApp(file.path),
              onCopy: handleCopy,
              onShowInExplorer: handleShowInExplorer,
              onMove: (paths) => setMovePaths(paths),
              onRename: handleRename,
              onDelete: handleDelete,
            })}
          />
        )}
      </Show>

      {/* 移动到… 目标选择（v2.3.x；移动后重跑搜索刷新结果） */}
      <Show when={movePaths()}>
        <MoveDialog
          paths={movePaths()!}
          onClose={() => setMovePaths(null)}
          onMoved={() => doSearch(query())}
        />
      </Show>

      {/* 删除确认弹窗（统一确认体系，替代 window.confirm） */}
      <Show when={confirmDelete()}>
        <DeleteConfirm
          paths={confirmDelete()!.paths}
          onDone={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
