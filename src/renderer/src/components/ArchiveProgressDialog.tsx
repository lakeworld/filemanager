import { Show, createSignal, onMount, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import type { ArchiveEventPayload, ArchiveProgress, ArchiveResult } from "~/types";

type ArchivePhase = "compress" | "extract";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * 压缩分享 / 解压 进度弹窗（v2.4.4）。
 * props 只收 token（调用方生成）与 onClose；阶段（compress/extract）与进度
 * 全部来自主进程 archive:progress 事件，完成后经 archive:complete 事件收口：
 * - success → 阶段文案换「完成」，提供「打开所在文件夹」/「复制到剪贴板」（仅压缩产物 zip）
 *   /「关闭」，不自动关闭；
 * - failed/cancelled → toast 提示后自动关闭（onClose）。
 * 取消按钮调用 api.archive.cancel(token)，点击后置「取消中…」防连点。
 */
export default function ArchiveProgressDialog(props: { token: string; onClose: () => void }) {
  const [phase, setPhase] = createSignal<ArchivePhase | null>(null);
  const [progress, setProgress] = createSignal<{ done: number; total: number; current: string } | null>(null);
  const [status, setStatus] = createSignal<"running" | "success">("running");
  const [result, setResult] = createSignal<ArchiveResult | null>(null);
  const [cancelling, setCancelling] = createSignal(false);

  onMount(() => {
    // 收尾轮：Esc 关闭——进行中不允许（只能走取消，与遮罩点击规则一致）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (status() === "success") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    const unsubProgress = window.qihebox.events.on("archive:progress", (data) => {
      const p = data as ArchiveProgress;
      if (!p || typeof p !== "object") return;
      if (p.phase === "compress" || p.phase === "extract") setPhase(p.phase);
      if (typeof p.done === "number" && typeof p.total === "number") {
        setProgress({ done: p.done, total: p.total, current: typeof p.current === "string" ? p.current : "" });
      }
    });
    const unsubComplete = window.qihebox.events.on("archive:complete", (data) => {
      const payload = data as ArchiveEventPayload;
      if (!payload || typeof payload !== "object") return;
      if (payload.success) {
        setStatus("success");
        setResult(payload.result ?? null);
        return;
      }
      // failed / cancelled：toast 提示后自动关闭（complete 事件不自动关弹窗仅指成功场景）
      if (payload.cancelled) {
        showToast("error", `${phaseName()}已取消`);
      } else {
        showToast("error", `${phaseName()}失败`, payload.error || undefined);
      }
      props.onClose();
    });
    onCleanup(() => {
      unsubProgress();
      unsubComplete();
    });
  });

  /** 阶段名（未知阶段时用通用「操作」） */
  const phaseName = (): string => {
    switch (phase()) {
      case "compress":
        return "压缩";
      case "extract":
        return "解压";
      default:
        return "操作";
    }
  };

  /** 进行中阶段文案 */
  const phaseText = (): string => {
    if (status() === "success") return "完成";
    switch (phase()) {
      case "compress":
        return "正在压缩…";
      case "extract":
        return "正在解压…";
      default:
        return "正在处理…";
    }
  };

  const percent = (): number => {
    const p = progress();
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  };

  /** 是否压缩场景产物（zip 路径）——决定「复制到剪贴板」按钮是否显示 */
  const isCompressResult = (): boolean => {
    const p = phase();
    if (p === "compress") return true;
    if (p === "extract") return false;
    // 兜底：未收到进度事件（极快完成）时按产物后缀判断
    return (result()?.path ?? "").toLowerCase().endsWith(".zip");
  };

  const handleCancel = async () => {
    if (cancelling()) return;
    setCancelling(true);
    const r = await api.archive.cancel(props.token);
    if (!r.success) {
      setCancelling(false);
      showToast("error", "取消失败", r.error || "未知错误");
    }
    // 成功后等待 complete（cancelled）事件自动关闭，按钮保持「取消中…」
  };

  const handleOpenFolder = async () => {
    const r = result();
    if (!r) return;
    const res = await api.files.showFilesInExplorer([r.path]);
    if (!res.success) showToast("error", "打开文件夹失败", res.error || "未知错误");
  };

  const handleCopy = async () => {
    const r = result();
    if (!r) return;
    const res = await api.files.copyFilesToClipboard([r.path]);
    if (res.success) {
      showToast("success", "已复制到剪贴板");
    } else {
      showToast("error", "复制失败", res.error || "未知错误");
    }
  };

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => {
        // 进行中不允许点遮罩关闭（只能走取消），避免丢失取消入口
        if (status() === "success") props.onClose();
      }}
    >
      <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 class="text-xl font-bold">{phase() === "extract" ? "解压" : "压缩分享"}</h2>
        <p class="text-sm text-surface-500 mt-1 mb-4">{phaseText()}</p>

        <Show when={status() === "running"}>
          <div class="h-2.5 w-full bg-surface-200 rounded-full overflow-hidden">
            <div
              class="h-full bg-primary-500 rounded-full transition-all duration-200"
              style={{ width: `${percent()}%` }}
            />
          </div>
          <div class="flex items-center justify-between gap-3 mt-1.5 text-xs text-surface-400">
            <span class="truncate">{progress()?.current ?? ""}</span>
            <span class="shrink-0">{progress() ? `${progress()!.done}/${progress()!.total}` : ""}</span>
          </div>
          <div class="flex justify-end mt-5">
            <button
              class="btn-secondary"
              disabled={cancelling()}
              onClick={() => void handleCancel()}
            >
              {cancelling() ? "取消中…" : "取消"}
            </button>
          </div>
        </Show>

        <Show when={status() === "success"}>
          <Show when={result()}>
            {(r) => (
              <div class="rounded-xl bg-surface-50 border border-surface-200 px-3 py-2.5">
                <div class="text-sm font-medium text-surface-900 truncate" title={r().path}>
                  {r().path}
                </div>
                <div class="text-xs text-surface-400 mt-0.5">
                  {r().count} 个文件 · {formatBytes(r().size)}
                </div>
              </div>
            )}
          </Show>
          <div class="flex flex-wrap gap-3 justify-end mt-5">
            <Show when={result() && isCompressResult()}>
              <button class="btn-secondary" onClick={() => void handleCopy()}>
                📋 复制到剪贴板
              </button>
            </Show>
            <Show when={result()}>
              <button class="btn-secondary" onClick={() => void handleOpenFolder()}>
                📂 打开所在文件夹
              </button>
            </Show>
            <button class="btn-primary" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
