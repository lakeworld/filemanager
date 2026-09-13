import { Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  loadProductSets,
  productSets,
} from "~/stores/workspace";
import { customers, loadCustomers } from "~/stores/clients";
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { openFileSmart } from "~/stores/preview";
import { showToast } from "~/stores/notifyBanner";
// v2.5.8 D19（B1）：复制反馈统一（成功/失败都出声）
import { COPY_NOUN, copyFilesWithFeedback } from "~/utils/copyAction";
import { useCopyShortcut } from "~/hooks/useCopyShortcut";
import VirtualGrid from "~/components/VirtualGrid";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import BatchTagDialog from "~/components/BatchTagDialog";
import RenameDialog from "~/components/RenameDialog";
import SearchSelect, { type SearchSelectOption } from "~/components/ui/SearchSelect";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import TagChips from "~/components/TagChips";
import Modal from "~/components/ui/Modal";
import { handleDragOut } from "~/utils/dragout";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { fmtLocalTime } from "~/utils/datetime";
import { BUILTIN_NOTES_FOLDER } from "~/constants/notes";
import type { ContextMenuItem } from "~/components/ContextMenu";
import type { FileEntry, NoteEntryInfo } from "~/types";
import Input from "~/components/ui/Input";
import SelectionBar from "~/components/ui/SelectionBar";

/**
 * 笔记库（v2.5.7 A2 立项，v2.5.8 本批**全量对标图包库/证书库**）。
 *
 * 「文档就是笔记」契约不变：笔记 = 三域（产品集文档区 / 客户 / 供应商）内建「笔记」子文件夹里的 .md，
 * 无独立存储、无 index.json；数据源仍是 `api.notes.listRecent`（聚合口径与仪表盘统计卡同源）。
 *
 * 本批补的是「库页骨架」——此前只有一列平铺行 + 一个新建按钮，与其他库差一套筛选/多选/右键，
 * 现在与 `Images.tsx` / `Certs.tsx` 同构：搜索 + 域/实体/标签筛选 + 排序 + 计数与全选 +
 * VirtualGrid 卡片 + 多选操作条 + 右键菜单 + 重命名/删除/打标/复制/在文件夹中显示 + 拖拽出 + 空态加载态。
 *
 * 与其它库的两处刻意差异：
 * 1. 卡片用实底 `.card` 不加 `.card-glass`——走 `VirtualGrid` 的路径按 v2.5.8 D5 定的量级豁免回实底；
 * 2. 不做「压缩分享 / 移动到…」：单篇 .md 打包无意义，跨实体移动会让「笔记属于某实体」的语义漂移。
 */

const KIND_LABEL: Record<NoteEntryInfo["kind"], string> = {
  product_set: "产品集",
  customer: "客户",
  supplier: "供应商",
};

const KIND_ICON: Record<NoteEntryInfo["kind"], string> = {
  product_set: "📦",
  customer: "🤝",
  supplier: "🏭",
};

/** 域筛选选项（SearchSelect 用；「全部」用空串哨兵，与 Images/Certs 的原生 select 口径一致） */
const KIND_OPTIONS: readonly SearchSelectOption[] = [
  { value: "", label: "全部归属" },
  { value: "product_set", label: KIND_LABEL.product_set },
  { value: "customer", label: KIND_LABEL.customer },
  { value: "supplier", label: KIND_LABEL.supplier },
];

const SORT_OPTIONS: readonly SearchSelectOption[] = [
  { value: "modified", label: "按修改时间" },
  { value: "title", label: "按标题" },
  { value: "size", label: "按大小" },
];

/**
 * 一次取全量的上限（v2.5.8 库页化：原来只取 200 条「最近」，无法支撑筛选/全选语义）。
 * 超过上限时列表顶部如实提示「仅显示最近 N 条」，不假装是全量。
 */
const NOTE_LOAD_LIMIT = 1000;

// 代际守卫（照 Certs certLoadSeq / Images imageLoadSeq 先例，模块级）：
// 切工作区或重新挂载后，旧聚合链/标签池的迟到结果一律丢弃
let noteLoadSeq = 0;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function Notes() {
  const navigate = useNavigate();
  const [notes, setNotes] = createSignal<NoteEntryInfo[]>([]);
  const [loading, setLoading] = createSignal(true);
  // path → 标签（笔记是普通文件，标签住在既有 metadata 库里，按绝对路径取）
  const [tagMap, setTagMap] = createSignal<Record<string, string[]>>({});
  const [search, setSearch] = createSignal("");
  const [kindFilter, setKindFilter] = createSignal("");
  const [entityFilter, setEntityFilter] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");
  const [sortBy, setSortBy] = createSignal<"modified" | "title" | "size">("modified");
  const [selectedPaths, setSelectedPaths] = createSignal<string[]>([]);
  const [truncated, setTruncated] = createSignal(false);
  const contextMenu = useContextMenu<string[]>();

  // —— 弹窗与对话框状态 ——
  const [showNew, setShowNew] = createSignal(false);
  const [entityKind, setEntityKind] = createSignal<NoteEntryInfo["kind"]>("product_set");
  const [newEntity, setNewEntity] = createSignal("");
  const [newTitle, setNewTitle] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [renameTarget, setRenameTarget] = createSignal<NoteEntryInfo | null>(null);
  const [renameError, setRenameError] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [batchTagState, setBatchTagState] = createSignal<{ paths: string[]; commonTags: string[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<NoteEntryInfo[] | null>(null);

  onCleanup(() => {
    noteLoadSeq++;
  });

  createEffect(() => {
    if (currentWorkspace()) {
      // 新建笔记的归属下拉取正式列表（用户拍板：不产生游离笔记，也要能选到还没有笔记的实体）
      void loadProductSets();
      void loadCustomers();
      void loadSuppliers();
      void loadNotes();
    }
  });

  /** 标签批量拉取：8 并发 worker（照 Certs expiry 拉取先例），每轮取任务前校验代际 */
  const loadTags = async (list: NoteEntryInfo[], seq: number): Promise<void> => {
    const map: Record<string, string[]> = {};
    const queue = list.map((n) => n.path);
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        if (seq !== noteLoadSeq) return;
        const p = queue.shift()!;
        const r = await api.metadata.get(p);
        if (r.success && r.data?.tags?.length) map[p] = r.data.tags;
      }
    });
    await Promise.all(workers);
    if (seq !== noteLoadSeq) return;
    setTagMap(map);
  };

  const loadNotes = async (): Promise<void> => {
    if (!currentWorkspace()) return;
    const seq = ++noteLoadSeq;
    setLoading(true);
    try {
      const r = await api.notes.listRecent(null, NOTE_LOAD_LIMIT);
      if (seq !== noteLoadSeq) return;
      if (!r.success || !r.data) {
        showToast("error", "加载笔记失败", r.error || "未知错误");
        return;
      }
      setNotes(r.data);
      setTruncated(r.data.length >= NOTE_LOAD_LIMIT);
      setSelectedPaths([]);
      await loadTags(r.data, seq);
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (seq === noteLoadSeq) setLoading(false);
    }
  };

  const tagsOf = (n: NoteEntryInfo): string[] => tagMap()[n.path] ?? [];

  /** 笔记条目 → FileEntry 形状：直接复用预览链路与统一右键菜单，不另写一套 */
  const entryOf = (n: NoteEntryInfo): FileEntry => ({
    name: `${n.title}.md`,
    path: n.path,
    size: n.size,
    modified: n.mtime,
    // md 的 classifyFileType 就是 'other'（shared types 枚举零改动，D21）；预览分流按扩展名判 md
    file_type: "other",
    thumbnail_path: null,
    tags: tagsOf(n),
  });

  // —— 筛选选项 ——
  /** 实体下拉：当前域下「有笔记的实体」∩ 正式列表（正式列表在，但没笔记的实体筛出来必空，不进选项） */
  const entityOptions = createMemo<readonly SearchSelectOption[]>(() => {
    const formal = new Set<string>(
      kindFilter() === "customer"
        ? apiEntityNames("customer")
        : kindFilter() === "supplier"
          ? apiEntityNames("supplier")
          : kindFilter() === "product_set"
            ? apiEntityNames("product_set")
            : [...apiEntityNames("product_set"), ...apiEntityNames("customer"), ...apiEntityNames("supplier")],
    );
    const counts = new Map<string, number>();
    for (const n of notes()) {
      if (kindFilter() && n.kind !== kindFilter()) continue;
      counts.set(n.entity, (counts.get(n.entity) ?? 0) + 1);
    }
    const list = [...counts.entries()]
      // 正式列表为空（客户/供应商 store 还没回来）时不因它把选项全滤掉——退化为「有笔记即可选」
      .filter(([name]) => formal.size === 0 || formal.has(name))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [
      { value: "", label: "全部实体" },
      ...list.map(([name, count]) => ({ value: name, label: name, hint: `${count}` })),
    ];
  });

  const tagOptions = createMemo<readonly SearchSelectOption[]>(() => {
    const set = new Set<string>();
    for (const n of notes()) for (const t of tagsOf(n)) set.add(t);
    return [
      { value: "", label: "全部标签" },
      ...[...set].sort((a, b) => a.localeCompare(b)).map((t) => ({ value: t, label: t })),
    ];
  });

  const kindOfSelected = () => {
    const p = new Set(selectedPaths());
    return notes().filter((n) => p.has(n.path));
  };

  const filtered = createMemo(() => {
    const term = search().trim().toLowerCase();
    const kind = kindFilter();
    const entity = entityFilter();
    const tag = tagFilter();
    let list = notes().filter((n) => {
      if (kind && n.kind !== kind) return false;
      if (entity && n.entity !== entity) return false;
      if (tag && !tagsOf(n).includes(tag)) return false;
      if (term && !n.title.toLowerCase().includes(term) && !n.entity.toLowerCase().includes(term)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sortBy()) {
        case "title":
          return a.title.localeCompare(b.title);
        case "size":
          return b.size - a.size;
        case "modified":
        default:
          return b.mtime.localeCompare(a.mtime); // ISO 串字典序 == 时间序
      }
    });
    return list;
  });

  const toggleSelection = (path: string) => {
    setSelectedPaths((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  };
  const selectAllVisible = () => setSelectedPaths(filtered().map((n) => n.path));
  const clearSelection = () => setSelectedPaths([]);
  const selectedCount = () => selectedPaths().length;
  const visibleCount = () => filtered().length;

  // —— 动作 ——
  /** 双击/菜单「编辑笔记」：走全站同一预览链路（md → 弹窗内嵌 NoteEditorModal，编辑即保存） */
  const openNote = (n: NoteEntryInfo) => void openFileSmart(entryOf(n), { onDelete: () => void loadNotes() });

  /** 「在文件区中打开」= v2.5.7 的深链链路保留（文件区命中 `?note=` 直开编辑器），两条入口并存不互相顶掉 */
  const openInFileBrowser = (n: NoteEntryInfo) => {
    const seg = n.kind === "product_set" ? "doc" : n.kind;
    navigate(
      `/files/${seg}/${encodeURIComponent(n.entity)}/${encodeURIComponent(BUILTIN_NOTES_FOLDER)}?note=${encodeURIComponent(`${n.title}.md`)}`,
    );
  };

  // v2.5.8 D19（B1）：复制反馈口径统一到全局 toast（原先成功走本页 2s 内联条，
  // 而内联条挂在 ui/SelectionBar 上、只有选中时才存在 ⇒ 右键单选复制看不见反馈）
  const handleCopy = (paths: string[]): void => {
    void copyFilesWithFeedback(api.files.copyFilesToClipboard, paths, COPY_NOUN.note);
  };

  // v2.5.8 D19（B2）：本页有选中态 ⇒ Ctrl+C 必须接管（此前只有文件浏览器有，笔记库按了没反应）
  useCopyShortcut(selectedPaths, handleCopy);

  const handleShowInExplorer = async (paths: string[]) => {
    if (paths.length === 0) return;
    const r = await api.files.showFilesInExplorer(paths);
    if (!r.success) showToast("error", "打开文件夹失败", r.error || "未知错误");
  };

  const handleDelete = (paths: string[]) => {
    if (paths.length === 0) return;
    setConfirmDelete(kindOfSelected().filter((n) => paths.includes(n.path)));
  };

  const doDelete = async (list: NoteEntryInfo[]) => {
    const r = await api.files.delete(list.map((n) => n.path));
    if (r.success) {
      setSelectedPaths([]);
      void loadNotes();
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  const handleRename = (n: NoteEntryInfo) => {
    setRenameError("");
    setRenameTarget(n);
  };

  const doRename = async (rawName: string) => {
    const n = renameTarget();
    if (!n) return;
    // 标题即文件名：补回 .md 后缀（RenameDialog 编辑的是完整文件名，缺后缀则补上）
    const newName = /\.md$/i.test(rawName) ? rawName : `${rawName}.md`;
    setRenameBusy(true);
    setRenameError("");
    try {
      const r = await api.files.rename({ path: n.path, newName });
      if (r.success) {
        setRenameTarget(null);
        setSelectedPaths([]);
        void loadNotes();
      } else {
        setRenameError(r.error || "未知错误");
      }
    } finally {
      setRenameBusy(false);
    }
  };

  const commonTagsOf = (paths: string[]) => {
    const lists = paths.map((p) => tagMap()[p] ?? []);
    if (lists.length === 0) return [];
    return lists[0].filter((t) => lists.every((l) => l.includes(t)));
  };
  const handleBatchTag = (paths: string[]) => setBatchTagState({ paths, commonTags: commonTagsOf(paths) });

  /** 三域正式实体列表（新建归属下拉与实体筛选的候选源；用户拍板 B9：不从「已有笔记」反推） */
  function apiEntityNames(kind: NoteEntryInfo["kind"]): string[] {
    if (kind === "product_set") return productSets().map((p) => p.name);
    if (kind === "customer") return customers().map((c) => c.name);
    return suppliers().map((s) => s.name);
  }

  const noteByPath = (p: string): NoteEntryInfo | undefined => notes().find((n) => n.path === p);
  /** 右键菜单主条目（单选时给 builder 当 file；多选或未命中则 undefined，单文件项自动隐藏） */
  const ctxFile = createMemo(() => {
    const p = (contextMenu.payload() ?? [])[0];
    const n = p ? noteByPath(p) : undefined;
    return n ? entryOf(n) : undefined;
  });

  /**
   * 笔记右键菜单 = 统一 builder 的产物 + 一条「在文件区中打开」（仅单选）。
   * builder 是全站共用的固定顺序，不为了本页去改它；这里在「编辑笔记/预览」之后插一条，
   * 保住 v2.5.7 的深链链路（文件区命中 `?note=` 直开编辑器）不因站内编辑器而消失。
   */
  const noteMenuItems = createMemo<ContextMenuItem[]>(() => {
    const paths = contextMenu.payload() ?? [];
    const base = buildFileContextMenuItems({
      file: ctxFile(),
      paths,
      onPreview: (e) => {
        const n = noteByPath(e.path);
        if (n) openNote(n);
      },
      onOpenDefault: (e) => void api.files.openWithDefaultApp(e.path),
      onCopy: handleCopy,
      onShowInExplorer: handleShowInExplorer,
      onRename: (e) => {
        const n = noteByPath(e.path);
        if (n) handleRename(n);
      },
      onBatchTag: handleBatchTag,
      onDelete: handleDelete,
    });
    if (paths.length !== 1) return base;
    const n = noteByPath(paths[0]);
    if (!n) return base;
    const at = base.findIndex((i) => i.label === "编辑笔记" || i.label === "预览");
    base.splice(at < 0 ? base.length : at + 1, 0, {
      label: "在文件区中打开",
      icon: "🗂",
      action: () => openInFileBrowser(n),
    });
    return base;
  });

  const newEntityOptions = createMemo<readonly SearchSelectOption[]>(() =>
    apiEntityNames(entityKind()).map((name) => ({ value: name, label: name })),
  );

  const createNote = async () => {
    if (creating()) return;
    const t = newTitle().trim();
    const entity = newEntity().trim();
    if (!t || !entity) return;
    setCreating(true);
    try {
      const fileName = t.endsWith(".md") ? t : `${t}.md`;
      // 物理路径与 core/notes.ts 三域口径一致（产品集在文档区下，客户/供应商在实体根下）
      const rel =
        entityKind() === "product_set"
          ? `产品集/${entity}/文档/笔记/${fileName}`
          : entityKind() === "customer"
            ? `客户/${entity}/笔记/${fileName}`
            : `供应商/${entity}/笔记/${fileName}`;
      const r = await api.files.writeText(rel, `# ${t.replace(/\.md$/i, "")}\n\n`);
      if (!r.success) {
        showToast("error", "新建笔记失败", r.error ?? undefined);
        return;
      }
      setShowNew(false);
      setNewTitle("");
      await loadNotes();
      const created = notes().find((n) => n.path.endsWith(`/${fileName}`) && n.entity === entity);
      if (created) openNote(created);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">笔记库</h1>
          <p class="text-surface-500 mt-1">三域笔记（产品集 / 客户 / 供应商；编辑即保存为 .md）</p>
        </div>
        <button class="btn-primary" onClick={() => setShowNew(true)}>
          📝 新建笔记
        </button>
      </div>

      {/* 筛选行（SearchSelect：本组件 v2.5.8 W4 提前投产，这两个库页是首批使用者）。
          响应式与 Certs 同口径：flex-wrap + 各控件收缩下限，防窄窗口把搜索框压扁并撑出横向滚动条。 */}
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <Input
        class="w-full min-w-0 md:w-auto md:flex-1 md:min-w-[180px]"
          placeholder="搜索标题或归属…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <SearchSelect
          class="min-w-[112px] md:w-36"
          compact
          ariaLabel="归属域筛选"
          options={KIND_OPTIONS}
          value={kindFilter()}
          searchable={false}
          matchTriggerWidth={false}
          onChange={(v) => {
            setKindFilter(v);
            setEntityFilter(""); // 域变了实体候选也变，先回「全部实体」
          }}
        />
        <SearchSelect
          class="min-w-[112px] md:w-44"
          compact
          ariaLabel="归属实体筛选"
          options={entityOptions()}
          value={entityFilter()}
          matchTriggerWidth={false}
          placeholder="全部实体"
          emptyText="该域下暂无带笔记的实体"
          onChange={setEntityFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="标签筛选"
          options={tagOptions()}
          value={tagFilter()}
          matchTriggerWidth={false}
          emptyText="暂无已打标的笔记"
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
          onChange={(v) => setSortBy(v as "modified" | "title" | "size")}
        />
      </div>

      {/* 多选操作条：底部**悬浮**浮条（W5 形态），不进文档流。
          为什么这里不像 Images/Certs 那样内嵌在列表上方——实测内嵌条插入会把网格整体下移 ~68px，
          用户「单击选中 → 再单击/双击」的第二次点击就落到上边的计数行上，双击开编辑直接丢失
          （e2e 事件轨迹抓实）。浮条不改变布局，两条动作互不干扰；D10 全站收口时同形态复用它。 */}
      {/* v2.5.8 D10（W5）：本条就是浮条悬浮形态的出处（W4/W5 插单时只落了笔记库一页），
          现收进 `ui/SelectionBar` 全站共用；动作与文案一字未改，`w-max` 等定位口径搬进组件。 */}
      <SelectionBar
        count={selectedCount()}
        noun="篇笔记"
        onClear={clearSelection}
        onSelectAll={selectAllVisible}
        onDelete={() => handleDelete(selectedPaths())}
        actions={[
          { label: "📋 复制", tone: "primary", onClick: () => void handleCopy(selectedPaths()) },
          { label: "📂 在文件夹中显示", onClick: () => void handleShowInExplorer(selectedPaths()) },
          { label: "🏷️ 打标", onClick: () => handleBatchTag(selectedPaths()) },
          { label: "🗑️ 删除", tone: "danger", onClick: () => handleDelete(selectedPaths()) },
        ]}
      />

      <Show when={visibleCount() > 0 || loading()} fallback={
        <Show when={!loading()} fallback={<Loading text="笔记加载中…" />}>
          <EmptyState
            icon="📝"
            title={notes().length === 0 ? "还没有笔记" : "没有符合筛选的笔记"}
            desc={
              notes().length === 0
                ? "在产品集 / 客户 / 供应商的「笔记」文件夹新建第一篇笔记"
                : "换个关键词，或把归属/实体/标签筛选清空"
            }
          />
        </Show>
      }>
        <div class="flex items-center justify-between mb-3 shrink-0">
          <span class="text-sm text-surface-500">
            {visibleCount()} 篇笔记
            <Show when={truncated()}>
              <span class="text-warning-600"> · 仅显示最近 {NOTE_LOAD_LIMIT} 条</span>
            </Show>
          </span>
          <button class="link-btn text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
            全选当前结果
          </button>
        </div>
        {/* v2.5.8 D10：留白改为**有选中才留**（原先常驻，会在未选中态白扣 96px 视口）。
            VirtualGrid 是 h-full 的独立滚动区，父级扣掉一个条高，最后一行就永远在浮条之上。 */}
        <div
          data-selection-bar-pad
          class={`flex-1 min-h-0 ${selectedCount() > 0 ? "pb-24" : ""}`}
        >
          <Show when={!loading()} fallback={<Loading text="笔记加载中…" />}>
            <VirtualGrid
              items={filtered()}
              // 行高按出档像素实测校准：初版估 172，实拍卡片内容只有 ~92（两行标题 + 标签换行
              // 的最坏情形 ≈ 134）——VirtualGrid 的行是 align-content:start，卡片按内容取高，
              // 行高给大了就是每行一条空隙。
              itemHeight={140}
              columns={{ base: 1, md: 2, lg: 3, xl: 4 }}
              gap={14}
              // 筛选/搜索变化滚动归零（照 Quotes/Invoices/Certs scrollResetKey 先例）
              scrollResetKey={`${search()}|${kindFilter()}|${entityFilter()}|${tagFilter()}|${sortBy()}`}
              renderItem={(n) => (
                <div
                  class={`card p-3 min-h-[118px] flex flex-col gap-1.5 cursor-pointer select-none relative overflow-hidden ${
                    selectedPaths().includes(n.path) ? "card-selected" : ""
                  }`}
                  draggable={true}
                  onDragStart={(e) => handleDragOut(e, n.path, selectedPaths())}
                  onContextMenu={(e) => {
                    const paths = selectedPaths().includes(n.path) ? selectedPaths() : [n.path];
                    if (!selectedPaths().includes(n.path)) setSelectedPaths([n.path]);
                    contextMenu.open(e, paths);
                  }}
                  onClick={() => toggleSelection(n.path)}
                  onDblClick={() => openNote(n)}
                  data-note-card={n.relPath}
                >
                  {/* 左侧域色带：一眼分产品集/客户/供应商（替代原「emoji 底框」占位） */}
                  <span
                    class={`absolute left-0 top-0 bottom-0 w-1 ${
                      n.kind === "product_set" ? "bg-primary-400" : n.kind === "customer" ? "bg-warning-400" : "bg-success-400"
                    }`}
                  />
                  <div class="flex items-center gap-2 pl-1">
                    <input
                      type="checkbox"
                      class="w-4 h-4 shrink-0 accent-primary-600 cursor-pointer"
                      checked={selectedPaths().includes(n.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelection(n.path)}
                    />
                    <span class="text-xs shrink-0">{KIND_ICON[n.kind]}</span>
                    <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 shrink-0">
                      {KIND_LABEL[n.kind]}
                    </span>
                    <span class="text-xs text-surface-400 truncate">{n.entity}</span>
                  </div>
                  <div class="text-sm font-medium text-surface-900 pl-1 line-clamp-2">{n.title}</div>
                  <TagChips tags={tagsOf(n)} max={2} />
                  <div class="mt-auto pl-1 text-[11px] text-surface-400 tabular-nums truncate">
                    {formatBytes(n.size)} · {fmtLocalTime(n.mtime)}
                  </div>
                </div>
              )}
            />
          </Show>
        </div>
      </Show>

      {/* 右键菜单：统一 builder + 站内深链项（实现见 noteMenuItems） */}
      <Show when={contextMenu.show()}>
        <ContextMenu
          x={contextMenu.x()}
          y={contextMenu.y()}
          onClose={contextMenu.close}
          items={noteMenuItems()}
        />
      </Show>

      {/* 重命名（标题即文件名） */}
      <Show when={renameTarget()}>
        <RenameDialog
          currentName={`${renameTarget()!.title}.md`}
          busy={renameBusy()}
          error={renameError()}
          onConfirm={(n) => void doRename(n)}
          onCancel={() => setRenameTarget(null)}
        />
      </Show>

      {/* 批量打标（与图包/证书同一弹窗，标签库共用） */}
      <Show when={batchTagState()}>
        <BatchTagDialog
          paths={batchTagState()!.paths}
          commonTags={batchTagState()!.commonTags}
          onClose={() => setBatchTagState(null)}
          onDone={() => {
            void loadNotes();
            setSelectedPaths([]);
          }}
        />
      </Show>

      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除笔记"
          message={`确定删除选中的 ${confirmDelete()!.length} 篇笔记吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const list = confirmDelete()!;
            setConfirmDelete(null);
            void doDelete(list);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>

      {/* 新建笔记：归属域 + 归属实体（正式列表）+ 标题——不产生游离笔记，必须选归属 */}
      <Show when={showNew()}>
        <Modal
          open
          title="新建笔记"
          subtitle="笔记是挂在归属实体下的 .md，编辑即保存"
          size="md"
          framed
          onClose={() => setShowNew(false)}
          footer={
            <>
              <button class="btn-secondary" onClick={() => setShowNew(false)}>
                取消
              </button>
              <button
                class="btn-primary"
                disabled={creating() || !newEntity().trim() || !newTitle().trim()}
                onClick={() => void createNote()}
              >
                创建并编辑
              </button>
            </>
          }
        >
          <div class="dlg-field">
            <label class="dlg-label">归属域</label>
            <div class="flex gap-2">
                {(["product_set", "customer", "supplier"] as const).map((k) => (
                  <button
                    class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      entityKind() === k
                        ? "card-selected text-primary-700"
                        : "border-surface-200 text-surface-600 hover:bg-surface-50"
                    }`}
                    onClick={() => {
                      setEntityKind(k);
                      setNewEntity("");
                    }}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
            </div>
          </div>
          <div class="dlg-field">
            <label class="dlg-label">归属实体</label>
            <SearchSelect
              class="w-full"
              ariaLabel="归属实体"
              options={newEntityOptions()}
              value={newEntity()}
              placeholder={
                entityKind() === "product_set" ? "选择产品集" : entityKind() === "customer" ? "选择客户" : "选择供应商"
              }
              emptyText="还没有该域实体，请先在对应库新建实体"
              onChange={setNewEntity}
            />
          </div>
          <div class="dlg-field">
            <label class="dlg-label dlg-required">笔记标题</label>
            <Input
            class="w-full"
              placeholder="保存为 <标题>.md"
              value={newTitle()}
              disabled={creating()}
              onInput={(e) => setNewTitle(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void createNote()}
            />
          </div>
        </Modal>
      </Show>
    </div>
  );
}
