import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { workspaceConfig, loadWorkspaceConfig, currentWorkspace, fileBrowserRefreshTrigger } from "~/stores/workspace";
import { openPreview } from "~/stores/preview";
import { requireLogin } from "~/stores/account";
import { showToast } from "~/stores/notifyBanner";
import { FEATURE_AI } from "~/features";
import { loadTagDefs, tagLabel, tagList } from "~/stores/tags";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import MoveDialog from "~/components/MoveDialog";
import BatchRenameDialog from "~/components/BatchRenameDialog";
import BatchTagDialog from "~/components/BatchTagDialog";
import ArchiveProgressDialog from "~/components/ArchiveProgressDialog";
import EmptyState from "~/components/EmptyState";
import AiSuggestionPanel, { AiPanelItem } from "~/components/AiSuggestionPanel";
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { FileEntry } from "~/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function FileBrowser() {
  const params = useParams();
  const navigate = useNavigate();
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [showNewFolder, setShowNewFolder] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  const [selectedFilePaths, setSelectedFilePaths] = createSignal<string[]>([]);
  // v2.4.4（T3）：标签筛选——渲染侧过滤，计数/全选作用于过滤结果，loadFiles 与选中/预览/右键行为零改动
  const [tagFilter, setTagFilter] = createSignal("");
  const filteredFiles = () => {
    const sel = tagFilter();
    return sel ? files().filter((f) => f.tags?.includes(sel)) : files();
  };
  const contextMenu = useContextMenu<string[]>();
  const [showMove, setShowMove] = createSignal(false);
  // v2.3.3（P2）：批量重命名对话框（多选）
  const [showBatchRename, setShowBatchRename] = createSignal(false);
  const [batchRenameFiles, setBatchRenameFiles] = createSignal<FileEntry[]>([]);
  // v2.4.4：批量打标 / 压缩分享·解压 弹窗状态
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [archiveState, setArchiveState] = createSignal<{ token: string; phase: "compress" | "extract" } | null>(null);
  const [actionMessage, setActionMessage] = createSignal("");
  const [aiPanel, setAiPanel] = createSignal<{ mode: "rename" | "tag"; items: AiPanelItem[] } | null>(null);
  const [aiBusy, setAiBusy] = createSignal(false);

  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(""), 2000);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadTagDefs();
    }
  });

  const typeLabel = () => (params.type === "image" ? "图包" : "证书");
  const subFolders = () =>
    params.type === "image"
      ? workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"]
      : workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  const decodedProductSet = () => {
    try {
      return decodeURIComponent(params.productSet || "");
    } catch {
      return params.productSet || "";
    }
  };

  const productSetDisplayName = () => {
    try {
      return decodeURIComponent(params.productSet || "");
    } catch {
      return params.productSet || "";
    }
  };

  const decodedSubFolder = () => {
    try {
      return decodeURIComponent(params.subFolder || "");
    } catch {
      return params.subFolder || "";
    }
  };

  // v2.4.x：请求序号守卫——快速连点切换文件夹时，丢弃过期请求的返回，保证最终显示正确文件夹
  let loadSeq = 0;
  const loadFiles = async () => {
    const seq = ++loadSeq;
    const result = await api.files.list({
      product_set: decodedProductSet(),
      file_type: params.type ?? "image",
      sub_folder: decodedSubFolder(),
    });
    if (seq !== loadSeq) return; // 已切到别的文件夹，过期结果直接丢弃
    if (result.success && result.data) {
      setFiles(result.data);
    }
  };

  createEffect(() => {
    fileBrowserRefreshTrigger(); // 触发文件列表刷新
    if (params.productSet && params.subFolder) {
      setSelectedFilePaths([]);
      loadFiles();
    }
  });

  const toggleFileSelection = (file: FileEntry) => {
    setSelectedFilePaths((prev) => {
      if (prev.includes(file.path)) {
        return prev.filter((p) => p !== file.path);
      }
      return [...prev, file.path];
    });
  };

  const selectAllFiles = () => {
    setSelectedFilePaths(filteredFiles().map((f) => f.path));
  };

  const clearSelection = () => {
    setSelectedFilePaths([]);
  };

  const handleBatchDelete = async () => {
    const paths = selectedFilePaths();
    if (paths.length === 0) return;
    await handleDelete(paths);
    setSelectedFilePaths([]);
  };

  const handleDelete = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${paths.length} 个文件吗？将移入回收站，可在回收站恢复。`)) return;
    const result = await api.files.delete(paths);
    if (result.success && result.data) {
      loadFiles();
      const { deleted, failed } = result.data;
      showActionMessage(`已删除 ${deleted} 个文件${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}（可在回收站恢复）`);
      // v2.4.2：全部失败时展示首个失败原因（聚合结果部分失败不回滚，明细可见）
      if (deleted === 0 && failed.length > 0) {
        window.alert(result.data.failed[0].error);
      }
    } else {
      window.alert(result.error || "删除失败");
    }
  };

  const handleRename = async (file: FileEntry) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      loadFiles();
      setSelectedFilePaths([]);
    } else {
      window.alert(result.error || "重命名失败");
    }
  };

  /** v2.3.3（P2）：批量重命名——从选中路径解析 FileEntry 列表并打开对话框（多选时菜单注入） */
  const handleBatchRename = () => {
    const byPath = new Map(files().map((f) => [f.path, f]));
    const list = selectedFilePaths()
      .map((p) => byPath.get(p))
      .filter((f): f is FileEntry => !!f);
    if (list.length < 2) return;
    setBatchRenameFiles(list);
    setShowBatchRename(true);
  };

  // —— v2.4.4：批量打标 / 压缩分享·解压 ——

  /** 选中路径在已加载 files 上的标签交集（无 tags 或缺标签的文件视为空集） */
  const commonTagsOf = (paths: string[]) => {
    const byPath = new Map(files().map((f) => [f.path, f]));
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
    const token = newArchiveToken();
    setArchiveState({ token, phase: "compress" });
    const r = await api.archive.compress({ paths, cancelToken: token });
    // 主进程异步执行（进度/结果走事件），此处失败仅作防御性收口
    if (!r.success) {
      setArchiveState(null);
      showToast("error", "压缩失败", r.error || "未知错误");
    }
  };

  const handleExtract = async (file: FileEntry, mode: "here" | "folder") => {
    const token = newArchiveToken();
    setArchiveState({ token, phase: "extract" });
    const r = await api.archive.extract({ zipPath: file.path, mode, cancelToken: token });
    if (!r.success) {
      setArchiveState(null);
      showToast("error", "解压失败", r.error || "未知错误");
    }
  };

  const handleCopyPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.copyFilesToClipboard(paths);
    if (result.success) {
      showActionMessage(`已复制 ${paths.length} 个文件到剪贴板`);
    } else {
      window.alert(result.error || "复制失败");
    }
  };

  const handleShowPathsInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.showFilesInExplorer(paths);
    if (!result.success) {
      window.alert(result.error || "打开文件夹失败");
    }
  };

  const handleCopySelected = () => handleCopyPaths(selectedFilePaths());
  const handleShowSelectedInExplorer = () => handleShowPathsInExplorer(selectedFilePaths());

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        const paths = selectedFilePaths();
        if (paths.length > 0) {
          e.preventDefault();
          handleCopyPaths(paths);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const handleDeleteSubfolder = async () => {
    const folder = decodedSubFolder();
    if (!folder) return;
    if (!window.confirm(`确定删除子文件夹 "${folder}" 吗？将移入回收站，可在回收站恢复。`)) return;
    const result = await api.files.deleteSubfolder({
      product_set: decodedProductSet(),
      file_type: params.type as "image" | "cert",
      name: folder,
    });
    if (result.success) {
      const folders = subFolders().filter((f) => f !== folder);
      const next = folders[0] || (params.type === "image" ? "主图" : "3C");
      navigate(`/files/${params.type}/${params.productSet}/${encodeURIComponent(next)}`);
      loadWorkspaceConfig();
    } else {
      window.alert(result.error || "删除子文件夹失败");
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName().trim();
    if (!name) return;
    const result = await api.files.createSubfolder({
      product_set: decodedProductSet(),
      file_type: params.type as "image" | "cert",
      name,
    });
    if (result.success) {
      setShowNewFolder(false);
      setNewFolderName("");
      loadWorkspaceConfig();
      navigate(`/files/${params.type}/${params.productSet}/${encodeURIComponent(name)}`);
    } else {
      window.alert(result.error || "创建子文件夹失败");
    }
  };

  const handleOpenPreview = (file: FileEntry) => {
    openPreview(file, { productSet: decodedProductSet(), editMetadata: false, onDelete: loadFiles });
  };

  const handleEditMetadata = (file: FileEntry) => {
    openPreview(file, { productSet: decodedProductSet(), editMetadata: true, onDelete: loadFiles });
  };

  // —— v2.2.0：AI 智能整理（命名 / 打标）——

  const aiSelectedNames = () => {
    const paths = selectedFilePaths().length > 0 ? selectedFilePaths() : (contextMenu.payload() ?? []);
    const byPath = new Map(files().map((f) => [f.path, f]));
    const names: string[] = [];
    for (const p of paths) {
      const f = byPath.get(p);
      if (f) names.push(f.name);
    }
    return names;
  };

  const handleAiRename = async () => {
    if (!requireLogin()) return;
    const names = aiSelectedNames();
    if (names.length === 0) return;
    setAiBusy(true);
    const r = await api.ai.call("rename", {
      files: names,
      template: workspaceConfig()?.naming_template ?? {},
      product_set: productSetDisplayName(),
    });
    setAiBusy(false);
    if (!r.success || !r.data) {
      window.alert(r.error || "AI 命名失败，请稍后重试");
      return;
    }
    const suggestions = (r.data as { suggestions?: { original: string; suggested: string; note?: string }[] })?.suggestions ?? [];
    if (suggestions.length === 0) {
      window.alert("AI 没有返回命名建议，请重试");
      return;
    }
    setAiPanel({ mode: "rename", items: suggestions });
  };

  const handleAiTag = async () => {
    if (!requireLogin()) return;
    const names = aiSelectedNames();
    if (names.length === 0) return;
    await loadTagDefs();
    setAiBusy(true);
    const r = await api.ai.call("tag", {
      files: names,
      existing_tags: tagList().map((t) => t.name),
    });
    setAiBusy(false);
    if (!r.success || !r.data) {
      window.alert(r.error || "AI 打标失败，请稍后重试");
      return;
    }
    const suggestions = (r.data as { suggestions?: { file: string; tags: string[] }[] })?.suggestions ?? [];
    if (suggestions.length === 0) {
      window.alert("AI 没有返回标签建议，请重试");
      return;
    }
    setAiPanel({
      mode: "tag",
      items: suggestions.map((s) => ({ original: s.file, tags: s.tags })),
    });
  };

  const applyAiRename = async (selected: number[]) => {
    const panel = aiPanel();
    if (!panel) return;
    let applied = 0;
    let failed = 0;
    for (const i of selected) {
      const item = panel.items[i];
      if (!item.suggested || item.suggested === item.original) continue;
      const file = files().find((f) => f.name === item.original);
      if (!file) continue;
      const r = await api.files.rename({ path: file.path, newName: item.suggested });
      if (r.success) {
        applied++;
      } else {
        failed++;
        window.alert(`「${item.original}」重命名失败：${r.error ?? "未知错误"}`);
      }
    }
    setAiPanel(null);
    setSelectedFilePaths([]);
    loadFiles();
    showActionMessage(
      applied > 0 ? `AI 命名完成：成功 ${applied} 项${failed ? `，失败 ${failed} 项` : ""}` : "没有可应用的命名建议",
    );
  };

  const applyAiTag = async (selected: number[]) => {
    const panel = aiPanel();
    if (!panel) return;
    let applied = 0;
    let failed = 0;
    let skipped = 0;
    // v2.3.0：AI 建议仅应用已定义标签，未定义者忽略（避免引入孤儿标签）
    const definedNames = new Set(tagList().flatMap((t) => [t.name, ...(t.children ?? [])]));
    for (const i of selected) {
      const item = panel.items[i];
      if (!item.tags || item.tags.length === 0) continue;
      const file = files().find((f) => f.name === item.original);
      if (!file) continue;
      const valid = item.tags.filter((t) => definedNames.has(t));
      if (valid.length === 0) {
        skipped++;
        continue;
      }
      // v2.4.2：主进程按文件绝对路径推导元数据 key（含子文件夹）
      const meta = await api.metadata.get(file.path);
      const current = meta.success && meta.data ? meta.data : { cert_type: "", expiry_date: "", tags: [] as string[], notes: "" };
      const merged = Array.from(new Set([...(current.tags ?? []), ...valid]));
      const r = await api.metadata.update({
        file_path: file.path,
        cert_type: current.cert_type ?? "",
        expiry_date: current.expiry_date ?? "",
        tags: merged,
        notes: current.notes ?? "",
      });
      if (r.success) {
        applied++;
      } else {
        failed++;
        window.alert(`「${item.original}」打标失败：${r.error ?? "未知错误"}`);
      }
    }
    setAiPanel(null);
    loadFiles();
    showActionMessage(
      applied > 0
        ? `AI 打标完成：成功 ${applied} 项${failed ? `，失败 ${failed} 项` : ""}${skipped ? `，忽略未定义标签 ${skipped} 项` : ""}`
        : (skipped > 0 ? "AI 建议的标签均未在设置中定义，未应用" : "没有可应用的标签建议"),
    );
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center gap-2 mb-2 text-sm text-surface-500 shrink-0">
        <button class="hover:text-primary-600" onClick={() => navigate("/product-sets")}>产品集</button>
        <span>/</span>
        <button class="hover:text-primary-600" onClick={() => navigate(`/product-sets/${params.productSet}`)}>{productSetDisplayName()}</button>
        <span>/</span>
        <span class="text-surface-900 font-medium">{typeLabel()} - {decodedSubFolder()}</span>
      </div>

      <div class="flex items-center justify-between mb-6">
        <div class="flex bg-surface-100 rounded-lg p-1">
          <For each={subFolders()}>
            {(sub) => (
              <button
                class={`px-4 py-2 text-sm rounded-md transition-colors ${decodedSubFolder() === sub ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
                onClick={() => navigate(`/files/${params.type}/${params.productSet}/${encodeURIComponent(sub)}`)}
              >
                {sub}
              </button>
            )}
          </For>
        </div>
        <div class="flex gap-2">
          <button
            class="btn-secondary text-sm text-red-600 hover:bg-red-50 hover:border-red-200"
            onClick={handleDeleteSubfolder}
          >
            🗑️ 删除当前{typeLabel()}类型
          </button>
          <button
            class="btn-secondary text-sm"
            onClick={() => setShowNewFolder(true)}
          >
            ➕ 新建{params.type === "image" ? "图包" : "证书"}类型
          </button>
        </div>
      </div>

      <Show when={selectedFilePaths().length > 0}>
        <div class="flex items-center justify-between mb-4 p-3 bg-primary-50 border border-primary-100 rounded-xl">
          <div class="flex flex-col gap-1">
            <span class="text-sm text-primary-700">已选择 {selectedFilePaths().length} 个文件</span>
            <Show when={actionMessage()}>
              <span class="text-xs text-primary-600">{actionMessage()}</span>
            </Show>
          </div>
          <div class="flex gap-2">
            <button
              class="px-3 py-1.5 text-sm text-surface-600 hover:bg-white rounded-lg transition-colors"
              onClick={clearSelection}
            >
              取消选择
            </button>
            <button
              class="px-3 py-1.5 text-sm text-white bg-primary-500 hover:bg-primary-600 rounded-lg transition-colors"
              onClick={handleCopySelected}
            >
              📋 复制选中
            </button>
            <button
              class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors"
              onClick={handleShowSelectedInExplorer}
            >
              📂 在文件夹中显示
            </button>
            <button
              class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors"
              onClick={() => handleBatchTag(selectedFilePaths())}
            >
              🏷️ 打标
            </button>
            <button
              class="px-3 py-1.5 text-sm text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg transition-colors"
              onClick={() => void handleCompress(selectedFilePaths())}
            >
              📦 压缩分享
            </button>
            <button
              class="px-3 py-1.5 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              onClick={handleBatchDelete}
            >
              删除选中
            </button>
          </div>
        </div>
      </Show>

      <div
        class="border-2 border-dashed rounded-2xl p-8 transition-colors border-surface-200 bg-surface-0 flex-1 min-h-0 flex flex-col"
      >
        <Show when={filteredFiles().length > 0} fallback={
          <EmptyState icon="📂" title={tagFilter() ? "没有匹配标签的文件" : "拖放文件到此处"} desc={tagFilter() ? "换个标签试试" : "支持图片、PDF 等文件"} />
        }>
          <div class="flex items-center justify-between mb-3 shrink-0">
            <div class="flex items-center gap-3">
              <span class="text-sm text-surface-500">{filteredFiles().length} 个文件</span>
              <select
                class="px-2 py-1.5 border border-surface-200 rounded-lg text-sm bg-white text-surface-600"
                value={tagFilter()}
                onChange={(e) => setTagFilter(e.currentTarget.value)}
                title="按标签筛选"
              >
                <option value="">全部标签</option>
                <For each={tagList()}>
                  {(t) => <option value={t.name}>{tagLabel(t.name)}</option>}
                </For>
              </select>
            </div>
            <button
              class="text-sm text-primary-600 hover:text-primary-700"
              onClick={selectAllFiles}
            >
              全选
            </button>
          </div>
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={filteredFiles()}
              itemHeight={252}
              columns={{ base: 2, md: 3, lg: 4, xl: 5 }}
              gap={16}
              scrollResetKey={`${params.type}/${params.productSet}/${params.subFolder}`}
              renderItem={(file) => (
                <div
                  class={`card p-3 cursor-pointer hover:shadow-card-hover transition-all select-none ${selectedFilePaths().includes(file.path) ? "border-primary-500 bg-primary-50" : ""}`}
                  draggable={true}
                  onDragStart={(e) => handleDragOut(e, file.path, selectedFilePaths())}
                  onContextMenu={(e) => {
                    // v2.4.2：右键——目标未选中时先单选它，菜单作用于「选中集合或该文件」
                    const paths = selectedFilePaths().includes(file.path) ? selectedFilePaths() : [file.path];
                    if (!selectedFilePaths().includes(file.path)) setSelectedFilePaths([file.path]);
                    contextMenu.open(e, paths);
                  }}
                  onClick={() => toggleFileSelection(file)}
                  onDblClick={() => handleOpenPreview(file)}
                >
                  <div class="relative h-36 rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden mb-3">
                    <input
                      type="checkbox"
                      class="absolute top-2 left-2 w-4 h-4 accent-primary-600 cursor-pointer"
                      checked={selectedFilePaths().includes(file.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleFileSelection(file)}
                    />
                    <FileThumbnail filePath={file.path} fileType={file.file_type} />
                  </div>
                  <div class="text-sm font-medium truncate">{file.name}</div>
                  <TagChips tags={file.tags} />
                  <div class="text-xs text-surface-400 flex justify-between mt-1">
                    <span>{formatBytes(file.size)}</span>
                    <span>{file.modified}</span>
                  </div>
                </div>
              )}
            />
          </div>
        </Show>
      </div>

      {/* New Folder Modal */}
      <Show when={showNewFolder()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowNewFolder(false)}>
          <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">新建{params.type === "image" ? "图包子文件夹" : "证书类型"}</h2>
            <input
              type="text"
              class="w-full px-3 py-2 border border-surface-200 rounded-lg mb-4"
              placeholder={params.type === "image" ? "如：场景图" : "如：FDA认证"}
              value={newFolderName()}
              onInput={(e) => setNewFolderName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            />
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setShowNewFolder(false)}>取消</button>
              <button class="btn-primary" onClick={handleCreateFolder}>创建</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Context Menu（统一组件，v2.3.x 由 builder 生成） */}
      <Show when={contextMenu.show()}>
        <ContextMenu
          x={contextMenu.x()}
          y={contextMenu.y()}
          onClose={contextMenu.close}
          items={[
            ...buildFileContextMenuItems({
              file: files().find((f) => f.path === (contextMenu.payload()?.[0] ?? "")),
              paths: contextMenu.payload() ?? [],
              onPreview: handleOpenPreview,
              onEditInfo: handleEditMetadata,
              onOpenDefault: (file) => void api.files.openWithDefaultApp(file.path),
              onCopy: handleCopyPaths,
              onShowInExplorer: handleShowPathsInExplorer,
              onMove: () => setShowMove(true),
              onRename: handleRename,
              onBatchTag: (paths) => handleBatchTag(paths),
              onBatchRename: () => void handleBatchRename(),
              onCompress: (paths) => void handleCompress(paths),
              onExtract: (file, mode) => void handleExtract(file, mode),
              onDelete: handleDelete,
            }),
            // AI 命名 / AI 打标（FEATURE_AI 开启后展示）
            {
              label: "AI 命名",
              icon: "🤖",
              show: FEATURE_AI && (contextMenu.payload()?.length ?? 0) >= 1,
              action: () => void handleAiRename(),
            },
            {
              label: "AI 打标",
              icon: "🏷️",
              show: FEATURE_AI && (contextMenu.payload()?.length ?? 0) >= 1,
              action: () => void handleAiTag(),
            },
          ]}
        />
      </Show>

      {/* 移动到… 目标选择（v2.3.x） */}
      <Show when={showMove()}>
        <MoveDialog
          paths={contextMenu.payload() ?? []}
          onClose={() => setShowMove(false)}
          onMoved={() => {
            loadFiles();
            setSelectedFilePaths([]);
          }}
        />
      </Show>

      {/* 批量重命名（v2.3.3 P2，多选菜单入口） */}
      <Show when={showBatchRename()}>
        <BatchRenameDialog
          files={batchRenameFiles()}
          onClose={() => setShowBatchRename(false)}
          onDone={() => {
            loadFiles();
            setSelectedFilePaths([]);
          }}
        />
      </Show>

      {/* 批量打标（v2.4.4） */}
      <Show when={batchTagState()}>
        <BatchTagDialog
          paths={batchTagState()!.paths}
          commonTags={batchTagState()!.commonTags}
          onClose={() => setBatchTagState(null)}
          onDone={() => {
            loadFiles();
            setSelectedFilePaths([]);
          }}
        />
      </Show>

      {/* 压缩分享 / 解压 进度（v2.4.4） */}
      <Show when={archiveState()}>
        <ArchiveProgressDialog token={archiveState()!.token} onClose={() => setArchiveState(null)} />
      </Show>

      {/* AI 建议面板（v2.2.0） */}
      <Show when={aiPanel()}>
        <AiSuggestionPanel
          title={aiPanel()!.mode === "rename" ? "AI 批量命名" : "AI 标签建议"}
          mode={aiPanel()!.mode}
          items={aiPanel()!.items}
          onApply={aiPanel()!.mode === "rename" ? applyAiRename : applyAiTag}
          onClose={() => setAiPanel(null)}
        />
      </Show>
    </div>
  );
}