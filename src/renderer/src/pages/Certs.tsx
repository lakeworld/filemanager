import { Show, For, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  productSets,
  loadProductSets,
} from "~/stores/workspace";
import { openPreview, openFileSmart } from "~/stores/preview";
import { loadTagDefs, tagLabel, tagList } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import FileThumbnail from "~/components/FileThumbnail";
import TagChips from "~/components/TagChips";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import MoveDialog from "~/components/MoveDialog";
import BatchTagDialog from "~/components/BatchTagDialog";
import ArchiveProgressDialog from "~/components/ArchiveProgressDialog";
import ConfirmDialog from "~/components/ConfirmDialog";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import RenameDialog from "~/components/RenameDialog";
import SearchSelect, { type SearchSelectOption } from "~/components/ui/SearchSelect";
import { fmtLocalTime } from "~/utils/datetime";
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { FileEntry, ProductSetInfo } from "~/types";
import Input from "~/components/ui/Input";
import SelectionBar from "~/components/ui/SelectionBar";

interface CertItem extends FileEntry {
  productSet: string;
  subFolder: string;
}

/** 排序档（v2.5.8：SearchSelect 数据源，与既有三个 option 一字不动） */
const SORT_OPTIONS: readonly SearchSelectOption[] = [
  { value: "modified", label: "按修改时间" },
  { value: "name", label: "按文件名" },
  { value: "size", label: "按文件大小" },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// v2.4.2：loadAllCerts 代数守卫——切工作区后丢弃过期请求的返回，防止旧结果覆盖新数据
let certLoadSeq = 0;

export default function Certs() {
  const navigate = useNavigate();
  const [items, setItems] = createSignal<CertItem[]>([]);
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例；N×M 聚合链期间置位）
  const [loading, setLoading] = createSignal(true);
  // v2.5.3（T7）：卸载即递增加载代（模块级）——未完成的聚合链/元数据 worker 校验失效后立即退出
  onCleanup(() => {
    certLoadSeq++;
  });
  const [search, setSearch] = createSignal("");
  const [productSetFilter, setProductSetFilter] = createSignal<string>("");
  const [subFolderFilter, setSubFolderFilter] = createSignal<string>("");
  // v2.4.4（T3）：标签筛选——与产品集/子文件夹/搜索组合生效（filteredItems 内叠加条件）
  const [tagFilter, setTagFilter] = createSignal<string>("");
  const [sortBy, setSortBy] = createSignal<"modified" | "name" | "size">("modified");
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  const [actionMessage, setActionMessage] = createSignal("");
  const contextMenu = useContextMenu<string>();
  // v2.4.2：证书到期日缓存（path → expiry_date），用于卡片徽标
  const [expiries, setExpiries] = createSignal<Record<string, string>>({});

  // v2.4.3：支持 ?productSet= 深链（仪表盘「到期提醒」跳转，自动按产品集过滤）
  const [searchParams] = useSearchParams();
  createEffect(() => {
    const qps = searchParams.productSet;
    // SearchParams 值可能是 string[]（同名参数多值），只接受单值
    if (qps && typeof qps === "string") setProductSetFilter(qps);
  });

  const [movePaths, setMovePaths] = createSignal<string[] | null>(null);
  // v2.4.4：批量打标 / 压缩分享·解压 弹窗状态
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [archiveState, setArchiveState] = createSignal<{ token: string; phase: "compress" | "extract" } | null>(null);
  // v2.4.7：删除确认弹窗（替代 window.confirm）
  const [confirmDelete, setConfirmDelete] = createSignal<{ paths: string[] } | null>(null);

  // v2.4.7（PERF-SOP §四）：setTimeout 存句柄 + onCleanup 清理——防卸载后 setActionMessage 触碰已销毁组件
  let actionMessageTimer: number | undefined;
  const showActionMessage = (msg: string) => {
    setActionMessage(msg);
    window.clearTimeout(actionMessageTimer);
    actionMessageTimer = window.setTimeout(() => setActionMessage(""), 2000);
  };

  onCleanup(() => window.clearTimeout(actionMessageTimer));

  // v2.5.8：筛选下拉选项（SearchSelect 数据源）见下方 certFolders 之后声明——
  // createMemo 是急求值，放在 certFolders 之前会在挂载即读它而踩 TDZ（实测白屏，e2e 抓 pageerror 定位）

  // —— 虚拟滚动由 VirtualGrid 承担：只渲染可见行，滚出即卸载（替代旧 slice+哨兵分批）——
  // v2.5.8：卡型由「横向宽卡 + 48px 小图标」改「纵向信息封面卡」——
  // 旧版一行三列时上下留白巨大、名称单行截断、复选框孤悬右侧，观感空洞；
  // 新卡行高按**出档像素实测**定：单行名称的卡内容 ≈ 247（封面 112 + 名称 20 + 归属/时间两行 32
  // + 标签 26 + 内边距 20 + 描边阴影），名称两行（line-clamp-2）再 +19 ⇒ 行高取 280；
  // 卡片挂 min-h-[250px] 让单行名称也撑到同一档，行间距落在 14–30px（VirtualGrid 的行是
  // align-content:start，卡片按内容取高——行高给多了就是纯空隙，初版估 262 实测偏松）。
  // 高基数页禁 blur（PLAN §四 豁免）：一律实底 .card，不用 .card-glass。
  const ITEM_HEIGHT = 280;

  /** 封面底色按子文件夹语义分档（未知类型回退中性 cert 档） */
  const coverTone = (sub: string): { bg: string; band: string } => {
    if (sub === "3C") return { bg: "bg-info-50", band: "bg-info-400" };
    if (sub === "质检") return { bg: "bg-success-50", band: "bg-success-400" };
    if (sub === "专利") return { bg: "bg-warning-50", band: "bg-warning-400" };
    return { bg: "bg-cert-50", band: "bg-cert-400" };
  };

  /** 扩展名徽标（封面右上角）：PDF / 图片走真缩略图，其余按扩展名出字标 */
  const extBadge = (name: string): string => {
    const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase();
    return ext && ext !== name.toUpperCase() ? ext.slice(0, 4) : "FILE";
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
      loadTagDefs();
    }
  });

  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  // 筛选下拉选项（产品集/子文件夹/标签三族；排序档是常量，放模块顶层）
  const productSetOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "全部产品集" },
    ...productSets().map((ps: ProductSetInfo) => ({ value: ps.name, label: ps.name })),
  ]);
  const subFolderOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "全部子文件夹" },
    ...certFolders().map((f) => ({ value: f, label: f })),
  ]);
  const tagOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "全部标签" },
    ...tagList().map((t) => ({ value: t.name, label: tagLabel(t.name) })),
  ]);

  const loadAllCerts = async () => {
    if (!currentWorkspace()) return;
    const seq = ++certLoadSeq;
    setLoading(true);
    try {
      const result = await api.productSets.list();
      // v2.5.3（P2-9）：首查失败不再静默——toast 提示（空态兜底仍显示，但用户知道为何为空）
      if (!result.success || !result.data) {
        showToast("error", "加载证书失败", result.error || "未知错误");
        return;
      }
      if (seq !== certLoadSeq) return;

      const all: CertItem[] = [];
      for (const ps of result.data) {
        for (const sub of certFolders()) {
          const fileResult = await api.files.list({
            product_set: ps.name,
            file_type: "cert",
            sub_folder: sub,
          });
          if (seq !== certLoadSeq) return;
          if (fileResult.success && fileResult.data) {
            for (const f of fileResult.data) {
              all.push({ ...f, productSet: ps.name, subFolder: sub });
            }
          }
        }
      }
      setItems(all);
      setSelectedPaths([]);

      // v2.4.2：批量拉取每张证书的到期日（成功且 expiry_date 非空才记录）
      // v2.4.7（评审 P2）：Promise.all 无并发闸会同时打满 IPC——照 Invoices checkFilesExistence 的 8 并发 worker 模式
      const map: Record<string, string> = {};
      const queue = all.map((c) => c.path);
      const workers = Array.from({ length: 8 }, async () => {
        while (queue.length > 0) {
          // v2.5.3（T7）：每轮取任务前校验代际——组件卸载/新链发起后旧 worker 立即退出，不再消费队列
          if (seq !== certLoadSeq) return;
          const p = queue.shift()!;
          const r = await api.metadata.get(p);
          if (r.success && r.data?.expiry_date) map[p] = r.data.expiry_date;
        }
      });
      await Promise.all(workers);
      if (seq !== certLoadSeq) return;
      setExpiries(map);
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (seq === certLoadSeq) setLoading(false);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadAllCerts();
    }
  });

  // v2.5.5：LAN 拉取自动注册证书子文件夹 → 即时刷新面板（可见性反馈；订阅模式照 accountChanged）
  createEffect(() => {
    const unsub = window.qihebox.events.on("share:subfolder-registered", (data) => {
      const info = data as { kind?: string } | null;
      if (!info || info.kind !== "cert") return;
      void loadWorkspaceConfig();
      void loadProductSets();
      void loadAllCerts();
    });
    onCleanup(unsub);
  });

  // v2.4.7（评审 P2）：path→修改时间戳 预解析 Map——仅 items 变化时重算一次，
  // 排序比较器查 Map 比数字，避免每对元素都 new Date()（照 Images.tsx modifiedTs 先例）
  const modifiedTs = createMemo(() => {
    const map = new Map<string, number>();
    for (const it of items()) map.set(it.path, new Date(it.modified).getTime());
    return map;
  });

  // v2.4.7（评审 P2）：filteredItems 包成 createMemo——visibleCount / 全选 / VirtualGrid / 打包按钮
  // 共享一次筛选+排序结果，不再每处调用都重排；排序规则（字段/方向）不变（照 Images.tsx filteredItems 先例）
  const filteredItems = createMemo(() => {
    const term = search().trim().toLowerCase();
    const ps = productSetFilter();
    const sub = subFolderFilter();
    const tag = tagFilter();
    const ts = modifiedTs();
    let list = items().filter((it) => {
      if (ps && it.productSet !== ps) return false;
      if (sub && it.subFolder !== sub) return false;
      if (term && !it.name.toLowerCase().includes(term)) return false;
      if (tag && !it.tags?.includes(tag)) return false;
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

  // v2.4.2：到期徽标——距到期日 ≤30 天或已过期标红
  const expiryInfo = (path: string) => {
    const d = expiries()[path];
    if (!d) return null;
    const t = new Date(d + "T00:00:00").getTime();
    if (Number.isNaN(t)) return null;
    const days = Math.ceil((t - Date.now()) / 86400000);
    return { label: days <= 0 ? `${d}（已过期）` : `${d}（剩 ${days} 天）`, urgent: days <= 30 };
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
    // 确认后由 ConfirmDialog onConfirm 执行 doDelete
    setConfirmDelete({ paths });
  };

  const doDelete = async (paths: string[]) => {
    const result = await api.files.delete(paths);
    if (result.success) {
      setSelectedPaths([]);
      loadAllCerts();
    } else {
      showToast("error", "删除失败", result.error || "未知错误");
    }
  };

  // v2.5.2：单文件重命名弹窗（替代 window.prompt；服务端校验错误回传展示）
  const [renameTarget, setRenameTarget] = createSignal<CertItem | null>(null);
  const [renameError, setRenameError] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  const handleRename = (file: CertItem) => {
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
        loadAllCerts();
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
    if (archiveState()) return; // 单任务守卫（评审 P1：防重复触发顶掉进行中任务的进度弹窗）
    const token = newArchiveToken();
    setArchiveState({ token, phase: "compress" });
    const r = await api.archive.compress({ paths, cancelToken: token });
    // 主进程异步执行（进度/结果走事件），此处失败仅作防御性收口
    if (!r.success) {
      setArchiveState(null);
      showToast("error", "压缩失败", r.error || "未知错误");
    }
  };

  const handleExtract = async (file: CertItem, mode: "here" | "folder") => {
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
          <h1 class="text-2xl font-bold text-surface-900">证书库</h1>
          <p class="text-surface-500 mt-1">所有证书文件</p>
        </div>
      </div>

      {/* 筛选行（v2.5.8：原生 select → SearchSelect 搜索下拉；本页与笔记库是该组件首批使用者）。
          响应式口径：整行 flex-wrap，控件可收缩且各有下限——早先给下拉挂 `shrink-0` 而搜索框
          `flex-1 min-w-0`，窄窗口下多出来的宽度全被搜索框吃掉（实测 1022 视口压成 16px，
          且行宽超出容器冒出横向滚动条），违反 ui-consistency「1024 无横向滚动」条。 */}
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <Input
        class="w-full min-w-0 md:w-auto md:flex-1 md:min-w-[180px]"
          placeholder="搜索文件名..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <SearchSelect
          class="min-w-[112px] md:w-44"
          compact
          ariaLabel="产品集筛选"
          options={productSetOptions()}
          value={productSetFilter()}
          placeholder="全部产品集"
          matchTriggerWidth={false}
          onChange={setProductSetFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="子文件夹筛选"
          options={subFolderOptions()}
          value={subFolderFilter()}
          placeholder="全部子文件夹"
          searchable={false}
          matchTriggerWidth={false}
          onChange={setSubFolderFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="标签筛选"
          options={tagOptions()}
          value={tagFilter()}
          placeholder="全部标签"
          matchTriggerWidth={false}
          onChange={setTagFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="排序方式"
          options={SORT_OPTIONS}
          value={sortBy()}
          searchable={false}
          matchTriggerWidth={false}
          onChange={(v) => setSortBy(v as "modified" | "name" | "size")}
        />
        {/* v2.4.7（F9）：一键打包当前筛选结果（无需先全选）——产物落 工作区/导出/，完成弹窗可见 */}
        <button
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white text-surface-700 hover:bg-surface-50 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={visibleCount() === 0}
          title="将当前筛选出的全部证书压缩为一个 zip"
          onClick={() => void handleCompress(filteredItems().map((it) => it.path))}
        >
          📦 打包当前筛选（{visibleCount()}）
        </button>
      </div>

      {/* v2.5.8 D10（W5）：收进 ui/SelectionBar，动作与文案一字未改 */}
      <SelectionBar
        count={selectedCount()}
        noun="个文件"
        message={actionMessage()}
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
        <Show when={!loading()} fallback={<Loading text="证书加载中…" />}>
          <EmptyState icon="📜" title="暂无证书" desc="导入证书到产品集中" />
        </Show>
      }>
        <div class="flex items-center justify-between mb-3 shrink-0">
          <span class="text-sm text-surface-500">{visibleCount()} 个文件</span>
          <button class="text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
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
            columns={{ base: 2, md: 3, lg: 4 }}
            gap={14}
            // v2.5.3（P2-11）：筛选/搜索切换时滚动归零（照 Quotes/Invoices scrollResetKey 先例）
            scrollResetKey={`${search()}|${productSetFilter()}|${subFolderFilter()}|${tagFilter()}|${sortBy()}`}
            renderItem={(cert) => {
              const tone = () => coverTone(cert.subFolder);
              const isImg = () => cert.file_type === "image";
              const exp = () => expiryInfo(cert.path);
              return (
                <div
                  class={`card p-2.5 min-h-[250px] flex flex-col gap-1.5 cursor-pointer select-none ${
                    selectedPaths().includes(cert.path) ? "card-selected" : ""
                  }`}
                  draggable={true}
                  onDragStart={(e) => handleDragOut(e, cert.path, selectedPaths())}
                  onContextMenu={(e) => {
                    // v2.4.2：右键——目标未选中时先单选它，菜单作用于该文件
                    if (!selectedPaths().includes(cert.path)) setSelectedPaths([cert.path]);
                    contextMenu.open(e, cert.path);
                  }}
                  onClick={() => toggleSelection(cert.path)}
                  onDblClick={() => openFileSmart(cert, { onDelete: loadAllCerts })}
                >
                  {/* 信息封面：图片证书走真缩略图；PDF/其它以「类型色带 + 扩展名字标」构成可辨识封面
                      （v2.1.0 起主进程不给 PDF 出缩略图，用户 2026-09-08 拍板本批也不引入 pdfjs 抓帧） */}
                  <div class={`relative h-28 rounded-lg overflow-hidden ${tone().bg} shrink-0`}>
                    <span class={`absolute left-0 top-0 bottom-0 w-1 ${tone().band}`} />
                    <Show
                      when={isImg()}
                      fallback={
                        <div class="w-full h-full flex items-center justify-center">
                          <span class="text-3xl leading-none opacity-70">📄</span>
                        </div>
                      }
                    >
                      <FileThumbnail filePath={cert.path} fileType={cert.file_type} class="w-full h-full object-cover" />
                    </Show>
                    <input
                      type="checkbox"
                      class="absolute top-1.5 left-3 w-4 h-4 accent-primary-600 cursor-pointer z-10"
                      checked={selectedPaths().includes(cert.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelection(cert.path)}
                    />
                    <span class="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-surface-900/70 text-[10px] font-medium text-white leading-none">
                      {extBadge(cert.name)}
                    </span>
                    <Show when={exp()}>
                      {(info) => (
                        <span
                          class={`absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${
                            info().urgent ? "bg-danger-500 text-white" : "bg-warning-100 text-warning-700"
                          }`}
                          title={`到期日 ${info().label}`}
                        >
                          {info().urgent ? "⚠ " : ""}
                          {info().label}
                        </span>
                      )}
                    </Show>
                  </div>
                  <div class="px-0.5">
                    <div class="text-sm font-medium leading-snug line-clamp-2 break-all">{cert.name}</div>
                  </div>
                  <div class="px-0.5 text-[11px] text-surface-400 truncate">
                    {cert.productSet} / {cert.subFolder}
                  </div>
                  <div class="px-0.5 text-[11px] text-surface-400 tabular-nums truncate">
                    {formatBytes(cert.size)} · {fmtLocalTime(cert.modified)}
                  </div>
                  <div class="px-0.5 mt-auto">
                    <TagChips tags={cert.tags} max={2} />
                  </div>
                </div>
              );
            }}
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
            file: items().find((c) => c.path === contextMenu.payload()),
            paths: contextMenu.payload() ? [contextMenu.payload()!] : [],
            onPreview: (cert) => openPreview(cert, { onDelete: loadAllCerts }),
            onEditInfo: (cert) =>
              openPreview(cert, { productSet: cert.productSet, editMetadata: true, onDelete: loadAllCerts }),
            onOpenDefault: (cert) => void api.files.openWithDefaultApp(cert.path),
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
          onMoved={() => void loadAllCerts()}
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
            void loadAllCerts();
            setSelectedPaths([]);
          }}
        />
      </Show>

      {/* 压缩分享 / 解压 进度（v2.4.4） */}
      <Show when={archiveState()}>
        <ArchiveProgressDialog token={archiveState()!.token} onClose={() => setArchiveState(null)} />
      </Show>

      {/* 删除确认（v2.4.7：替代 window.confirm） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除文件"
          message={`确定删除选中的 ${confirmDelete()!.paths.length} 个文件吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const paths = confirmDelete()!.paths;
            setConfirmDelete(null);
            void doDelete(paths);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
