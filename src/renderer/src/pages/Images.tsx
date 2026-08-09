import { Show, For, createSignal, createEffect } from "solid-js";
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
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import MoveDialog from "~/components/MoveDialog";
import EmptyState from "~/components/EmptyState";
import type { FileEntry, ProductSetInfo } from "~/types";
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";

interface ImageItem extends FileEntry {
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

export default function Images() {
  const navigate = useNavigate();
  const [items, setItems] = createSignal<ImageItem[]>([]);
  const [search, setSearch] = createSignal("");
  const [productSetFilter, setProductSetFilter] = createSignal<string>("");
  const [subFolderFilter, setSubFolderFilter] = createSignal<string>("");
  const [sortBy, setSortBy] = createSignal<"modified" | "name" | "size">("modified");
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  const [actionMessage, setActionMessage] = createSignal("");
  const contextMenu = useContextMenu<string>();
  const [movePaths, setMovePaths] = createSignal<string[] | null>(null);

  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(""), 2000);
  };

  // —— 虚拟滚动由 VirtualGrid 承担：只渲染可见行，滚出即卸载（替代旧 slice+哨兵分批）——
  // 卡片固定行高（图 160px + 文本区），行高常量与卡片 CSS 保持一致
  const ITEM_HEIGHT = 252;

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];

  const loadAllImages = async () => {
    if (!currentWorkspace()) return;
    const result = await api.productSets.list();
    if (!result.success || !result.data) return;

    const all: ImageItem[] = [];
    for (const ps of result.data) {
      for (const sub of imageFolders()) {
        const fileResult = await api.files.list({
          product_set: ps.name,
          file_type: "image",
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
      loadAllImages();
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
      loadAllImages();
    } else {
      window.alert(result.error || "删除失败");
    }
  };

  const handleRename = async (file: ImageItem) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      setSelectedPaths([]);
      loadAllImages();
    } else {
      window.alert(result.error || "重命名失败");
    }
  };

  const selectedCount = () => selectedPaths().length;
  const visibleCount = () => filteredItems().length;

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">图包库</h1>
          <p class="text-surface-500 mt-1">所有图片资源</p>
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
          <For each={imageFolders()}>
            {(folder) => <option value={folder}>{folder}</option>}
          </For>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={sortBy()}
          onChange={(e) => setSortBy(e.currentTarget.value as "modified" | "name" | "size")}
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
        <EmptyState icon="🖼️" title="暂无图片" desc="导入图片到产品集中" />
      }>
        <div class="flex items-center justify-between mb-3 shrink-0">
          <span class="text-sm text-surface-500">{visibleCount()} 个文件</span>
          <button class="text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
            全选当前结果
          </button>
        </div>
        <div class="flex-1 min-h-0">
          <VirtualGrid
            items={filteredItems()}
            itemHeight={ITEM_HEIGHT}
            columns={{ base: 2, md: 4, lg: 5, xl: 6 }}
            gap={16}
            renderItem={(img) => (
              <div
                class={`card p-2 cursor-pointer select-none hover:shadow-card-hover transition-all ${selectedPaths().includes(img.path) ? "border-primary-500 bg-primary-50" : ""}`}
                draggable={true}
                onDragStart={(e) => handleDragOut(e, img.path, selectedPaths())}
                onContextMenu={(e) => contextMenu.open(e, img.path)}
                onClick={() => openPreview(img, { onDelete: loadAllImages })}
              >
                <div class="relative h-40 rounded-lg bg-surface-100 overflow-hidden">
                  <input
                    type="checkbox"
                    class="absolute top-2 left-2 w-4 h-4 accent-primary-600 cursor-pointer z-10"
                    checked={selectedPaths().includes(img.path)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelection(img.path)}
                  />
                  <FileThumbnail filePath={img.path} fileType={img.file_type} />
                </div>
                <div class="text-xs font-medium truncate mt-2 px-1">{img.name}</div>
                <div class="text-[10px] text-surface-400 px-1 truncate">{img.productSet} / {img.subFolder}</div>
                <div class="text-[10px] text-surface-400 px-1">{formatBytes(img.size)}</div>
              </div>
            )}
          />
        </div>
      </Show>

      {/* Context Menu（统一组件，v2.3.x 由 builder 生成） */}
      <Show when={contextMenu.show()}>
        <ContextMenu
          x={contextMenu.x()}
          y={contextMenu.y()}
          onClose={contextMenu.close}
          items={buildFileContextMenuItems({
            file: items().find((i) => i.path === contextMenu.payload()),
            paths: contextMenu.payload() ? [contextMenu.payload()!] : [],
            onPreview: (img) => openPreview(img, { onDelete: loadAllImages }),
            onEditInfo: (img) =>
              openPreview(img, { productSet: img.productSet, editMetadata: true, onDelete: loadAllImages }),
            onOpenDefault: (img) => void api.files.openWithDefaultApp(img.path),
            onCopy: handleCopy,
            onShowInExplorer: handleShowInExplorer,
            onMove: (paths) => setMovePaths(paths),
            onRename: handleRename,
            onDelete: handleDelete,
          })}
        />
      </Show>

      {/* 移动到… 目标选择（v2.3.x） */}
      <Show when={movePaths()}>
        <MoveDialog
          paths={movePaths()!}
          onClose={() => setMovePaths(null)}
          onMoved={() => void loadAllImages()}
        />
      </Show>
    </div>
  );
}
