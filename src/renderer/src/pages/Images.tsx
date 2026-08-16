import { Show, For, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  productSets,
  loadProductSets,
} from "~/stores/workspace";
import { openPreview, openFileSmart } from "~/stores/preview";
import { tagLabel } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import MoveDialog from "~/components/MoveDialog";
import BatchTagDialog from "~/components/BatchTagDialog";
import ArchiveProgressDialog from "~/components/ArchiveProgressDialog";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import RenameDialog from "~/components/RenameDialog";
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
  // v2.4.4：类型筛选（图片/视频，默认图片）——加载时按当前类型聚合
  const [typeFilter, setTypeFilter] = createSignal<"image" | "video">("image");
  // v2.4.4：标签筛选（渲染侧过滤，选项来自当前 items 实际出现的标签）
  const [tagFilter, setTagFilter] = createSignal("");
  const [productSetFilter, setProductSetFilter] = createSignal<string>("");
  const [subFolderFilter, setSubFolderFilter] = createSignal<string>("");
  const [sortBy, setSortBy] = createSignal<"modified" | "name" | "size">("modified");
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  const [actionMessage, setActionMessage] = createSignal("");
  const contextMenu = useContextMenu<string[]>();

  const [movePaths, setMovePaths] = createSignal<string[] | null>(null);
  // v2.4.4：批量打标 / 压缩分享·解压 弹窗状态
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [archiveState, setArchiveState] = createSignal<{ token: string; phase: "compress" | "extract" } | null>(null);
  // v2.4.7：删除确认弹窗状态（替代 window.confirm）
  const [confirmDelete, setConfirmDelete] = createSignal<string[] | null>(null);

  // v2.4.7（PERF-SOP §四）：setTimeout 存句柄 + onCleanup 清理——防卸载后 setActionMessage 触碰已销毁组件
  let actionMessageTimer: number | undefined;
  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    window.clearTimeout(actionMessageTimer);
    actionMessageTimer = window.setTimeout(() => setActionMessage(""), 2000);
  };

  onCleanup(() => window.clearTimeout(actionMessageTimer));

  // —— 虚拟滚动由 VirtualGrid 承担：只渲染可见行，滚出即卸载（替代旧 slice+哨兵分批）——
  // 卡片固定行高（图 160px + 文本区），行高常量与卡片 CSS 保持一致
  const ITEM_HEIGHT = 252;

  // v2.5.2：聚合加载请求序号——N×M 链期间切工作区/切类型会并发新链，旧链返回必须丢弃
  // （照 Certs certLoadSeq 先例：切工作区后旧结果覆盖新数据是已修过的高频 bug）
  let imageLoadSeq = 0;
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例；N×M 聚合链期间置位）
  const [loading, setLoading] = createSignal(true);

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];

  const loadAllImages = async () => {
    if (!currentWorkspace()) return;
    const seq = ++imageLoadSeq;
    setLoading(true);
    try {
      const result = await api.productSets.list();
      if (!result.success || !result.data) return;

      const all: ImageItem[] = [];
      for (const ps of result.data) {
        for (const sub of imageFolders()) {
          const fileResult = await api.files.list({
            product_set: ps.name,
            // v2.4.4：视频与图片同居图包目录（file_type 定目录），media_type 定「图片/视频」筛选
            file_type: "image",
            media_type: typeFilter(),
            sub_folder: sub,
          });
          if (fileResult.success && fileResult.data) {
            for (const f of fileResult.data) {
              all.push({ ...f, productSet: ps.name, subFolder: sub });
            }
          }
        }
      }
      // v2.5.2：过期链（期间发起了新加载）直接丢弃，防止旧工作区数据覆盖新数据
      if (seq !== imageLoadSeq) return;
      setItems(all);
      setSelectedPaths([]);
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (seq === imageLoadSeq) setLoading(false);
    }
  };

  createEffect(() => {
    // v2.4.4：显式依赖 typeFilter——loadAllImages 在 await 之后才读取它，Solid 不会自动追踪，
    // 必须在此建立依赖，切换图片/视频时才重新加载
    void typeFilter();
    if (currentWorkspace()) {
      loadAllImages();
    }
  });

  // v2.4.4：标签筛选下拉选项——当前 items（按类型加载后）实际出现的全部标签，去重排序
  const allTags = () => {
    const set = new Set<string>();
    for (const it of items()) {
      for (const t of it.tags ?? []) set.add(t);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  };

  // v2.4.6：path→修改时间戳 预解析 Map——仅 items 变化时重算一次，
  // 排序比较器查 Map 比数字，避免每对元素都 new Date()（万级条目一次排序 10 万+ 次 Date 解析）
  const modifiedTs = createMemo(() => {
    const map = new Map<string, number>();
    for (const it of items()) map.set(it.path, new Date(it.modified).getTime());
    return map;
  });

  // v2.4.6：filteredItems 包成 createMemo——visibleCount / 全选 / VirtualGrid 共享一次筛选+排序结果，
  // 不再每处调用都重排；排序规则（字段/方向）不变
  const filteredItems = createMemo(() => {
    const term = search().trim().toLowerCase();
    const ps = productSetFilter();
    const sub = subFolderFilter();
    const tag = tagFilter();
    const ts = modifiedTs();
    let list = items().filter((it) => {
      if (ps && it.productSet !== ps) return false;
      if (sub && it.subFolder !== sub) return false;
      if (tag && !(it.tags ?? []).includes(tag)) return false;
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
          return (ts.get(b.path) ?? 0) - (ts.get(a.path) ?? 0);
      }
    });
    return list;
  });

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
      showToast("error", "复制失败", result.error || "未知错误");
    }
  };

  const handleShowInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.showFilesInExplorer(paths);
    if (!result.success) {
      showToast("error", "打开文件夹失败", result.error || "未知错误");
    }
  };

  const handleDelete = (paths: string[]) => {
    if (paths.length === 0) return;
    setConfirmDelete(paths);
  };

  /** 确认后的删除执行 */
  const doDelete = async (paths: string[]) => {
    const result = await api.files.delete(paths);
    if (result.success) {
      setSelectedPaths([]);
      loadAllImages();
    } else {
      showToast("error", "删除失败", result.error || "未知错误");
    }
  };

  // v2.5.2：单文件重命名弹窗（替代 window.prompt；服务端校验错误回传展示）
  const [renameTarget, setRenameTarget] = createSignal<ImageItem | null>(null);
  const [renameError, setRenameError] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  const handleRename = (file: ImageItem) => {
    setRenameError("");
    setRenameTarget(file);
  };

  const doRename = async (newName: string) => {
    const file = renameTarget();
    if (!file) return;
    setRenameBusy(true);
    try {
      const result = await api.files.rename({ path: file.path, newName });
      if (result.success) {
        setRenameTarget(null);
        setSelectedPaths([]);
        loadAllImages();
      } else {
        setRenameError(result.error || "未知错误");
      }
    } finally {
      setRenameBusy(false);
    }
  };

  const selectedCount = () => selectedPaths().length;
  const visibleCount = () => filteredItems().length;

  // —— v2.4.4：批量打标 / 压缩分享·解压 ——

  /** 选中路径在已加载 items 上的标签交集（无 tags 或缺标签的文件视为空集） */
  const commonTagsOf = (paths: string[]) => {
    const byPath = new Map(items().map((f) => [f.path, f]));
    const lists = paths.map((p) => byPath.get(p)?.tags ?? []);
    if (lists.length === 0) return [];
    return lists[0].filter((t) => lists.every((l) => l.includes(t)));
  };

  /** 归档任务取消令牌：crypto.randomUUID 兜底时间戳+随机 */
  const newArchiveToken = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const handleBatchTag = (paths: string[]) => {
    setBatchTagState({ paths, commonTags: commonTagsOf(paths) });
  };

  const handleCompress = async (paths: string[]) => {
    if (archiveState()) return; // 单任务守卫（评审 P2：防重复触发顶掉进行中任务的进度弹窗，与 Certs.tsx 一致）
    const token = newArchiveToken();
    setArchiveState({ token, phase: "compress" });
    const r = await api.archive.compress({ paths, cancelToken: token });
    // 主进程异步执行（进度/结果走事件），此处失败仅作防御性收口
    if (!r.success) {
      setArchiveState(null);
      showToast("error", "压缩失败", r.error || "未知错误");
    }
  };

  const handleExtract = async (file: ImageItem, mode: "here" | "folder") => {
    const token = newArchiveToken();
    setArchiveState({ token, phase: "extract" });
    const r = await api.archive.extract({ zipPath: file.path, mode, cancelToken: token });
    if (!r.success) {
      setArchiveState(null);
      showToast("error", "解压失败", r.error || "未知错误");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">图包库</h1>
          <p class="text-surface-500 mt-1">{typeFilter() === "video" ? "所有视频资源" : "所有图片资源"}</p>
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
          value={typeFilter()}
          onChange={(e) => {
            setTypeFilter(e.currentTarget.value as "image" | "video");
            // 类型切换会整体重新加载，标签选项随之变化，重置标签筛选避免组合出空结果
            setTagFilter("");
          }}
        >
          <option value="image">图片</option>
          <option value="video">视频</option>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={tagFilter()}
          onChange={(e) => setTagFilter(e.currentTarget.value)}
        >
          <option value="">全部标签</option>
          <For each={allTags()}>
            {(tag) => <option value={tag}>{tagLabel(tag)}</option>}
          </For>
        </select>
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
            <button class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg" onClick={() => handleBatchTag(selectedPaths())}>
              🏷️ 打标
            </button>
            <button class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg" onClick={() => void handleCompress(selectedPaths())}>
              📦 压缩分享
            </button>
            <button class="px-3 py-1.5 text-sm text-white bg-danger-500 hover:bg-danger-600 rounded-lg" onClick={() => handleDelete(selectedPaths())}>
              🗑️ 删除
            </button>
          </div>
        </div>
      </Show>

      <Show when={visibleCount() > 0} fallback={
        // v2.5.2：首载 loading 兜底，空态不闪现
        <Show when={!loading()} fallback={<Loading text={typeFilter() === "video" ? "视频加载中…" : "图片加载中…"} />}>
          <EmptyState
            icon={typeFilter() === "video" ? "🎬" : "🖼️"}
            title={typeFilter() === "video" ? "暂无视频" : "暂无图片"}
            desc={typeFilter() === "video" ? "导入视频到图包子文件夹中" : "导入图片到产品集中"}
          />
        </Show>
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
                class={`card p-2 cursor-pointer select-none hover:shadow-card-hover ${selectedPaths().includes(img.path) ? "border-primary-500 bg-primary-50" : ""}`}
                draggable={true}
                onDragStart={(e) => handleDragOut(e, img.path, selectedPaths())}
                onContextMenu={(e) => {
                  // v2.4.7：右键——目标未选中时先单选它，菜单作用于「选中集合或该文件」（对齐 FileBrowserView）
                  const paths = selectedPaths().includes(img.path) ? selectedPaths() : [img.path];
                  if (!selectedPaths().includes(img.path)) setSelectedPaths([img.path]);
                  contextMenu.open(e, paths);
                }}
                onClick={() => toggleSelection(img.path)}
                onDblClick={() => openFileSmart(img, { onDelete: loadAllImages })}
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
                {/* v2.4.4：卡片标签 chips（最多 2 个，超出 +N） */}
                <TagChips tags={img.tags} />
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
            file: items().find((i) => i.path === contextMenu.payload()?.[0]),
            paths: contextMenu.payload() ?? [],
            onPreview: (img) => openPreview(img, { onDelete: loadAllImages }),
            onEditInfo: (img) =>
              openPreview(img, { productSet: img.productSet, editMetadata: true, onDelete: loadAllImages }),
            onOpenDefault: (img) => void api.files.openWithDefaultApp(img.path),
            onCopy: handleCopy,
            onShowInExplorer: handleShowInExplorer,
            onMove: (paths) => setMovePaths(paths),
            onRename: handleRename,
            onBatchTag: (paths) => handleBatchTag(paths),
            onCompress: (paths) => void handleCompress(paths),
            onExtract: (file, mode) => void handleExtract(file, mode),
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

      {/* 批量打标（v2.4.4） */}
      <Show when={batchTagState()}>
        <BatchTagDialog
          paths={batchTagState()!.paths}
          commonTags={batchTagState()!.commonTags}
          onClose={() => setBatchTagState(null)}
          onDone={() => {
            void loadAllImages();
            setSelectedPaths([]);
          }}
        />
      </Show>

      {/* 压缩分享 / 解压 进度（v2.4.4） */}
      <Show when={archiveState()}>
        <ArchiveProgressDialog token={archiveState()!.token} onClose={() => setArchiveState(null)} />
      </Show>

      {/* 单文件重命名（v2.5.2：替代 window.prompt；服务端校验错误回传展示） */}
      <Show when={renameTarget()}>
        <RenameDialog
          currentName={renameTarget()!.name}
          busy={renameBusy()}
          error={renameError()}
          onConfirm={(n) => void doRename(n)}
          onCancel={() => setRenameTarget(null)}
        />
      </Show>

      {/* 删除确认弹窗（v2.4.7 替代 window.confirm） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除文件"
          message={`确定删除选中的 ${confirmDelete()!.length} 个文件吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const paths = confirmDelete()!;
            setConfirmDelete(null);
            void doDelete(paths);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
