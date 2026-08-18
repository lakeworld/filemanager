import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import ConfirmDialog from "~/components/ConfirmDialog";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import VirtualGrid from "~/components/VirtualGrid";
import type { ExportEntry } from "~/types";

// v2.5.3（P2-15）：导出记录渲染口径——<200 条 For 全量、≥200 条 VirtualGrid 虚拟滚动（照 Trash/Suppliers 先例，阈值统一 200）
const EXPORT_VIRTUAL_THRESHOLD = 200;
// 卡片高 ≈ p-4 上下 32px + 图标 56（高于两行文本 ~40px）≈ 88px，行间距 8px 计入 itemHeight（估算取整防重叠）
const EXPORT_ROW_HEIGHT = 96;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/**
 * 导出区（v2.4.8）：展示 工作区/导出/ 下的压缩分享产物（zip）。
 * 操作复用现有文件 API：打开（默认程序）/ 在文件夹中显示 / 删除（移入回收站，可恢复）。
 */
export default function Exports() {
  const [entries, setEntries] = createSignal<ExportEntry[]>([]);
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例）
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [actionMsg, setActionMsg] = createSignal("");
  // 删除确认弹窗（替代原生 confirm；title/message 触发时算好，JSX 只读）
  const [confirmDelete, setConfirmDelete] = createSignal<{ entry: ExportEntry } | null>(null);

  const loadExports = async () => {
    setLoading(true);
    try {
      const r = await api.exports.list();
      if (r.success && r.data) setEntries(r.data);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) loadExports();
  });

  let actionTimer: number | undefined;
  const flash = (msg: string) => {
    setActionMsg(msg);
    window.clearTimeout(actionTimer);
    actionTimer = window.setTimeout(() => setActionMsg(""), 2500);
  };
  onCleanup(() => window.clearTimeout(actionTimer));

  const handleOpen = async (e: ExportEntry) => {
    const r = await api.files.openWithDefaultApp(e.path);
    if (!r.success) showToast("error", "打开失败", r.error || "未知错误");
  };

  const handleReveal = async (e: ExportEntry) => {
    const r = await api.files.showFilesInExplorer([e.path]);
    if (!r.success) showToast("error", "定位失败", r.error || "未知错误");
  };

  const doDelete = async (e: ExportEntry) => {
    setBusy(true);
    const r = await api.files.delete([e.path]);
    setBusy(false);
    if (r.success && (r.data?.failed.length ?? 0) === 0) {
      flash("已删除（可在回收站恢复）");
      loadExports();
    } else {
      showToast("error", "删除失败", r.error || (r.data?.failed.length ? "部分文件删除失败" : "未知错误"));
    }
  };

  // v2.5.3（P2-15）：条目卡片渲染——小列表 For 与超阈值 VirtualGrid 共用（照 Trash renderEntry 模式，避免两份 JSX 漂移）
  const renderEntry = (e: ExportEntry) => (
    <div class="card p-4 flex items-center gap-4 hover:shadow-card-hover">
      <div class="w-14 h-14 rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden shrink-0">
        <span class="text-2xl">🗜️</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-surface-900 truncate">{e.name}</div>
        <div class="text-xs text-surface-400 mt-0.5">
          {formatBytes(e.size)} · 生成于 {formatTime(e.mtime)}
        </div>
      </div>
      <div class="flex gap-2 shrink-0">
        <button
          class="px-3 py-1.5 text-sm text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors"
          onClick={() => handleOpen(e)}
        >
          打开
        </button>
        <button
          class="px-3 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
          onClick={() => handleReveal(e)}
        >
          定位
        </button>
        <button
          class="px-3 py-1.5 text-sm text-danger-600 hover:bg-danger-50 rounded-lg transition-colors"
          onClick={() => setConfirmDelete({ entry: e })}
          disabled={busy()}
        >
          删除
        </button>
      </div>
    </div>
  );

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">导出</h1>
          <p class="text-surface-500 mt-1">
            压缩分享的产物都在这里（共 {entries().length} 项），可打开、定位或删除
          </p>
        </div>
        <Show when={actionMsg()}>
          <span class="text-sm text-success-600">{actionMsg()}</span>
        </Show>
      </div>

      <Show
        when={entries().length > 0}
        fallback={
          // v2.5.2：首载 loading 兜底，空态不闪现
          <Show when={!loading()} fallback={<Loading text="导出区加载中…" />}>
            <EmptyState icon="📤" title="暂无导出文件" desc="压缩分享的产物会出现在这里" />
          </Show>
        }
      >
        <Show
          when={entries().length >= EXPORT_VIRTUAL_THRESHOLD}
          fallback={
            <div class="space-y-2">
              <For each={entries()}>{(e) => renderEntry(e)}</For>
            </div>
          }
        >
          {/* v2.5.3（P2-15）：≥200 条走虚拟滚动——只渲染可见行，导出记录数无上限（照 Trash 先例） */}
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={entries()}
              itemHeight={EXPORT_ROW_HEIGHT}
              columns={1}
              gap={8}
              renderItem={(e) => renderEntry(e)}
            />
          </div>
        </Show>
      </Show>

      {/* 删除确认（删除会移入回收站，可恢复） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除导出文件"
          message={`确定删除「${confirmDelete()!.entry.name}」吗？文件会移入回收站，可随时恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const target = confirmDelete()!.entry;
            setConfirmDelete(null);
            void doDelete(target);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </div>
  );
}
