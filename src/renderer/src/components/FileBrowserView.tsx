import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import Modal from "~/components/ui/Modal";
import FileBrowserToolbar from "./file-browser/FileBrowserToolbar";
import { workspaceConfig, loadWorkspaceConfig, currentWorkspace, fileBrowserRefreshTrigger, defaultNamingTemplate } from "~/stores/workspace";
import { openPreview, openFileSmart } from "~/stores/preview";
import { showToast } from "~/stores/notifyBanner";
import { loadTagDefs, tagLabel, tagList } from "~/stores/tags";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import MoveDialog from "~/components/MoveDialog";
import BatchRenameDialog from "~/components/BatchRenameDialog";
import RenameDialog from "~/components/RenameDialog";
import BatchTagDialog from "~/components/BatchTagDialog";
import ArchiveProgressDialog from "~/components/ArchiveProgressDialog";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { FileEntry } from "~/types";

/** v2.4.7（PLAN §4.6）：文件区作用域——productSet = 产品集文件区；customer = 客户文件区；v2.4.9 S2：supplier = 供应商文件区 */
export type FileBrowserScope = "productSet" | "customer" | "supplier";

/** 客户子文件夹默认集（config.customer_subfolders 缺省时兜底，与 PLAN §3.6 对齐） */
const CUSTOMER_DEFAULT_SUBFOLDERS = ["报价", "合同", "沟通", "其他"];

/** 供应商子文件夹默认集（core SUPPLIER_SUBFOLDERS 镜像；v2.5.5 起可配置，config.supplier_subfolders 缺省时兜底） */
const SUPPLIER_DEFAULT_SUBFOLDERS = ["合同", "对账单", "往来文件"];
/** v2.5.1（F2）：文档子文件夹默认集（core defaultWorkspaceConfig.doc_subfolders 镜像；缺省已由 loadConfig 合并写回，此处仅为防御） */
const DOC_DEFAULT_SUBFOLDERS = ["说明书", "参数表", "质检报告"];
/** v2.5.1（F2）：产品集区文件类型三态（图包/证书/文档） */
export type ProductSetFileType = "image" | "cert" | "doc";

// v2.5.3（P2-12）：模块级列表加载请求序号——跨挂载撞号防护（组件卸载后重挂载，旧响应不得
// 误判为最新）；卸载时 onCleanup 递增使在途请求作废（照 Images/Certs 先例）
let loadSeq = 0;

export interface FileBrowserViewProps {
  scope: FileBrowserScope;
  /** 实体名（已解码）：scope=productSet → 产品集名；scope=customer → 客户名 */
  entity: string;
  /** 当前子文件夹（已解码） */
  subFolder: string;
  /** 产品集区的文件类型（图包/证书/文档）；scope=customer 时忽略 */
  fileType?: ProductSetFileType;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * 文件管理视图（v2.4.7 从 FileBrowser 抽取，PLAN §5.2）：
 * 产品集路由页 /files/:type/:productSet/:subFolder、客户文件路由页 /files/customer/:name/:subFolder
 * （以及客户详情页文件区）与供应商文件路由页 /files/supplier/:name/:subFolder（以及供应商详情页文件区，v2.4.9 S2）共用。
 * scope=customer/supplier 时：
 * - fileList / createSubfolder / deleteSubfolder 走 scope='customer'/'supplier'（PLAN §4.6 / §3.1，
 *   路径 = 客户|供应商/<名>/<子文件夹>；v2.5.5 起供应商子文件夹可配置（新建/删除对齐客户））
 * - 预览不展示元数据面板（证书字段语义不适用），标签走批量打标/右键
 */
export default function FileBrowserView(props: FileBrowserViewProps) {
  const navigate = useNavigate();
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  // v2.4.7（评审修复）：列表加载态与失败反馈——加载中显示 Loading 而非空态，失败展示错误横幅
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [showNewFolder, setShowNewFolder] = createSignal(false);
  const [newFolderName, setNewFolderName] = createSignal("");
  // v2.4.7（评审修复）：新建子文件夹在途守卫——Enter/按钮连击防重复创建
  const [creatingFolder, setCreatingFolder] = createSignal(false);
  const [selectedFilePaths, setSelectedFilePaths] = createSignal<string[]>([]);
  // v2.4.4（T3）：标签筛选——渲染侧过滤，计数/全选作用于过滤结果，loadFiles 与选中/预览/右键行为零改动
  const [tagFilter, setTagFilter] = createSignal("");
  const filteredFiles = () => {
    const sel = tagFilter();
    return sel ? files().filter((f) => f.tags?.includes(sel)) : files();
  };
  const contextMenu = useContextMenu<string[]>();
  // v2.5.3（P1-1）：右键「移动到…」paths 页面级信号——ContextMenu 菜单项 action 后 close()
  // 同步清 payload，MoveDialog 若读 contextMenu.payload 将拿到 []（实测按钮「移动 0 个文件」且提交必报错）
  const [movePaths, setMovePaths] = createSignal<string[] | undefined>();
  // v2.3.3（P2）：批量重命名对话框（多选）
  const [showBatchRename, setShowBatchRename] = createSignal(false);
  const [batchRenameFiles, setBatchRenameFiles] = createSignal<FileEntry[]>([]);
  // v2.4.4：批量打标 / 压缩分享·解压 弹窗状态
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [archiveState, setArchiveState] = createSignal<{ token: string; phase: "compress" | "extract" } | null>(null);
  const [actionMessage, setActionMessage] = createSignal("");
  // v2.4.7（UI 反馈统一）：删除确认弹窗状态（替代 window.confirm）——kind=files 批量删文件 / kind=subfolder 删子文件夹
  const [confirmDelete, setConfirmDelete] = createSignal<{ kind: "files"; paths: string[] } | { kind: "subfolder"; folder: string } | null>(null);

  // v2.4.7（PERF-SOP §四）：组件级 setTimeout 进 onCleanup——防卸载后 setActionMessage 触碰已销毁组件
  let actionMessageTimer: number | undefined;
  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    window.clearTimeout(actionMessageTimer);
    actionMessageTimer = window.setTimeout(() => setActionMessage(""), 2000);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadTagDefs();
    }
  });

  const isCustomer = () => props.scope === "customer";
  const isSupplier = () => props.scope === "supplier";
  /** 客户/供应商文件区共用行为：file_type 忽略、路径 = <区根>/<名>/<子文件夹>、无产品集元数据面板 */
  const isEntityScope = () => isCustomer() || isSupplier();
  const scopeLabel = () => (isCustomer() ? "客户" : isSupplier() ? "供应商" : "");
  const fileType = () => props.fileType ?? "image";
  const typeLabel = () =>
    isCustomer() ? "客户文件" : isSupplier() ? "供应商文件" : fileType() === "image" ? "图包" : fileType() === "cert" ? "证书" : "文档";
  const subFolders = () =>
    isCustomer()
      ? workspaceConfig()?.customer_subfolders || CUSTOMER_DEFAULT_SUBFOLDERS
      : isSupplier()
        ? workspaceConfig()?.supplier_subfolders || SUPPLIER_DEFAULT_SUBFOLDERS
        : fileType() === "image"
          ? workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"]
          : fileType() === "cert"
            ? workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"]
            : // v2.5.1（F2）：文档子文件夹（config 缺省已由 loadConfig 合并，此处镜像兜底）
              workspaceConfig()?.doc_subfolders || DOC_DEFAULT_SUBFOLDERS;

  // v2.4.7：子文件夹路由路径按 scope 生成（customer → /files/customer/:name/:subFolder；v2.4.9 S2：supplier 同构）
  const folderPath = (sub: string) =>
    isCustomer()
      ? `/files/customer/${encodeURIComponent(props.entity)}/${encodeURIComponent(sub)}`
      : isSupplier()
        ? `/files/supplier/${encodeURIComponent(props.entity)}/${encodeURIComponent(sub)}`
        : `/files/${fileType()}/${encodeURIComponent(props.entity)}/${encodeURIComponent(sub)}`;

  // v2.4.x：请求序号守卫——快速连点切换文件夹时，丢弃过期请求的返回，保证最终显示正确文件夹
  // v2.5.3（P2-12）：序号已提升为模块级 loadSeq（跨挂载撞号防护），组件卸载时递增作废在途请求
  const loadFiles = async () => {
    const seq = ++loadSeq;
    setLoading(true);
    setLoadError("");
    try {
      const result = await api.files.list({
        product_set: props.entity,
        file_type: isEntityScope() ? "" : fileType(),
        sub_folder: props.subFolder,
        scope: props.scope,
      });
      if (seq !== loadSeq) return; // 已切到别的文件夹，过期结果直接丢弃
      if (result.success && result.data) {
        setFiles(result.data);
      } else {
        setLoadError(result.error || "文件列表加载失败");
      }
    } catch (e) {
      if (seq !== loadSeq) return;
      setLoadError(e instanceof Error ? e.message : "文件列表加载失败");
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  };

  createEffect(() => {
    // v2.5.3（P1-2）：显式依赖工作区——切工作区时 FBV 保持挂载（同一路由 props 不变），
    // 无此依赖则 effect 不重跑、文件列表停留旧区内容（照 Search.tsx T10 先例）
    void currentWorkspace();
    fileBrowserRefreshTrigger(); // 触发文件列表刷新
    if (props.entity && props.subFolder) {
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

  const handleBatchDelete = () => {
    const paths = selectedFilePaths();
    if (paths.length === 0) return;
    handleDelete(paths);
  };

  const handleDelete = (paths: string[]) => {
    if (paths.length === 0) return;
    setConfirmDelete({ kind: "files", paths });
  };

  const doDeleteFiles = async (paths: string[]) => {
    const result = await api.files.delete(paths);
    if (result.success && result.data) {
      loadFiles();
      setSelectedFilePaths([]); // 右键/工具栏删除成功后统一清空选中集（评审修复）
      const { deleted, failed } = result.data;
      showActionMessage(`已删除 ${deleted} 个文件${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}（可在回收站恢复）`);
      // v2.4.2：全部失败时展示首个失败原因（聚合结果部分失败不回滚，明细可见）
      if (deleted === 0 && failed.length > 0) {
        showToast("error", "删除失败", result.data.failed[0].error);
      }
    } else {
      showToast("error", "删除失败", result.error ?? undefined);
    }
  };

  // v2.5.2：单文件重命名弹窗（替代 window.prompt；错误经服务端回传展示）
  const [renameTarget, setRenameTarget] = createSignal<FileEntry | null>(null);
  const [renameError, setRenameError] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  const handleRename = (file: FileEntry) => {
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
        loadFiles();
        setSelectedFilePaths([]);
      } else {
        setRenameError(result.error ?? "未知错误");
      }
    } finally {
      setRenameBusy(false);
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
    if (archiveState()) return; // 单任务守卫（与 Certs 同款：防重复触发顶掉进行中任务的进度弹窗）
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
    if (archiveState()) return; // 单任务守卫（v2.5.3 P2-9-extract：与 handleCompress 同款，防顶掉进行中任务的进度弹窗）
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
      showToast("error", "复制失败", result.error ?? undefined);
    }
  };

  const handleShowPathsInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const result = await api.files.showFilesInExplorer(paths);
    if (!result.success) {
      showToast("error", "打开文件夹失败", result.error ?? undefined);
    }
  };

  const handleCopySelected = () => handleCopyPaths(selectedFilePaths());
  const handleShowSelectedInExplorer = () => handleShowPathsInExplorer(selectedFilePaths());

  // v2.5.5（对齐）：客户/供应商文件区按钮导入——多选对话框 → 既有导入管道（importFiles + scope，
  // 命名模板/冲突后缀/元数据/缩略图全复用）；进度 toast 与完成刷新由 GlobalDropOverlay 全局事件接管。
  // 产品集区（拖出拖入）不显示此入口（红线）。
  const handleImportFiles = async () => {
    const paths = await api.dialog.openFiles("选择文件（可多选）", [{ displayName: "所有文件", pattern: "*" }]);
    if (!paths || paths.length === 0) return;
    await api.files.import({
      source_paths: paths,
      target_product_set: props.entity,
      target_folder: props.subFolder,
      target_type: "",
      sub_folder: props.subFolder,
      scope: props.scope,
      cancelToken: crypto.randomUUID(),
    });
  };

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
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(actionMessageTimer);
    });
  });

  // v2.5.3（P2-12）：卸载时递增 loadSeq——在途 loadFiles 响应作废，防触碰已销毁组件
  onCleanup(() => {
    loadSeq++;
  });

  const handleDeleteSubfolder = () => {
    const folder = props.subFolder;
    if (!folder) return;
    setConfirmDelete({ kind: "subfolder", folder });
  };

  const doDeleteSubfolder = async (folder: string) => {
    const result = await api.files.deleteSubfolder({
      product_set: props.entity,
      file_type: isEntityScope() ? "" : fileType(),
      name: folder,
      scope: props.scope,
    });
    if (result.success) {
      const folders = subFolders().filter((f) => f !== folder);
      const next =
        folders[0] ||
        (isCustomer()
          ? CUSTOMER_DEFAULT_SUBFOLDERS[0]
          : isSupplier()
            ? SUPPLIER_DEFAULT_SUBFOLDERS[0]
            : fileType() === "image"
              ? "主图"
              : fileType() === "cert"
                ? "3C"
                : "说明书");
      navigate(folderPath(next));
      loadWorkspaceConfig();
    } else {
      showToast("error", "删除子文件夹失败", result.error ?? undefined);
    }
  };

  const handleCreateFolder = async () => {
    if (creatingFolder()) return; // 在途守卫：Enter/按钮连击只放行一次
    const name = newFolderName().trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const result = await api.files.createSubfolder({
        product_set: props.entity,
        file_type: isEntityScope() ? "" : fileType(),
        name,
        scope: props.scope,
      });
      if (result.success) {
        setShowNewFolder(false);
        setNewFolderName("");
        loadWorkspaceConfig();
        navigate(folderPath(name));
      } else {
        showToast("error", "创建子文件夹失败", result.error ?? undefined);
      }
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleOpenPreview = (file: FileEntry) => {
    // v2.4.7：customer/supplier 区不传 productSet（元数据面板为产品集证书字段语义，不适用）
    // v2.5.1（F3）：双击分流——可预览类型进预览，other 类型默认应用打开
    openFileSmart(file, isEntityScope()
      ? { editMetadata: false, onDelete: loadFiles }
      : { productSet: props.entity, editMetadata: false, onDelete: loadFiles });
  };

  const handleEditMetadata = (file: FileEntry) => {
    openPreview(file, isEntityScope()
      ? { editMetadata: false, onDelete: loadFiles }
      : { productSet: props.entity, editMetadata: true, onDelete: loadFiles });
  };

  /** 删除确认弹窗（v2.4.7 UI 反馈统一，替代 window.confirm；state 由 Show 保证非空） */
  const DeleteConfirm = (props: {
    state: { kind: "files"; paths: string[] } | { kind: "subfolder"; folder: string };
    onDone: () => void;
  }) => {
    return (
      <ConfirmDialog
        title={props.state.kind === "files" ? "删除文件" : "删除子文件夹"}
        message={
          props.state.kind === "files"
            ? `确定删除选中的 ${props.state.paths.length} 个文件吗？将移入回收站，可在回收站恢复。`
            : `确定删除子文件夹 "${props.state.folder}" 吗？将移入回收站，可在回收站恢复。`
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          // Solid props 为惰性 getter：先取 state 快照，再 onDone 置 null（否则 state.kind 重求值为 null 崩溃，
          // 2026-08-15 实测：产品集文档/图包/证书 tab 删除无反应 + 页面冻结，根因即此）
          const s = props.state;
          props.onDone();
          void (s.kind === "files" ? doDeleteFiles(s.paths) : doDeleteSubfolder(s.folder));
        }}
        onCancel={props.onDone}
      />
    );
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center gap-2 mb-2 text-sm text-surface-500 shrink-0">
        <Show when={isCustomer()} fallback={
          <Show when={isSupplier()} fallback={
            <>
              <button class="hover:text-primary-600" onClick={() => navigate("/product-sets")}>产品集</button>
              <span>/</span>
              <button class="hover:text-primary-600" onClick={() => navigate(`/product-sets/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
              <span>/</span>
              <span class="text-surface-900 font-medium">{typeLabel()} - {props.subFolder}</span>
            </>
          }>
            {/* v2.4.9 S2：供应商文件区面包屑（供应商 → 供应商详情） */}
            <button class="hover:text-primary-600" onClick={() => navigate("/suppliers")}>供应商</button>
            <span>/</span>
            <button class="hover:text-primary-600" onClick={() => navigate(`/suppliers/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
            <span>/</span>
            <span class="text-surface-900 font-medium">{props.subFolder}</span>
          </Show>
        }>
          <button class="hover:text-primary-600" onClick={() => navigate("/clients")}>客户</button>
          <span>/</span>
          <button class="hover:text-primary-600" onClick={() => navigate(`/clients/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
          <span>/</span>
          <span class="text-surface-900 font-medium">{props.subFolder}</span>
        </Show>
      </div>

      <FileBrowserToolbar
        subFolders={subFolders()}
        currentSub={props.subFolder}
        typeLabel={typeLabel()}
        isCustomer={isCustomer()}
        isSupplier={isSupplier()}
        showImport={isEntityScope()}
        onImportFiles={() => void handleImportFiles()}
        onNavigate={(sub) => navigate(folderPath(sub))}
        onDeleteSubfolder={handleDeleteSubfolder}
        onNewSubfolder={() => setShowNewFolder(true)}
      />


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
              class="px-3 py-1.5 text-sm text-white bg-danger-500 hover:bg-danger-600 rounded-lg transition-colors"
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
        <Show when={loadError()}>
          <div class="mb-3 px-3 py-2 rounded-xl bg-danger-50 border border-danger-200 text-sm text-danger-600 flex items-center justify-between shrink-0">
            <span>文件列表加载失败：{loadError()}</span>
            <button class="text-primary-600 hover:text-primary-700 whitespace-nowrap" onClick={() => void loadFiles()}>重试</button>
          </div>
        </Show>
        <Show when={filteredFiles().length > 0} fallback={
          <Show when={loading()} fallback={
            // v2.5.5（对齐）：客户/供应商区本就无拖放处理——空态不再谎称「拖放文件到此处」，改指按钮入口；
            // 产品集区拖入是红线交互，文案保持原样
            <EmptyState
              icon="📂"
              title={tagFilter() ? "没有匹配标签的文件" : isEntityScope() ? "还没有文件" : "拖放文件到此处"}
              desc={tagFilter() ? "换个标签试试" : isEntityScope() ? "点工具栏「选择文件并添加」导入" : "支持图片、PDF 等文件"}
            />
          }>
            <Loading text="文件加载中…" />
          </Show>
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
              scrollResetKey={`${props.scope}/${props.entity}/${props.subFolder}`}
              renderItem={(file) => (
                <div
                  class={`card p-3 cursor-pointer hover:shadow-card-hover select-none ${selectedFilePaths().includes(file.path) ? "border-primary-500 bg-primary-50" : ""}`}
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

      {/* New Folder Modal（v2.5.1 T3 波2：overlay→Modal 底座） */}
      <Show when={showNewFolder()}>
        <Modal open title={`新建${isCustomer() || isSupplier() ? "子文件夹" : fileType() === "image" ? "图包子文件夹" : fileType() === "cert" ? "证书类型" : "文档类型"}`} size="md" onClose={() => setShowNewFolder(false)}>
          <div class="p-6">
            <input
              type="text"
              class="input w-full mb-4"
              placeholder={isCustomer() || isSupplier() ? "如：报价" : fileType() === "image" ? "如：场景图" : fileType() === "cert" ? "如：FDA认证" : "如：使用说明"}
              value={newFolderName()}
              disabled={creatingFolder()}
              onInput={(e) => setNewFolderName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            />
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setShowNewFolder(false)}>取消</button>
              <button class="btn-primary" onClick={handleCreateFolder} disabled={creatingFolder()}>创建</button>
            </div>
          </div>
        </Modal>
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
              onMove: (paths) => setMovePaths(paths),
              onRename: handleRename,
              onBatchTag: (paths) => handleBatchTag(paths),
              onBatchRename: () => void handleBatchRename(),
              onCompress: (paths) => void handleCompress(paths),
              onExtract: (file, mode) => void handleExtract(file, mode),
              onDelete: handleDelete,
            }),
          ]}
        />
      </Show>

      {/* 移动到… 目标选择（v2.3.x；v2.5.3 P1-1：paths 走页面级 movePaths，不再读 contextMenu.payload） */}
      <Show when={movePaths()}>
        <MoveDialog
          paths={movePaths() ?? []}
          onClose={() => setMovePaths(undefined)}
          onMoved={() => {
            setMovePaths(undefined);
            loadFiles();
            setSelectedFilePaths([]);
          }}
        />
      </Show>

      {/* 批量重命名（v2.3.3 P2，多选菜单入口；v2.4.9 S5 复用命名模板——template 缺省兜底默认对象，
           ctx 的 product_set 槽位 = 当前实体名（产品集/客户/供应商，与导入语义一致）） */}
      <Show when={showBatchRename()}>
        <BatchRenameDialog
          files={batchRenameFiles()}
          template={workspaceConfig()?.naming_template ?? defaultNamingTemplate()}
          ctx={{ targetProductSet: props.entity, subFolder: props.subFolder }}
          onClose={() => setShowBatchRename(false)}
          onDone={() => {
            loadFiles();
            setSelectedFilePaths([]);
          }}
        />
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

      {/* 删除确认弹窗（v2.4.7 UI 反馈统一，替代 window.confirm） */}
      <Show when={confirmDelete()}>
        <DeleteConfirm state={confirmDelete()!} onDone={() => setConfirmDelete(null)} />
      </Show>
    </div>
  );
}
