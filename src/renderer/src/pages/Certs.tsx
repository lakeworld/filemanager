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
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import type { FileEntry, ProductSetInfo } from "~/types";

interface CertItem extends FileEntry {
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

// v2.4.2：loadAllCerts 代数守卫——切工作区后丢弃过期请求的返回，防止旧结果覆盖新数据
let certLoadSeq = 0;

export default function Certs() {
  const navigate = useNavigate();
  const [items, setItems] = createSignal<CertItem[]>([]);
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

  // —— 虚拟滚动由 VirtualGrid 承担：只渲染可见行，滚出即卸载（替代旧 slice+哨兵分批）——
  // 证书卡片为横向布局，固定行高（v2.4.4：加标签 chips 行后抬高，避免行重叠）
  const ITEM_HEIGHT = 152;

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
      loadProductSets();
      loadTagDefs();
    }
  });

  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  const loadAllCerts = async () => {
    if (!currentWorkspace()) return;
    const seq = ++certLoadSeq;
    const result = await api.productSets.list();
    if (!result.success || !result.data) return;
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
        const p = queue.shift()!;
        const r = await api.metadata.get(p);
        if (r.success && r.data?.expiry_date) map[p] = r.data.expiry_date;
      }
    });
    await Promise.all(workers);
    if (seq !== certLoadSeq) return;
    setExpiries(map);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadAllCerts();
    }
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

  const handleRename = async (file: CertItem) => {
    const newName = window.prompt("请输入新文件名：", file.name);
    if (!newName || newName.trim() === "" || newName.trim() === file.name) return;
    const result = await api.files.rename({ path: file.path, newName: newName.trim() });
    if (result.success) {
      setSelectedPaths([]);
      loadAllCerts();
    } else {
      showToast("error", "重命名失败", result.error || "未知错误");
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
          <For each={certFolders()}>
            {(folder) => <option value={folder}>{folder}</option>}
          </For>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          value={tagFilter()}
          onChange={(e) => setTagFilter(e.currentTarget.value)}
        >
          <option value="">全部标签</option>
          <For each={tagList()}>
            {(t) => <option value={t.name}>{tagLabel(t.name)}</option>}
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
            <button class="px-3 py-1.5 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg" onClick={() => handleDelete(selectedPaths())}>
              🗑️ 删除
            </button>
          </div>
        </div>
      </Show>

      <Show when={visibleCount() > 0} fallback={
        <EmptyState icon="📜" title="暂无证书" desc="导入证书到产品集中" />
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
            columns={{ base: 1, md: 2, lg: 3 }}
            gap={12}
            renderItem={(cert) => (
              <div
                class={`card p-4 flex items-center gap-4 cursor-pointer select-none hover:shadow-card-hover transition-all ${selectedPaths().includes(cert.path) ? "border-primary-500 bg-primary-50" : ""}`}
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
                <div class="w-12 h-12 rounded-lg bg-orange-50 flex items-center justify-center text-2xl overflow-hidden shrink-0">
                  <FileThumbnail filePath={cert.path} fileType={cert.file_type} class="w-full h-full object-cover" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{cert.name}</div>
                  <div class="text-xs text-surface-400 mt-1">{cert.productSet} / {cert.subFolder}</div>
                  <div class="text-xs text-surface-400">{formatBytes(cert.size)} · {cert.modified}</div>
                  <Show when={expiryInfo(cert.path)}>
                    {(info) => (
                      <div class={`text-xs mt-1 ${info().urgent ? "text-red-600 font-medium" : "text-amber-600"}`}>
                        ⚠️ {info().label}
                      </div>
                    )}
                  </Show>
                  <TagChips tags={cert.tags} />
                </div>
                <input
                  type="checkbox"
                  class="w-4 h-4 accent-primary-600 cursor-pointer shrink-0"
                  checked={selectedPaths().includes(cert.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelection(cert.path)}
                />
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
