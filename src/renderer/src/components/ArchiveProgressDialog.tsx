import { Show, createSignal, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
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
    // v2.5.8 D16（framed 收口）：加 framed 走统一骨架——标题改由 `.dlg-header` 显示 title（文案与原手写
    // `<h2>` 一字未动，e2e 仍按 role=dialog + name「压缩分享」/「解压」命中），两态底部动作行整体搬进 footer。
    // 本弹窗未写 size ⇒ 沿用底座默认 md（max-w-md），迁移前后正文实宽不变。
    <Modal
      open
      title={phase() === "extract" ? "解压" : "压缩分享"}
      lockOpen
      onClose={props.onClose}
      framed
      // 取消钮（running）与「复制到剪贴板 / 打开所在文件夹 / 关闭」（success）连同各自的条件一起原样搬来
      // （动作不回流正文、正文的非页脚内容不下页脚）。`.dlg-footer` 自带 justify-end + gap-3 ⇒ 原来两层外壳
      // （`flex justify-end mt-5` 与 `flex flex-wrap gap-3 justify-end mt-5`）作废；按钮的 class、文案、
      // onClick、disabled 表达式逐字未动。唯一口径差：档内不换行，而原成功态那行带 flex-wrap
      // ⇒ 三个按钮的宽度逼近 md 档页脚内容宽（400px），走查若见挤行属本组待裁决（本轮不改 size、不补换行）。
      footer={
        <>
          <Show when={status() === "running"}>
            <button
              class="btn-secondary"
              disabled={cancelling()}
              onClick={() => void handleCancel()}
            >
              {cancelling() ? "取消中…" : "取消"}
            </button>
          </Show>
          <Show when={status() === "success"}>
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
          </Show>
        </>
      }
    >
      {/* v2.5.8 D16：手写 `<h2>` 与手搓白卡外壳材质（`bg-white rounded-2xl w-full max-w-md p-6 shadow-xl`）已删
          ——framed 下面板本体 `.modal-panel` 就是实底白卡、`.dlg-header` 显示 title、`.dlg-body` 给 px-6 py-5，
          留着就是双卡 + 双内边距 + 双标题。外壳 div 与它的 onClick 一字未动（Modal 面板自己已 stop 冒泡，
          这处冗余但不属本轮可删项）；仍包一层 div，使 `.dlg-body` 的 `flex flex-col gap-4` 只作用在这一个
          子节点上，正文原有的 mt-1 / mb-4 / mt-1.5 节奏保持不变（不趁迁移改版式）。
          阶段提示行 `phaseText()` 原样留在正文：它随进度事件变文案，不是标题副句 ⇒ 本轮不折进 subtitle。 */}
      <div onClick={(e) => e.stopPropagation()}>
        <p class="text-sm text-surface-500 mt-1 mb-4">{phaseText()}</p>

        <Show when={status() === "running"}>
          <div class="h-2.5 w-full bg-surface-200 rounded-full overflow-hidden">
            <div
              class="h-full bg-primary-500 rounded-full transition-[width] duration-200"
              style={{ width: `${percent()}%` }}
            />
          </div>
          <div class="flex items-center justify-between gap-3 mt-1.5 text-xs text-surface-400">
            <span class="truncate">{progress()?.current ?? ""}</span>
            <span class="shrink-0">{progress() ? `${progress()!.done}/${progress()!.total}` : ""}</span>
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
        </Show>
      </div>
    </Modal>
  );
}
