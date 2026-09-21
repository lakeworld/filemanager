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
// v2.5.8 D19（B1）：复制反馈统一（成功/失败都出声）
import { copyFilesWithFeedback } from "~/utils/copyAction";
import { useCopyShortcut } from "~/hooks/useCopyShortcut";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import SearchSelect from "~/components/ui/SearchSelect";
import type { SearchSelectOption } from "~/components/ui/SearchSelect";
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
import Input from "~/components/ui/Input";
import SelectionBar from "~/components/ui/SelectionBar";

interface ImageItem extends FileEntry {
  productSet: string;
  subFolder: string;
}

// v2.5.2：聚合加载请求序号——N×M 链期间切工作区/切类型会并发新链，旧链返回必须丢弃
// v2.5.3（T7）D4：模块级（对齐 Certs certLoadSeq 先例）——卸载清理递增后跨挂载延续计数，
// 重新挂载不再从 0 计数：旧实例在途链持有的旧值永远不会与新实例的计数撞号，过期结果必被丢弃
let imageLoadSeq = 0;

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
  const contextMenu = useContextMenu<string[]>();

  const [movePaths, setMovePaths] = createSignal<string[] | null>(null);
  // v2.4.4：批量打标 / 压缩分享·解压 弹窗状态
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [archiveState, setArchiveState] = createSignal<{ token: string; phase: "compress" | "extract" } | null>(null);
  // v2.4.7：删除确认弹窗状态（替代 window.confirm）
  const [confirmDelete, setConfirmDelete] = createSignal<string[] | null>(null);

  // v2.5.8 D19（B1）：复制改走全局 toast，本页这条 2s 内联条（含 setActionMessage/onCleanup）随之下线

  // —— 虚拟滚动由 VirtualGrid 承担：只渲染可见行，滚出即卸载（替代旧 slice+哨兵分批）——
  // 卡片固定行高（图 160px + 文本区），行高常量与卡片 CSS 保持一致
  const ITEM_HEIGHT = 252;

  // v2.5.2：聚合加载请求序号——N×M 链期间切工作区/切类型会并发新链，旧链返回必须丢弃
  // （照 Certs certLoadSeq 先例；切工作区后旧结果覆盖新数据是已修过的高频 bug）
  // 注：序号本体是模块级（D4），此处不再声明，onCleanup 递增同一模块级计数
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例；N×M 聚合链期间置位）
  const [loading, setLoading] = createSignal(true);
  // v2.5.3（T7）：卸载即递增加载代——未完成的 N×M 链在每轮 IPC 返回后校验失效，不再空转/写入
  onCleanup(() => {
    imageLoadSeq++;
  });

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];
  /**
   * v2.5.9（A9 刀1d）：筛选下拉用**跨产品集的盘上并集**（去重 + 名称序）。
   * `imageFolders()` 仍保留：它是"新建产品集时的默认模板"那一份，不再是"这儿有什么"的答案。
   */
  const imageFolderUnion = () => {
    const set = new Set<string>();
    for (const ps of productSets()) for (const e of ps.image_folders ?? []) set.add(e.name);
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
  };

  const loadAllImages = async () => {
    if (!currentWorkspace()) return;
    const seq = ++imageLoadSeq;
    setLoading(true);
    try {
      const result = await api.productSets.list();
      // v2.5.3（P2-9）：首查失败不再静默——toast 提示（空态兜底仍显示，但用户知道为何为空）
      if (!result.success || !result.data) {
        showToast("error", "加载图包失败", result.error || "未知错误");
        return;
      }
      // v2.5.3（T7）：每轮 IPC 返回后校验代际——组件卸载/新链发起后旧链立即退出
      if (seq !== imageLoadSeq) return;

      const all: ImageItem[] = [];
      for (const ps of result.data) {
        // v2.5.9（A9 刀1d）：聚合页**按盘并集**——列某个产品集自己盘上有的图包子文件夹，
        // 不再拿全站那一张模板表去每个集里问一遍（旧行为：表里没登记的目录，文件在这儿永远看不见）。
        for (const sub of (ps.image_folders ?? []).map((e) => e.name)) {
          const fileResult = await api.files.list({
            product_set: ps.name,
            // v2.4.4：视频与图片同居图包目录（file_type 定目录），media_type 定「图片/视频」筛选
            file_type: "image",
            media_type: typeFilter(),
            sub_folder: sub,
          });
          // v2.5.3（T7）：每轮 IPC 返回后校验代际——过期链不再向 all 收集数据
          if (seq !== imageLoadSeq) return;
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

  // v2.5.5：LAN 拉取自动注册图包子文件夹 → 即时刷新面板（可见性反馈；订阅模式照 accountChanged）
  createEffect(() => {
    const unsub = window.qihebox.events.on("share:subfolder-registered", (data) => {
      const info = data as { kind?: string } | null;
      if (!info || info.kind !== "image") return;
      void loadWorkspaceConfig();
      void loadProductSets();
      void loadAllImages();
    });
    onCleanup(unsub);
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

  // v2.5.8 D19（B1）：成功/失败统一走全局 toast（原先成功只点亮本页 2s 内联条，
  // 而内联条挂在 `ui/SelectionBar` 上——右键单选时没有选区条，反馈等于不存在）
  const handleCopy = (paths: string[]): void => {
    void copyFilesWithFeedback(api.files.copyFilesToClipboard, paths);
  };

  // v2.5.8 D19（B2）：本页有选中态 ⇒ Ctrl+C 必须接管（此前只有文件浏览器有，图包库按了没反应）
  useCopyShortcut(selectedPaths, handleCopy);

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
    if (archiveState()) return; // 单任务守卫（同 handleCompress：防重复触发顶掉进行中任务的进度弹窗）
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
        <Input
          type="text"
          class="flex-1 min-w-0"
          placeholder="搜索文件名..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <SearchSelect
          class="min-w-[112px] md:w-32"
          compact
          ariaLabel="类型筛选"
          options={
            [
              { value: "image", label: "图片" },
              { value: "video", label: "视频" },
            ] satisfies readonly SearchSelectOption[]
          }
          value={typeFilter()}
          matchTriggerWidth={false}
          onChange={(v) => {
            setTypeFilter(v as "image" | "video");
            // 类型切换会整体重新加载，标签选项随之变化，重置标签筛选避免组合出空结果
            setTagFilter("");
          }}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="标签筛选"
          options={[
            { value: "", label: "全部标签" },
            ...allTags().map((tag) => ({ value: tag, label: tagLabel(tag) })),
          ]}
          value={tagFilter()}
          placeholder="全部标签"
          matchTriggerWidth={false}
          onChange={setTagFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-44"
          compact
          ariaLabel="产品集筛选"
          options={[
            { value: "", label: "全部产品集" },
            ...productSets().map((ps: ProductSetInfo) => ({ value: ps.name, label: ps.name })),
          ]}
          value={productSetFilter()}
          placeholder="全部产品集"
          matchTriggerWidth={false}
          onChange={setProductSetFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="子文件夹筛选"
          options={[
            { value: "", label: "全部子文件夹" },
            ...imageFolderUnion().map((folder) => ({ value: folder, label: folder })),
          ]}
          value={subFolderFilter()}
          placeholder="全部子文件夹"
          matchTriggerWidth={false}
          onChange={setSubFolderFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-36"
          compact
          ariaLabel="排序方式"
          options={
            [
              { value: "modified", label: "按修改时间" },
              { value: "name", label: "按文件名" },
              { value: "size", label: "按文件大小" },
            ] satisfies readonly SearchSelectOption[]
          }
          value={sortBy()}
          matchTriggerWidth={false}
          onChange={(v) => setSortBy(v as "modified" | "name" | "size")}
        />
      </div>

      {/* v2.5.8 D10（W5）：收进 ui/SelectionBar，动作与文案一字未改 */}
      <SelectionBar
        count={selectedCount()}
        noun="个文件"
        onClear={clearSelection}
        onSelectAll={selectAllVisible}
        onDelete={() => handleDelete(selectedPaths())}
        actions={[
          { label: "📋 复制", tone: "primary", onClick: () => handleCopy(selectedPaths()) },
          { label: "📂 在文件夹中显示", onClick: () => handleShowInExplorer(selectedPaths()) },
          { label: "🏷️ 打标", onClick: () => handleBatchTag(selectedPaths()) },
          { label: "📦 压缩分享", onClick: () => void handleCompress(selectedPaths()) },
          { label: "🗑️ 删除", tone: "danger", onClick: () => handleDelete(selectedPaths()) },
        ]}
      />

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
          <button class="link-btn text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
            全选当前结果
          </button>
        </div>
        <div
          data-selection-bar-pad
          class={`flex-1 min-h-0 ${selectedCount() > 0 ? "pb-24" : ""}`}
        >
          <VirtualGrid
            items={filteredItems()}
            itemHeight={ITEM_HEIGHT}
            columns={{ base: 2, md: 4, lg: 5, xl: 6 }}
            gap={16}
            // v2.5.3（P2-11）：筛选/搜索/类型切换时滚动归零（照 Quotes/Invoices scrollResetKey 先例）
            scrollResetKey={`${typeFilter()}|${search()}|${tagFilter()}|${productSetFilter()}|${subFolderFilter()}|${sortBy()}`}
            renderItem={(img) => (
              <div
                class={`card p-2 cursor-pointer select-none ${selectedPaths().includes(img.path) ? "card-selected" : ""}`}
                draggable={true}
                onDragStart={(e) => handleDragOut(e, img.path, selectedPaths())}
                onContextMenu={(e) => {
                  // v2.4.7：右键——目标未选中时先单选它，菜单作用于「选中集合或该文件」（对齐 FileBrowserView）
                  const paths = selectedPaths().includes(img.path) ? selectedPaths() : [img.path];
                  if (!selectedPaths().includes(img.path)) setSelectedPaths([img.path]);
                  contextMenu.open(e, paths);
                }}
                onClick={() => toggleSelection(img.path)}
                // v2.5.8 D18：带当前可见列表快照（筛选/排序后的 filteredItems）→ 预览内可 ←/→ 连看
                onDblClick={() => openFileSmart(img, { onDelete: loadAllImages, list: filteredItems() })}
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
            // v2.5.8 D18：右键预览同样带上可见列表，与双击口径一致（不传则弹窗没有 ◀▶）
            onPreview: (img) => openPreview(img, { onDelete: loadAllImages, list: filteredItems() }),
            onEditInfo: (img) =>
              openPreview(img, {
                productSet: img.productSet,
                editMetadata: true,
                onDelete: loadAllImages,
                list: filteredItems(),
              }),
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
