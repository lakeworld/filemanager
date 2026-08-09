import { Show, For, createSignal, createEffect } from "solid-js";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import FileThumbnail from "~/components/FileThumbnail";
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

/** 原位置显示：截取「产品集/...」之后的部分（相对工作区） */
function relLocation(originalPath: string): string {
  const idx = originalPath.indexOf("产品集/");
  return idx >= 0 ? originalPath.slice(idx) : originalPath;
}

const KIND_META: Record<TrashEntry["kind"], { icon: string; label: string }> = {
  file: { icon: "📄", label: "文件" },
  subfolder: { icon: "🗂️", label: "子文件夹" },
  productSet: { icon: "📦", label: "产品集" },
};

export default function Trash() {
  const [entries, setEntries] = createSignal<TrashEntry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [actionMsg, setActionMsg] = createSignal("");

  const loadTrash = async () => {
    const r = await api.trash.list();
    if (r.success && r.data) setEntries(r.data);
  };

  createEffect(() => {
    if (currentWorkspace()) loadTrash();
  });

  const flash = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(""), 2500);
  };

  const handleRestore = async (id: string) => {
    setBusy(true);
    const r = await api.trash.restore(id);
    setBusy(false);
    if (r.success) {
      flash("已恢复 ✓");
      loadTrash();
    } else {
      window.alert(r.error || "恢复失败");
      loadTrash();
    }
  };

  const handlePurge = async (id: string) => {
    if (!window.confirm("彻底删除后不可恢复，确定删除吗？")) return;
    setBusy(true);
    const r = await api.trash.purge(id);
    setBusy(false);
    if (r.success) {
      flash("已彻底删除");
      loadTrash();
    } else {
      window.alert(r.error || "删除失败");
    }
  };

  const handleEmpty = async () => {
    const n = entries().length;
    if (n === 0) return;
    if (!window.confirm(`确定清空回收站（${n} 项）吗？将彻底删除且不可恢复。`)) return;
    setBusy(true);
    const r = await api.trash.empty();
    setBusy(false);
    if (r.success) {
      flash("回收站已清空");
      loadTrash();
    } else {
      window.alert(r.error || "清空失败");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">回收站</h1>
          <p class="text-surface-500 mt-1">
            删除的文件、子文件夹与产品集都在这里，可恢复或彻底删除（共 {entries().length} 项）
          </p>
        </div>
        <div class="flex items-center gap-3">
          <Show when={actionMsg()}>
            <span class="text-sm text-green-600">{actionMsg()}</span>
          </Show>
          <button
            class="btn-secondary text-sm text-red-600 hover:bg-red-50 hover:border-red-200"
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
        <div class="space-y-2">
          <For each={entries()}>
            {(e) => (
              <div class="card p-4 flex items-center gap-4 hover:shadow-card-hover transition-all">
                {/* 缩略图（文件恢复回原路径后缓存命中；非图片/无缓存显示占位） */}
                <div class="w-14 h-14 rounded-lg bg-surface-100 flex items-center justify-center overflow-hidden shrink-0">
                  <Show
                    when={e.kind === "file"}
                    fallback={<span class="text-2xl">{KIND_META[e.kind].icon}</span>}
                  >
                    <FileThumbnail filePath={e.originalPath} fileType={e.originalPath.toLowerCase().endsWith(".pdf") ? "pdf" : "image"} class="w-full h-full object-cover" />
                  </Show>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-surface-900 truncate">{e.name}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 shrink-0">
                      {KIND_META[e.kind].label}
                    </span>
                  </div>
                  <div class="text-xs text-surface-400 truncate mt-0.5">原位置：{relLocation(e.originalPath)}</div>
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
                    class="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    onClick={() => handlePurge(e.id)}
                    disabled={busy()}
                  >
                    彻底删除
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
