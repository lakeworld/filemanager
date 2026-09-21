import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import Modal from "~/components/ui/Modal";
import SearchSelect from "~/components/ui/SearchSelect";
import FileBrowserToolbar from "./file-browser/FileBrowserToolbar";
import { workspaceConfig, loadWorkspaceConfig, currentWorkspace, fileBrowserRefreshTrigger, defaultNamingTemplate } from "~/stores/workspace";
import { openPreview, openFileSmart } from "~/stores/preview";
import { showToast } from "~/stores/notifyBanner";
// v2.5.8 D19（B1）：复制反馈统一（成功/失败都出声）
import { copyFilesWithFeedback } from "~/utils/copyAction";
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
import { withBuiltinNotes, BUILTIN_NOTES_FOLDER, defaultSubFolder } from "~/constants/notes";
import type { SubfolderEntry } from "../../../shared/types";
import Input from "~/components/ui/Input";
import SelectionBar from "~/components/ui/SelectionBar";
import { useCopyShortcut } from "~/hooks/useCopyShortcut";
// v2.5.8 D19（B3/B7）：Ctrl+X / Ctrl+V 走声明表注册（不自己挂 keydown）+ 应用内剪切标记
import { registerShortcut } from "~/shortcuts";
import { showPreview } from "~/stores/preview";
import { applyCut, cutPaths, resetCut, syncCutWithSelection } from "~/stores/appClipboard";
import { pasteIntent } from "~/lib/cutPaste";
import { pushLayer } from "~/components/ui/layerStack";

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
  /** v2.5.7（A2 笔记）：深链文件名（?note=<文件名>）——文件列表就绪后直开 NoteEditorModal */
  deepLinkNote?: string;
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
  // v2.5.7（A2 笔记）：新建笔记弹窗（文件区「笔记」视图工具栏入口 → 标题 → <标题>.md → 直开编辑）
  const [showNewNote, setShowNewNote] = createSignal(false);
  const [newNoteTitle, setNewNoteTitle] = createSignal("");
  const [creatingNote, setCreatingNote] = createSignal(false);
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
  /**
   * 今日口径的名单（读全局 config 那张表）——A9 刀1b 起**降级为占位**：
   * 只用于「盘数据还没到达的首帧」与「读盘失败时不把人锁在外面」，
   * 一旦 `listSubfolders` 返回就以它为准。刻意保留而不是删掉：删了首帧会闪空白。
   */
  const configFolders = () =>
    isCustomer()
      ? withBuiltinNotes(workspaceConfig()?.customer_subfolders, CUSTOMER_DEFAULT_SUBFOLDERS)
      : isSupplier()
        ? withBuiltinNotes(workspaceConfig()?.supplier_subfolders, SUPPLIER_DEFAULT_SUBFOLDERS)
        : fileType() === "image"
          ? workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"]
          : fileType() === "cert"
            ? workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"]
            : // v2.5.1（F2）：文档子文件夹（config 缺省已由 loadConfig 合并，此处镜
              // v2.5.7（A2 笔记）：文档区并入内建「笔记」
              withBuiltinNotes(workspaceConfig()?.doc_subfolders, DOC_DEFAULT_SUBFOLDERS);

  /**
   * v2.5.9（A9 刀1b）：**tab 名单改由硬盘决定**（设计 §二；P1/P2 的根治点）。
   *  - 盘上有、表里没 → 看得见（坚果云手工塞的目录不再隐身，P2）；
   *  - 顺序与「空/非空」都在主进程定（§八 实测 readdir 原序非名称序 ⇒ 顺序只留一个权威）；
   *  - 内建「笔记」按现状并进最左，不参与以盘为准（用户拍板「笔记保持现状」）。
   */
  // v2.5.9（A9 刀1b）：**tab 名单改由硬盘决定**（设计 §二；P1/P2 的根治点）。
  //  - 盘上有、表里没 → 看得见（坚果云手工塞进来的目录不再隐身，P2）；
  //  - 顺序与「空 / 非空」都在主进程定（§八 实测 readdir 原序稳定但非名称序 ⇒ 顺序只留一个权威）；
  //  - 内建「笔记」按现状并进最左，不参与以盘为准（用户拍板「笔记保持现状」）。
  // 形状用本文件既有的 signal + effect（不引 createResource：它在本仓只有零星使用者，
  // 而这里的取值语义就是「每次实体/域变了重拉一次」）。
  const [diskSubs, setDiskSubs] = createSignal<SubfolderEntry[] | null>(null);
  const loadSubFolders = async () => {
    const r = await api.files.listSubfolders({
      product_set: props.entity,
      file_type: fileType(),
      scope: props.scope,
    });
    // 失败不清盘（保持上一次结果，避免网络/IO 抖动把 tab 打空），只记一条日志
    if (r.success) setDiskSubs(r.data ?? []);
    else console.warn('[A9] listSubfolders 失败，tab 暂用占位名单:', r.error);
  };
  createEffect(() => {
    // 依赖追踪：实体 / 域变 ⇒ 重拉；**连子文件夹切换也重拉**，这样手工建的或坚果云刚同步进来的
    // 目录「切一下 tab 就出现」，不必重启应用（A9 的核心承诺之一）。
    // 代价实测过（设计 §八）：整域 readdir 800 个目录 3.5ms、单实体一层 0.022ms ⇒ 换一次路由
    // 重拉完全可忽略；**不用轮询**（无界 IO，且 §一.7 那类"背景活别占主线程"的口径也不允许）。
    void props.entity;
    void props.fileType;
    void props.scope;
    void props.subFolder;
    void loadSubFolders();
  });
  const subFolders = () => {
    const e = diskSubs();
    if (!e) return configFolders(); // 首帧占位 / 读盘失败：退回今日口径，不让用户对着空白 tab
    const names = e.map((x) => x.name);
    return isCustomer() || isSupplier() || fileType() === "doc"
      ? withBuiltinNotes(names, [])
      : names;
  };
  /** 空目录（盘上真实为空）→ 淡一档；占位期不淡显——那份名单没有盘信息 */
  const emptySubFolders = () => {
    const e = diskSubs();
    if (!e) return new Set<string>();
    return new Set(e.filter((x) => !x.has_files).map((x) => x.name));
  };
  /** 新建 / 删除 / 改名后刷新盘名单（表仍作为模板存在，但不再驱动显示） */
  const refreshSubFolders = () => {
    void loadSubFolders();
  };

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

  // v2.5.7（A2 笔记）：深链——工作台点击笔记行 → /files/.../笔记?note=<文件名> → 文件就绪后直开编辑
  createEffect(() => {
    const target = props.deepLinkNote;
    if (!target) return;
    const list = files();
    const hit = list.find((f) => f.name === target);
    if (hit) handleOpenPreview(hit);
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

  // v2.5.8 D19（B1）：复制反馈统一走全局 toast。本页其余动作（删除/新建笔记）仍用
  // `ui/SelectionBar` 上的 2s 内联条——那两处必然发生在有选区/有列表的语境里，内联条存在；
  // 而右键单选复制时没有选区条，内联条等于不存在，故只有复制换面。
  const handleCopyPaths = async (paths: string[]): Promise<void> => {
    await copyFilesWithFeedback(api.files.copyFilesToClipboard, paths);
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

  /**
   * v2.5.8 D19（体验批 B7）：Ctrl+X = **应用内**剪切标记。只打标记、不进系统剪贴板、不动文件；
   * 真正的移动发生在目标文件夹里按 Ctrl+V 那一刻（见 `handlePaste`）。
   * 边界（用户拍板）：不做「剪切到外部」——粘进资源管理器/微信会把文件移出工作区，
   * 元数据/标签/台账引用全断，违反「账物分离」；外发永远走复制。
   * 转移规则（同批再按一次=取消 / 空选中不改状态）住 `lib/cutPaste.ts`，本处只接线。
   */
  const handleCut = (): void => {
    const next = applyCut(selectedFilePaths());
    if (next.length === 0) {
      showToast("info", "已取消剪切标记");
      return;
    }
    showToast("info", `已标记 ${next.length} 个文件为剪切，到目标文件夹按 Ctrl+V 移动`);
  };

  /**
   * v2.5.8 D19（体验批 B3 + B7）：Ctrl+V 的两条链路，一个键两个语义，按「有标记先移动」排序。
   *
   * 目标位置**一律是当前正在看的这个文件夹**，参数与本页「导入文件」按钮逐字同构
   * （`target_product_set`/`target_folder`/`sub_folder`/`scope`），命名模板、冲突后缀、元数据、
   * 缩略图、进度事件全部复用既有导入管道 ⇒ 粘贴进来的文件和拖拽/对话框进来的文件走同一条路。
   *
   * 为什么只在这一个组件生效（聚合页不启用）：图包库/证书库/搜索页一个屏幕上混着**多个**
   * 产品集的文件，「粘贴到这里」的"这里"没有唯一答案，猜一个就是把文件放进别人的文件夹。
   * 文件浏览器永远对应一个确定的 `(实体, 子文件夹)`，这正是粘贴需要的落点。
   */
  const handlePaste = async (): Promise<void> => {
    const cut = cutPaths();
    if (pasteIntent(cut) === "move") {
      const r = await api.files.move({
        paths: cut,
        target_product_set: props.entity,
        target_type: props.fileType ?? "",
        sub_folder: props.subFolder,
        scope: props.scope,
      });
      if (!r.success) {
        showToast("error", "移动失败", r.error || "未知错误");
        return;
      }
      // 移动成功即清空标记：留着的话再按一次 Ctrl+V 会拿已经不在原地的路径再搬一遍
      resetCut();
      setSelectedFilePaths([]);
      void loadFiles();
      showToast("success", `已移动 ${cut.length} 个文件到「${props.subFolder}」`);
      return;
    }
    const res = await api.files.readClipboardFiles();
    if (!res.success) {
      showToast("error", "读取剪贴板失败", res.error || "未知错误");
      return;
    }
    const paths = res.data ?? [];
    if (paths.length === 0) return; // 剪贴板里没有文件 → 静默不动作（不弹「0 个文件」这种噪音）
    const r = await api.files.import({
      source_paths: paths,
      target_product_set: props.entity,
      target_folder: props.subFolder,
      target_type: props.fileType ?? "",
      sub_folder: props.subFolder,
      scope: props.scope,
      cancelToken: newArchiveToken(),
    });
    if (!r.success) {
      showToast("error", "粘贴导入失败", r.error || "未知错误");
      return;
    }
    void loadFiles();
    showToast("success", `已粘贴导入 ${paths.length} 个文件到「${props.subFolder}」`);
  };

  // 选中集一变就对账剪切标记：用户改去选别的文件，旧标记立刻作废（规则见 `lib/cutPaste.ts`）
  createEffect(() => {
    syncCutWithSelection(selectedFilePaths());
  });
  /**
   * 「切页取消标记」的准确口径：**换实体/换域**（产品集↔客户↔供应商、或换一个实体名）即作废，
   * 同一实体内换子文件夹不作废——后者正是「A 目录 Ctrl+X → B 目录 Ctrl+V」这条主路径。
   * 不按路由整页销毁来做：子文件夹切换同样是路由变化，那样一刀切会把功能本身切断。
   */
  let lastCutScopeKey: string | undefined;
  createEffect(() => {
    const key = `${props.scope}/${props.entity}`;
    if (lastCutScopeKey !== undefined && lastCutScopeKey !== key) resetCut();
    lastCutScopeKey = key;
  });
  // Esc 撤销剪切标记：走 `ui/layerStack` 而不是自己挂 keydown（全站监听数是门禁钉死的），
  // 且只在有标记时入栈——常驻入栈会吃掉全站每一次 Esc（同 `FilePreviewModal:89` 那条教训）。
  createEffect(() => {
    if (cutPaths().length === 0) return;
    const layer = pushLayer({ onEscape: () => resetCut() });
    onCleanup(() => layer.remove());
  });

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

  // v2.5.8 D19（B2）：Ctrl+C 的三条让位守卫（预览让位 / 正文选区让位 / 零选中放行）从本组件
  // 搬进 `hooks/useCopyShortcut.ts` + `lib/copyShortcut.ts`——同一段判据此前只有这一份实现，
  // B2 要把它铺到七个选中态页面，抄七遍等于把 v2.5.7 A1 的修复再赌一次。语义一字未动。
  useCopyShortcut(selectedFilePaths, (paths) => void handleCopyPaths(paths));

  onMount(() => {
    // v2.5.8 D19（B3/B7）：粘贴与应用内剪切。**只在这一个组件注册**——两者都需要一个确定的
    // 落点 (实体, 子文件夹)，聚合页给不出（见 `handlePaste` 注释）。走 `shortcuts.ts` 声明表，
    // 不自己挂 keydown（全站监听数由 `tests/unit/shortcuts.test.ts` 钉成 14）。
    const offCut = registerShortcut("file.cut", () => {
      if (showPreview()) return false; // 预览开着时 Ctrl+X 不动底层列表（与 Ctrl+C 同一条让位规则）
      if (selectedFilePaths().length === 0) return false;
      handleCut();
      return true;
    }, { pageOnly: true });
    const offPaste = registerShortcut("file.paste", () => {
      if (showPreview()) return false;
      void handlePaste();
      return true;
    }, { pageOnly: true });
    onCleanup(() => {
      offCut();
      offPaste();
    });
    onCleanup(() => {
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
      refreshSubFolders(); // A9：先让盘名单落地（删除只动本集，别再写全局表）
      const folders = subFolders().filter((f) => f !== folder);
      const next =
        defaultSubFolder(folders) ||
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
        refreshSubFolders(); // A9：以盘为准 ⇒ 新建完就要看见新 tab
        navigate(folderPath(name));
      } else {
        showToast("error", "创建子文件夹失败", result.error ?? undefined);
      }
    } finally {
      setCreatingFolder(false);
    }
  };

  /**
   * 笔记归属目录（三域口径与 core/paths + notes.ts 一致）。
   * v2.5.8 弹窗专项：抽成单点，写入点与弹窗副标题共用同一份——此前归属只在代码里算、
   * 界面上不显示，用户在这个入口建笔记时不知道会落到哪儿（台账 B10 的"锁死"一半是它没说出来）。
   */
  const noteDirRel = () =>
    isEntityScope()
      ? `${isCustomer() ? "客户" : "供应商"}/${props.entity}/${BUILTIN_NOTES_FOLDER}`
      : `产品集/${props.entity}/${fileType() === "doc" ? "文档" : fileType() === "cert" ? "证书" : "图包"}/${BUILTIN_NOTES_FOLDER}`;

  /** v2.5.7（A2 笔记）：文件区「笔记」视图新建笔记——标题 → <标题>.md（重名加 _1/_2 序号）→ 直开编辑 */
  const handleCreateNote = async () => {
    if (creatingNote()) return;
    const title = newNoteTitle().trim();
    if (!title) return;
    setCreatingNote(true);
    try {
      const ws = currentWorkspace()?.path;
      if (!ws) {
        showToast("error", "新建笔记失败", "未打开工作区");
        return;
      }
      // 笔记物理路径（与 core/paths + notes.ts 三域一致）
      const noteDir = noteDirRel();
      // 重名冲突：<标题>.md → <标题>_1.md → …（照命名先例）
      const titles = files().filter((f) => f.name.endsWith(".md")).map((f) => f.name);
      let base = title.endsWith(".md") ? title : `${title}.md`;
      let candidate = base;
      let i = 1;
      while (titles.includes(candidate)) {
        candidate = base.replace(/\.md$/i, `_${i}.md`);
        i++;
      }
      const r = await api.files.writeText(`${noteDir}/${candidate}`, `# ${title.replace(/\.md$/i, "")}\n\n`);
      if (r.success) {
        setShowNewNote(false);
        setNewNoteTitle("");
        // 新建后刷新列表并直开编辑（复用预览链路：md 文件 → NoteEditorModal 路由）
        await loadFiles();
        const created = files().find((f) => f.name === candidate);
        if (created) handleOpenPreview(created);
        showActionMessage(`已新建笔记 ${candidate}`);
      } else {
        showToast("error", "新建笔记失败", r.error ?? undefined);
      }
    } finally {
      setCreatingNote(false);
    }
  };

  const handleOpenPreview = (file: FileEntry) => {
    // v2.4.7：customer/supplier 区不传 productSet（元数据面板为产品集证书字段语义，不适用）
    // v2.5.1（F3）：双击分流——可预览类型进预览，other 类型默认应用打开
    // v2.5.8 D18：带可见列表快照（filteredFiles = 当前筛选后的文件），预览内可 ←/→ 连看
    openFileSmart(file, isEntityScope()
      ? { editMetadata: false, onDelete: loadFiles, list: filteredFiles() }
      : { productSet: props.entity, editMetadata: false, onDelete: loadFiles, list: filteredFiles() });
  };

  const handleEditMetadata = (file: FileEntry) => {
    // v2.5.8 D18：编辑信息入口与双击同列表（PLAN §三 D3：双击/右键/编辑信息同传）
    openPreview(file, isEntityScope()
      ? { editMetadata: false, onDelete: loadFiles, list: filteredFiles() }
      : { productSet: props.entity, editMetadata: true, onDelete: loadFiles, list: filteredFiles() });
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
              <button class="link-btn hover:text-primary-600" onClick={() => navigate("/product-sets")}>产品集</button>
              <span>/</span>
              <button class="link-btn hover:text-primary-600" onClick={() => navigate(`/product-sets/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
              <span>/</span>
              <span class="text-surface-900 font-medium">{typeLabel()} - {props.subFolder}</span>
            </>
          }>
            {/* v2.4.9 S2：供应商文件区面包屑（供应商 → 供应商详情） */}
            <button class="link-btn hover:text-primary-600" onClick={() => navigate("/suppliers")}>供应商</button>
            <span>/</span>
            <button class="link-btn hover:text-primary-600" onClick={() => navigate(`/suppliers/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
            <span>/</span>
            <span class="text-surface-900 font-medium">{props.subFolder}</span>
          </Show>
        }>
          <button class="link-btn hover:text-primary-600" onClick={() => navigate("/clients")}>客户</button>
          <span>/</span>
          <button class="link-btn hover:text-primary-600" onClick={() => navigate(`/clients/${encodeURIComponent(props.entity)}`)}>{props.entity}</button>
          <span>/</span>
          <span class="text-surface-900 font-medium">{props.subFolder}</span>
        </Show>
      </div>

      <FileBrowserToolbar
        subFolders={subFolders()}
        emptySubs={emptySubFolders()}
        currentSub={props.subFolder}
        typeLabel={typeLabel()}
        isCustomer={isCustomer()}
        isSupplier={isSupplier()}
        showImport={isEntityScope()}
        onImportFiles={() => void handleImportFiles()}
        onNavigate={(sub) => navigate(folderPath(sub))}
        onDeleteSubfolder={handleDeleteSubfolder}
        onNewSubfolder={() => setShowNewFolder(true)}
        onNewNote={() => setShowNewNote(true)}
      />


      {/* v2.5.8 D10（W5）：本条原为页内手写的内嵌横条，现收进 `ui/SelectionBar`——
          材质/量词位/Esc 全部单点。动作数组与按钮文案一字未改（既有 e2e 按 text 定位全绿即证）。
          形态由「内嵌进文档流」换成「底部悬浮」：内嵌条插入会把文件列表整体下移，
          与 Notes.tsx:492 注释里 e2e 轨迹抓实的那条双击丢失同因。 */}
      <SelectionBar
        count={selectedFilePaths().length}
        noun="个文件"
        message={actionMessage()}
        onClear={clearSelection}
        onSelectAll={selectAllFiles}
        onDelete={handleBatchDelete}
        actions={[
          { label: "📋 复制选中", tone: "primary", onClick: handleCopySelected },
          { label: "📂 在文件夹中显示", onClick: handleShowSelectedInExplorer },
          { label: "🏷️ 打标", onClick: () => handleBatchTag(selectedFilePaths()) },
          { label: "📦 压缩分享", onClick: () => void handleCompress(selectedFilePaths()) },
          { label: "删除选中", tone: "danger", onClick: handleBatchDelete },
        ]}
      />

      <div
        class="border-2 border-dashed rounded-2xl p-8 transition-colors border-surface-200 bg-surface-0 flex-1 min-h-0 flex flex-col"
      >
        <Show when={loadError()}>
          <div class="mb-3 px-3 py-2 rounded-xl bg-danger-50 border border-danger-200 text-sm text-danger-600 flex items-center justify-between shrink-0">
            <span>文件列表加载失败：{loadError()}</span>
            <button class="link-btn text-primary-600 hover:text-primary-700 whitespace-nowrap" onClick={() => void loadFiles()}>重试</button>
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
              {/* v2.5.8 D9（W4 控件统一 II）：原生 select → SearchSelect。
                  原先只有 `title`（悬停提示）没有可访问名，e2e 只能按位置定位 ⇒ 改吃 ariaLabel。 */}
              <SearchSelect
                class="min-w-[112px] md:w-40"
                compact
                ariaLabel="按标签筛选"
                options={[
                  { value: "", label: "全部标签" },
                  ...tagList().map((t) => ({ value: t.name, label: tagLabel(t.name) })),
                ]}
                value={tagFilter()}
                placeholder="全部标签"
                matchTriggerWidth={false}
                onChange={setTagFilter}
              />
            </div>
            <button
              class="link-btn text-sm text-primary-600 hover:text-primary-700"
              onClick={selectAllFiles}
            >
              全选
            </button>
          </div>
          <div
          data-selection-bar-pad
          class={`flex-1 min-h-0 ${selectedFilePaths().length > 0 ? "pb-24" : ""}`}
        >
            <VirtualGrid
              items={filteredFiles()}
              itemHeight={252}
              columns={{ base: 2, md: 3, lg: 4, xl: 5 }}
              gap={16}
              scrollResetKey={`${props.scope}/${props.entity}/${props.subFolder}`}
              renderItem={(file) => (
                <div
                  // v2.5.8 D19（B7）：剪切标记中的卡片半透明（选中态是描边高亮，两者可叠加、说的是不同的事）
                  class={`card p-3 cursor-pointer select-none ${selectedFilePaths().includes(file.path) ? "card-selected" : ""} ${cutPaths().includes(file.path) ? "opacity-50" : ""}`}
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

      {/* New Folder Modal（v2.5.1 T3 波2：overlay→Modal 底座；v2.5.8 D14：套 framed 统一骨架——
          手搓的 `p-6` 排版与 `flex gap-3 justify-end` 按钮行撤进 .dlg-body / .dlg-footer 槽，
          标题此前只落在底座的可访问名上、界面上不可见，开 framed 后由骨架自己显示出来
          ⇒ 此处不得再补手写标题（Modal.tsx:51） */}
      <Show when={showNewFolder()}>
        <Modal
          open
          title={`新建${isCustomer() || isSupplier() ? "子文件夹" : fileType() === "image" ? "图包子文件夹" : fileType() === "cert" ? "证书类型" : "文档类型"}`}
          size="md"
          framed
          onClose={() => setShowNewFolder(false)}
          footer={
            <>
              <button class="btn-secondary" onClick={() => setShowNewFolder(false)}>取消</button>
              <button class="btn-primary" onClick={handleCreateFolder} disabled={creatingFolder()}>创建</button>
            </>
          }
        >
          <Input
            class="w-full"
            placeholder={isCustomer() || isSupplier() ? "如：报价" : fileType() === "image" ? "如：场景图" : fileType() === "cert" ? "如：FDA认证" : "如：使用说明"}
            value={newFolderName()}
            disabled={creatingFolder()}
            onInput={(e) => setNewFolderName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
          />
        </Modal>
      </Show>

      {/* v2.5.7（A2 笔记）：新建笔记弹窗（文件区「笔记」视图 —— 标题 → .md → 直开编辑） */}
      <Show when={showNewNote()}>
        <Modal
          open
          title="新建笔记"
          subtitle={<>
            保存到 <span class="font-mono text-xs">{noteDirRel()}/</span>
            （归属为当前实体；要给别的实体记笔记，请到「笔记库」新建）
          </>}
          size="md"
          framed
          onClose={() => setShowNewNote(false)}
          footer={
            <>
              <button class="btn-secondary" onClick={() => setShowNewNote(false)}>取消</button>
              <button class="btn-primary" onClick={() => void handleCreateNote()} disabled={creatingNote() || !newNoteTitle().trim()}>
                创建并编辑
              </button>
            </>
          }
        >
          <div class="dlg-field">
            <label class="dlg-label dlg-required">笔记标题</label>
            <Input
            class="w-full"
              placeholder="保存为 <标题>.md"
              value={newNoteTitle()}
              disabled={creatingNote()}
              onInput={(e) => setNewNoteTitle(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCreateNote()}
            />
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
          // v2.5.9（A9 刀5）：客户/供应商文件区里挪文件＝在**本实体内部**换子文件夹，
          // 不再让用户去选"哪个产品集/图包还是证书"（那套选择在这个域里根本不成立）。
          scope={isCustomer() ? "customer" : isSupplier() ? "supplier" : undefined}
          entity={isCustomer() || isSupplier() ? props.entity : undefined}
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
