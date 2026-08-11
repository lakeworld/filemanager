import { Show, Switch, Match, createSignal, onMount, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { tagList } from "~/stores/tags";
import { requireLogin } from "~/stores/account";
import { showToast } from "~/stores/notifyBanner";
import { FEATURE_AI } from "~/features";
import PdfPreview from "~/components/PdfPreview";
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import TagInput from "~/components/TagInput";
import DatePicker from "~/components/DatePicker";
import type { AiCertInfo } from "~/types";
import {
  showPreview,
  previewFile,
  previewUrl,
  previewError,
  setPreviewError,
  previewContext,
  metadata,
  setMetadata,
  closePreview,
  saveCurrentMetadata,
  deleteCurrentFile,
  openCurrentWithSystem,
} from "~/stores/preview";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function FilePreviewModal() {
  const isPdf = () => previewFile()?.file_type === "pdf";
  const isImage = () => previewFile()?.file_type === "image";
  const isVideo = () => previewFile()?.file_type === "video";
  const showMetadata = () => !!previewContext().productSet && previewContext().editMetadata;
  // v2.4.2（P1-P1）：pdfjs 对非 http 协议整文件加载——超大 PDF 内嵌预览会整载进内存（Linux 1GB 堆上限下
  // 有 OOM 白屏风险），超过阈值改引导「用系统程序打开」
  const PDF_INLINE_LIMIT_BYTES = 100 * 1024 * 1024;
  const isPdfTooLarge = () => isPdf() && (previewFile()?.size ?? 0) > PDF_INLINE_LIMIT_BYTES;

  const [contextMenu, setContextMenu] = createSignal<{ show: boolean; x: number; y: number }>({
    show: false,
    x: 0,
    y: 0,
  });

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, show: false }));

  // 收尾轮：Esc 关闭预览（右键菜单打开时由 ContextMenu 自身的 Esc 监听先关菜单，不抢关）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (contextMenu().show) return;
      closePreview();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // —— v2.4.3（F9）：保存元数据反馈——saving 态防连点 + 成功/失败 toast ——
  const [saving, setSaving] = createSignal(false);
  const handleSaveMetadata = async () => {
    if (saving()) return;
    setSaving(true);
    const res = await saveCurrentMetadata();
    setSaving(false);
    if (res.ok) {
      showToast("success", "元数据已保存");
    } else {
      showToast("error", "保存失败", res.error);
    }
  };

  // —— v2.2.0：AI 证书信息抽取 ——
  const [extractText, setExtractText] = createSignal<(() => Promise<string>) | null>(null);
  const [aiCertBusy, setAiCertBusy] = createSignal(false);
  const [aiCertMsg, setAiCertMsg] = createSignal("");

  const handleAiExtract = async () => {
    if (!requireLogin()) return;
    const file = previewFile();
    const extract = extractText();
    if (!file || !extract) {
      setAiCertMsg("PDF 尚未加载完成，请稍后重试");
      return;
    }
    setAiCertBusy(true);
    setAiCertMsg("");
    try {
      const text = await extract();
      if (!text) {
        setAiCertMsg("未能提取证书文本（可能是扫描件），可改用其他方式填写");
        return;
      }
      const r = await api.ai.call("cert", { file_name: file.name, text });
      if (!r.success || !r.data) {
        setAiCertMsg(r.error || "AI 抽取失败，请稍后重试");
        return;
      }
      const cert = (r.data as { cert: AiCertInfo }).cert;
      setMetadata((prev) => ({
        ...prev,
        cert_type: cert.name || prev.cert_type,
        expiry_date: cert.valid_to || prev.expiry_date,
        notes:
          [cert.number && `编号：${cert.number}`, cert.issuer && `发证机构：${cert.issuer}`]
            .filter(Boolean)
            .join("\n") || prev.notes,
      }));
      setAiCertMsg(
        `AI 已抽取${cert.name ? `「${cert.name}」` : "证书信息"}，请核对后点「保存元数据」`,
      );
    } finally {
      setAiCertBusy(false);
    }
  };

  const handleCopyFile = async () => {
    const file = previewFile();
    if (!file) return;
    const result = await api.files.copyFilesToClipboard([file.path]);
    if (!result.success) {
      setPreviewError(result.error || "复制失败");
    }
  };

  // v2.4.7：预览内删除补确认（此前是全应用唯一无确认删除入口）+ 失败提示——
  // 与 FileBrowserView 一致，删除即移入回收站，可在回收站恢复
  // v2.4.7（统一改造）：原生 confirm → ConfirmDialog（confirmDelete=待确认删除的文件名）
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);

  const handleDeleteFile = () => {
    const file = previewFile();
    if (!file) return;
    setConfirmDelete(file.name);
  };

  const doDeleteFile = async () => {
    const res = await deleteCurrentFile();
    if (!res.ok) {
      setPreviewError(res.error || "删除失败，请重试");
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ show: true, x: e.clientX, y: e.clientY });
  };

  return (
    <Show when={showPreview() && previewFile()}>
      <div
        class="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
        onClick={() => {
          closeContextMenu();
          closePreview();
        }}
      >
        <div
          class="bg-white rounded-2xl w-full max-w-4xl p-6 shadow-xl max-h-[90vh] overflow-auto"
          onClick={(e) => {
            e.stopPropagation();
            closeContextMenu();
          }}
        >
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-semibold">{previewFile()?.name}</h3>
            <div class="flex gap-2">
              <Show when={isPdf() && FEATURE_AI}>
                <button class="btn-secondary text-sm" onClick={handleAiExtract} disabled={aiCertBusy()}>
                  {aiCertBusy() ? "AI 抽取中..." : "🤖 AI 抽取信息"}
                </button>
              </Show>
              <button class="btn-secondary text-sm" onClick={handleCopyFile}>
                📋 复制文件
              </button>
              <button class="btn-secondary text-sm" onClick={openCurrentWithSystem}>
                🗂 用系统程序打开
              </button>
              <button class="btn-secondary text-sm" onClick={handleDeleteFile}>
                🗑️ 删除
              </button>
              <button class="text-surface-400 hover:text-surface-600 text-xl" onClick={closePreview}>
                ✕
              </button>
            </div>
          </div>

          <Show when={previewError()}>
            <div class="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
              {previewError()}
            </div>
          </Show>

          <Show when={aiCertMsg()}>
            <div class="mb-4 p-3 bg-primary-50 border border-primary-100 rounded-lg text-sm text-primary-700">
              {aiCertMsg()}
            </div>
          </Show>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class={showMetadata() ? "lg:col-span-2" : "lg:col-span-3"}>
              <div
                class="aspect-video bg-surface-100 rounded-xl flex items-center justify-center overflow-hidden relative"
                onContextMenu={onContextMenu}
              >
                <Show
                  when={previewUrl()}
                  fallback={
                    <span class="text-6xl">
                      {isImage() ? "🖼️" : isPdf() ? "📄" : isVideo() ? "🎬" : "📎"}
                    </span>
                  }
                >
                  <Switch>
                    <Match when={isImage()}>
                      <img
                        src={previewUrl()}
                        class="max-w-full max-h-full object-contain"
                        alt={previewFile()?.name}
                        onError={() => setPreviewError("图片加载失败，请尝试用系统程序打开")}
                      />
                    </Match>
                    <Match when={isVideo()}>
                      <video
                        src={previewUrl()}
                        controls
                        class="max-w-full max-h-full"
                        onError={() => setPreviewError("视频加载失败，请尝试用系统程序打开")}
                      />
                    </Match>
                    <Match when={isPdf()}>
                      {/* v2.1.0：PDFium 不渲染 iframe 自定义协议，改 pdfjs 渲染进程渲染
                          v2.4.2（P1-P1）：超大 PDF 整载有 OOM 风险 → 引导用系统程序打开 */}
                      <Show
                        when={!isPdfTooLarge()}
                        fallback={
                          <div class="flex flex-col items-center gap-3 p-6 text-center text-sm text-surface-500">
                            <span class="text-5xl">📄</span>
                            <span>
                              PDF 较大（{formatBytes(previewFile()?.size ?? 0)}），内嵌预览需整文件加载，
                              建议用系统程序打开
                            </span>
                            <button class="btn-primary" onClick={openCurrentWithSystem}>
                              用系统程序打开
                            </button>
                          </div>
                        }
                      >
                        <PdfPreview
                          url={previewUrl()}
                          onError={(m) => setPreviewError(m)}
                          onTextExtract={(fn) => setExtractText(() => fn)}
                        />
                      </Show>
                    </Match>
                    {/* v2.4.7：不支持内嵌预览的类型（docx/zip 等 file_type=other）补占位，不再空白 */}
                    <Match when={true}>
                      <div class="flex flex-col items-center gap-3 p-6 text-center text-sm text-surface-500">
                        <span class="text-5xl">📎</span>
                        <span>此类型暂不支持预览，可用系统程序打开</span>
                        <button class="btn-primary" onClick={openCurrentWithSystem}>
                          用系统程序打开
                        </button>
                      </div>
                    </Match>
                  </Switch>
                </Show>

                {/* Context menu inside preview（统一组件，v2.3.x） */}
                <Show when={contextMenu().show}>
                  <ContextMenu
                    x={contextMenu().x}
                    y={contextMenu().y}
                    onClose={closeContextMenu}
                    items={[
                      {
                        label: "复制文件到剪贴板",
                        icon: "📋",
                        action: () => void handleCopyFile(),
                      },
                      {
                        label: "用系统程序打开",
                        icon: "🗂",
                        action: () => void openCurrentWithSystem(),
                      },
                      {
                        label: "复制路径",
                        icon: "🔗",
                        action: () => {
                          const file = previewFile();
                          if (file) void api.files.copyPaths([file.path]);
                        },
                      },
                      {
                        label: "关闭",
                        icon: "❌",
                        action: () => closePreview(),
                      },
                    ]}
                  />
                </Show>
              </div>
              <div class="grid grid-cols-3 gap-4 mt-4 text-sm">
                <div>
                  <div class="text-surface-400">大小</div>
                  <div class="font-medium">{formatBytes(previewFile()?.size ?? 0)}</div>
                </div>
                <div>
                  <div class="text-surface-400">类型</div>
                  <div class="font-medium">{previewFile()?.file_type}</div>
                </div>
                <div>
                  <div class="text-surface-400">修改时间</div>
                  <div class="font-medium">{previewFile()?.modified}</div>
                </div>
              </div>
            </div>

            <Show when={showMetadata()}>
              <div class="space-y-4">
                <h4 class="font-semibold text-surface-900">元数据</h4>

                <div>
                  <label class="block text-sm font-medium text-surface-700 mb-1">证书类型</label>
                  <input
                    type="text"
                    class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                    value={metadata().cert_type}
                    onInput={(e) => setMetadata((prev) => ({ ...prev, cert_type: e.currentTarget.value }))}
                    placeholder="如：3C"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-surface-700 mb-1">到期日</label>
                  <DatePicker
                    value={metadata().expiry_date}
                    onChange={(d) => setMetadata((prev) => ({ ...prev, expiry_date: d }))}
                  />
                </div>

                <div>
                  <label class="block text-sm font-medium text-surface-700 mb-1">标签</label>
                  <TagInput
                    value={metadata().tags}
                    onChange={(t) => setMetadata((prev) => ({ ...prev, tags: t }))}
                    options={tagList()}
                    placeholder="输入标签按回车"
                  />
                </div>

                <div>
                  <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
                  <textarea
                    class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-none"
                    rows={3}
                    value={metadata().notes}
                    onInput={(e) => setMetadata((prev) => ({ ...prev, notes: e.currentTarget.value }))}
                    placeholder="添加备注..."
                  />
                </div>

                <button class="btn-primary w-full" disabled={saving()} onClick={handleSaveMetadata}>
                  {saving() ? "保存中..." : "保存元数据"}
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>

      {/* 删除确认弹窗（v2.4.7 统一改造：原生 confirm → ConfirmDialog）；置于遮罩容器外，避免遮罩 onClick 误关预览 */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除文件"
          message={`确定删除 "${confirmDelete()!}" 吗？将移入回收站，可在回收站恢复。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            setConfirmDelete(null);
            void doDeleteFile();
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </Show>
    </Show>
  );
}
