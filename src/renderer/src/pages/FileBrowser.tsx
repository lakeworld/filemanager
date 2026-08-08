import { Show, For, createSignal, createEffect, onMount } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { workspaceConfig, loadWorkspaceConfig, currentWorkspace, fileBrowserRefreshTrigger } from "~/stores/workspace";
import { openPreview } from "~/stores/preview";
import FileThumbnail from "~/components/FileThumbnail";
import ContextMenu from "~/components/ContextMenu";
import { handleDragOut } from "~/utils/dragout";
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
  const [contextMenu, setContextMenu] = createSignal<{
    show: boolean;
    x: number;
    y: number;
    paths: string[];
  }>({ show: false, x: 0, y: 0, paths: [] });
  const [actionMessage, setActionMessage] = createSignal("");

  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    setTimeout(() => setActionMessage(""), 2000);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
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

  const loadFiles = async () => {
    const result = await api.files.list({
      product_set: decodedProductSet(),
      file_type: params.type,
      sub_folder: decodedSubFolder(),
    });
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
    setSelectedFilePaths(files().map((f) => f.path));
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
    if (!window.confirm(`确定要删除选中的 ${paths.length} 个文件吗？此操作不可恢复。`)) return;
    const result = await api.files.delete(paths);
    if (result.success) {
      loadFiles();
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

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, show: false }));

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
    const onClick = () => closeContextMenu();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("click", onClick);
    };
  });

  const handleDeleteSubfolder = async () => {
    const folder = decodedSubFolder();
    if (!folder) return;
    if (!window.confirm(`确定要删除子文件夹 "${folder}" 吗？该操作会删除其中所有文件，且不可恢复。`)) return;
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
    }
  };

  const handleOpenPreview = (file: FileEntry) => {
    openPreview(file, { productSet: decodedProductSet(), editMetadata: false, onDelete: loadFiles });
  };

  const handleEditMetadata = (file: FileEntry) => {
    openPreview(file, { productSet: decodedProductSet(), editMetadata: true, onDelete: loadFiles });
  };

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="flex items-center gap-2 mb-2 text-sm text-surface-500">
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
              class="px-3 py-1.5 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              onClick={handleBatchDelete}
            >
              删除选中
            </button>
          </div>
        </div>
      </Show>

      <div
        class="border-2 border-dashed rounded-2xl p-8 transition-colors border-surface-200 bg-surface-0"
      >
        <Show when={files().length > 0} fallback={
          <div class="text-center py-12">
            <div class="text-4xl mb-3">📂</div>
            <h3 class="text-lg font-medium text-surface-700 mb-1">拖放文件到此处</h3>
            <p class="text-sm text-surface-400">支持图片、PDF 等文件</p>
          </div>
        }>
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm text-surface-500">{files().length} 个文件</span>
            <button
              class="text-sm text-primary-600 hover:text-primary-700"
              onClick={selectAllFiles}
            >
              全选
            </button>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            <For each={files()}>
              {(file) => (
                <div
                  class={`card p-3 cursor-pointer hover:shadow-card-hover transition-all select-none ${selectedFilePaths().includes(file.path) ? "border-primary-500 bg-primary-50" : ""}`}
                  draggable={true}
                  onDragStart={(e) => handleDragOut(e, file.path, selectedFilePaths())}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const paths = selectedFilePaths().includes(file.path)
                      ? selectedFilePaths()
                      : [file.path];
                    setContextMenu({ show: true, x: e.clientX, y: e.clientY, paths });
                  }}
                  onClick={() => handleOpenPreview(file)}
                >
                  <div class="relative aspect-square rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden mb-3">
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
                  <div class="text-xs text-surface-400 flex justify-between mt-1">
                    <span>{formatBytes(file.size)}</span>
                    <span>{file.modified}</span>
                  </div>
                </div>
              )}
            </For>
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

      {/* Context Menu（统一组件） */}
      <Show when={contextMenu().show}>
        <ContextMenu
          x={contextMenu().x}
          y={contextMenu().y}
          onClose={closeContextMenu}
          items={[
            {
              label: "预览",
              icon: "👁️",
              action: () => {
                const file = files().find((f) => f.path === contextMenu().paths[0]);
                if (file) handleOpenPreview(file);
              },
            },
            {
              label: "编辑信息",
              icon: "✏️",
              show: contextMenu().paths.length === 1,
              action: () => {
                const file = files().find((f) => f.path === contextMenu().paths[0]);
                if (file) handleEditMetadata(file);
              },
            },
            {
              label: "用默认程序打开",
              icon: "🖥️",
              show: contextMenu().paths.length === 1,
              action: () => {
                const file = files().find((f) => f.path === contextMenu().paths[0]);
                if (file) void api.files.openWithDefaultApp(file.path);
              },
            },
            {
              label: "复制",
              icon: "📋",
              action: () => handleCopyPaths(contextMenu().paths),
            },
            {
              label: "复制路径",
              icon: "🔗",
              action: () => void api.files.copyPaths(contextMenu().paths),
            },
            {
              label: "在文件夹中显示",
              icon: "📂",
              action: () => handleShowPathsInExplorer(contextMenu().paths),
            },
            {
              label: "重命名",
              icon: "✏️",
              show: contextMenu().paths.length === 1,
              action: () => {
                const file = files().find((f) => f.path === contextMenu().paths[0]);
                if (file) handleRename(file);
              },
            },
            {
              label: "删除",
              icon: "🗑️",
              danger: true,
              action: () => handleDelete(contextMenu().paths),
            },
          ]}
        />
      </Show>
    </div>
  );
}