import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import FileThumbnail from "~/components/FileThumbnail";
import VirtualGrid from "~/components/VirtualGrid";
import ConfirmDialog from "~/components/ConfirmDialog";
import EmptyState from "~/components/EmptyState";
import type { TrashEntry } from "~/types";

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
 * 原位置显示：按工作区根计算相对路径（与主进程 trash 恢复逻辑的 path.relative(ws, originalPath) 同口径）。
 * 覆盖 产品集/、客户/、发票/、入库/ 等一切根目录；分隔符归一化兼容 Windows。
 * 工作区根不可用时回退原始绝对路径。
 */
function relLocation(originalPath: string, wsRoot: string): string {
  if (!wsRoot) return originalPath;
  const norm = (p: string) => p.replace(/\\/g, "/");
  const op = norm(originalPath);
  const root = norm(wsRoot).replace(/\/+$/, "");
  if (op.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return op.slice(root.length + 1);
  }
  return originalPath;
}

// v2.4.6：回收站文件类型本地判断——与主进程 classifyFileType（src/main/core/paths.ts）语义一致。
// TrashEntry 不带 file_type；此前非 .pdf 一律按 "image" 传给 FileThumbnail，
// 视频/zip/文本全走图片缩略图 IPC 注定失败（视频抓帧/📎 占位才是正确路径）
function trashFileType(name: string): string {
  const idx = name.lastIndexOf(".");
  const ext = idx >= 0 ? name.slice(idx).toLowerCase() : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"].includes(ext)) return "video";
  return "other";
}

const KIND_META: Record<TrashEntry["kind"], { icon: string; label: string }> = {
  file: { icon: "📄", label: "文件" },
  subfolder: { icon: "🗂️", label: "子文件夹" },
  productSet: { icon: "📦", label: "产品集" },
  // v2.4.7：客户目录 kind（§4.4；图标对齐侧边栏「客户 🤝」）
  customer: { icon: "🤝", label: "客户" },
  // v2.4.9 S2：供应商目录 kind（完整供应商 UI 属 S2b；此处仅补闭合枚举所需条目）
  supplier: { icon: "🏭", label: "供应商" },
};

// v2.4.7（评审 P2，PERF-SOP §四）：回收站无上限——条目数超阈值改走 VirtualGrid 虚拟滚动（固定行高）
const TRASH_VIRTUAL_THRESHOLD = 200;
// 卡片高 ≈ 93px（p-4 上下 32px + 三行文本 61px，高于缩略图 56px）+ 行间距 8px，取整防重叠
const TRASH_ROW_HEIGHT = 104;

export default function Trash() {
  const [entries, setEntries] = createSignal<TrashEntry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [actionMsg, setActionMsg] = createSignal("");
  // v2.4.7：彻底删除 / 清空确认弹窗（替代 window.confirm；title/message 触发时算好，JSX 只读）
  const [confirmAction, setConfirmAction] = createSignal<{
    kind: "purge" | "empty";
    title: string;
    message: string;
    confirmLabel: string;
    id: string | null; // 仅 purge 使用
  } | null>(null);

  const loadTrash = async () => {
    const r = await api.trash.list();
    if (r.success && r.data) setEntries(r.data);
  };

  createEffect(() => {
    if (currentWorkspace()) loadTrash();
  });

  // v2.4.7（PERF-SOP §四）：setTimeout 存句柄 + onCleanup 清理——防卸载后 setActionMsg 触碰已销毁组件
  let actionTimer: number | undefined;
  const flash = (msg: string) => {
    setActionMsg(msg);
    window.clearTimeout(actionTimer);
    actionTimer = window.setTimeout(() => setActionMsg(""), 2500);
  };

  onCleanup(() => window.clearTimeout(actionTimer));

  const handleRestore = async (id: string) => {
    setBusy(true);
    const r = await api.trash.restore(id);
    setBusy(false);
    if (r.success) {
      flash("已恢复 ✓");
      loadTrash();
    } else {
      showToast("error", "恢复失败", r.error || "未知错误");
      loadTrash();
    }
  };

  const handlePurge = (id: string) => {
    // 确认后由 ConfirmDialog onConfirm 执行 doPurge
    setConfirmAction({
      kind: "purge",
      title: "彻底删除",
      message: "彻底删除后不可恢复，确定删除吗？",
      confirmLabel: "彻底删除",
      id,
    });
  };

  const doPurge = async (id: string) => {
    setBusy(true);
    const r = await api.trash.purge(id);
    setBusy(false);
    if (r.success) {
      flash("已彻底删除");
      loadTrash();
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  const handleEmpty = () => {
    const n = entries().length;
    if (n === 0) return;
    // 确认后由 ConfirmDialog onConfirm 执行 doEmpty
    setConfirmAction({
      kind: "empty",
      title: "清空回收站",
      message: `确定清空回收站（${n} 项）吗？将彻底删除且不可恢复。`,
      confirmLabel: "清空",
      id: null,
    });
  };

  const doEmpty = async () => {
    setBusy(true);
    const r = await api.trash.empty();
    setBusy(false);
    if (r.success) {
      flash("回收站已清空");
      loadTrash();
    } else {
      showToast("error", "清空失败", r.error || "未知错误");
    }
  };

  // v2.4.7：条目卡片渲染——小列表 For 与超阈值 VirtualGrid 共用（组件内函数，避免两份 JSX 漂移）
  const renderEntry = (e: TrashEntry) => (
    <div class="card p-4 flex items-center gap-4 hover:shadow-card-hover">
      {/* 缩略图（文件恢复回原路径后缓存命中；非图片/无缓存显示占位） */}
      <div class="w-14 h-14 rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden shrink-0">
        <Show
          when={e.kind === "file"}
          fallback={<span class="text-2xl">{KIND_META[e.kind].icon}</span>}
        >
          <FileThumbnail filePath={e.originalPath} fileType={trashFileType(e.name)} class="w-full h-full object-cover" />
        </Show>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-surface-900 truncate">{e.name}</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 shrink-0">
            {KIND_META[e.kind].label}
          </span>
        </div>
        <div class="text-xs text-surface-400 truncate mt-0.5">原位置：{relLocation(e.originalPath, currentWorkspace()?.path ?? "")}</div>
        <div class="text-xs text-surface-400 mt-0.5">
          删除于 {formatTime(e.deletedAt)} · {formatBytes(e.size)}
        </div>
      </div>
      <div class="flex gap-2 shrink-0">
        <button
          class="px-3 py-1.5 text-sm text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-lg transition-colors"
          onClick={() => handleRestore(e.id)}
          disabled={busy()}
        >
          ↺ 恢复
        </button>
        <button
          class="px-3 py-1.5 text-sm text-danger-600 hover:bg-danger-50 rounded-lg transition-colors"
          onClick={() => handlePurge(e.id)}
          disabled={busy()}
        >
          彻底删除
        </button>
      </div>
    </div>
  );

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">回收站</h1>
          <p class="text-surface-500 mt-1">
            删除的文件、子文件夹与产品集都在这里，可恢复或彻底删除（共 {entries().length} 项）
          </p>
        </div>
        <div class="flex items-center gap-3">
          <Show when={actionMsg()}>
            <span class="text-sm text-success-600">{actionMsg()}</span>
          </Show>
          <button
            class="btn-secondary text-sm text-danger-600 hover:bg-danger-50 hover:border-danger-200"
            onClick={handleEmpty}
            disabled={busy() || entries().length === 0}
          >
            🧹 清空回收站
          </button>
        </div>
      </div>

      <Show
        when={entries().length > 0}
        fallback={
          <EmptyState icon="🕳️" title="回收站是空的" desc="删除的文件会先移到这里，可随时恢复" />
        }
      >
        <Show
          when={entries().length > TRASH_VIRTUAL_THRESHOLD}
          fallback={
            <div class="space-y-2">
              <For each={entries()}>{(e) => renderEntry(e)}</For>
            </div>
          }
        >
          {/* v2.4.7（评审 P2）：超阈值走虚拟滚动——只渲染可见行，回收站条目数无上限 */}
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={entries()}
              itemHeight={TRASH_ROW_HEIGHT}
              columns={1}
              gap={8}
              renderItem={(e) => renderEntry(e)}
            />
          </div>
        </Show>
      </Show>

      {/* 彻底删除 / 清空确认（v2.4.7：替代 window.confirm） */}
      <Show when={confirmAction()}>
        <ConfirmDialog
          title={confirmAction()!.title}
          message={confirmAction()!.message}
          confirmLabel={confirmAction()!.confirmLabel}
          danger
          onConfirm={() => {
            const act = confirmAction()!;
            setConfirmAction(null);
            if (act.kind === "purge") void doPurge(act.id!);
            else void doEmpty();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      </Show>
    </div>
  );
}
