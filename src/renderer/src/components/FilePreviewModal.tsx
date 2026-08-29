import { Show, Switch, Match, createSignal, createEffect, onMount, onCleanup, lazy } from "solid-js";
import { api } from "~/wails/api";
import { tagList } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import PdfPreview from "~/components/PdfPreview";
import { isMarkdownName } from "../../../shared/fileKind";
import { currentWorkspace } from "~/stores/workspace";
// v2.5.7（A2 笔记）：NoteEditorModal 懒加载（lazy 边界）——Crepe 全部 import 只在动态边界内侧，
// 首屏 chunk 不含 milkdown（构建验收断言）；文件右侧没有渲染时不加载
const NoteEditorModal = lazy(() => import("~/components/NoteEditorModal"));
import ContextMenu from "~/components/ContextMenu";
import ConfirmDialog from "~/components/ConfirmDialog";
import TagInput from "~/components/TagInput";
import DatePicker from "~/components/DatePicker";
import {
  showPreview,
  previewFile,
  previewUrl,
  previewError,
  setPreviewError,
  previewContext,
  previewSessionKey,
  currentPreviewGen,
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
  // v2.5.1（F4）：md 文件（file_type=other + 扩展名判定，D21）
  const isMd = () => isMarkdownName(previewFile()?.name ?? "");
  // v2.5.7（A2 笔记）：md 工作区相对路径（writeText 契约）——仅工作区内文件可写；外部文件返回空（只读）
  const mdSaveRelPath = () => {
    const file = previewFile();
    if (!file) return "";
    const ws = currentWorkspace()?.path ?? "";
    if (!ws) return "";
    const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
    const wp = norm(file.path);
    const wsr = norm(ws);
    if (!wp.startsWith(wsr + "/") || wp === wsr) return "";
    return wp.slice(wsr.length + 1);
  };
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
  // v2.5.1（T2，D2）：层栈让位——预览内弹 Modal（如删除确认）时，layerStack 已消费 Esc（defaultPrevented），预览不抢关；
  // 完整迁移（预览 Esc 注册进层栈）随 T3 波3（弹出层 Esc 归栈）进行
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // 层栈/其他弹出层已消费
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

  const handleCopyFile = async () => {
    const file = previewFile();
    if (!file) return;
    const gen = currentPreviewGen();
    const result = await api.files.copyFilesToClipboard([file.path]);
    // v2.5.3（T7）O1：复制为异步 IPC——期间已关闭/切换预览时，
    // 失败文案不得写进新预览（代际不一致直接丢弃）
    if (!result.success && gen === currentPreviewGen()) {
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
    // v2.5.3（T7）O1：删除失败的返回携带 stale（期间已关闭/切换预览）——
    // 过期失败不写进当前预览的错误面
    if (!res.ok && !res.stale) {
      setPreviewError(res.error || "删除失败，请重试");
    }
  };

  // v2.5.3（T7）D5：复位条件由「关闭时」改为「会话变化时」——openPreview/closePreview
  // 每次递增 previewSessionKey；删除确认/右键菜单/保存中 随会话切换立即复位。
  // 「开→开」切换文件（当前遮罩阻断 UI 路径不可达，但契约语义要求常驻 signal 复位）同样触发。
  createEffect(() => {
    void previewSessionKey();
    setConfirmDelete(null);
    setSaving(false);
    closeContextMenu();
  });

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
            <div class="mb-4 p-3 bg-danger-50 border border-danger-100 rounded-lg text-sm text-danger-700">
              {previewError()}
            </div>
          </Show>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class={showMetadata() ? "lg:col-span-2" : "lg:col-span-3"}>
              {/* v2.5.1（F4）：MD 预览——previewUrl 为空不进下方 Show 分支，独立渲染（内部滚动）。
                  v2.5.7（A2 笔记）：改道为 NoteEditorModal（所见即所得编辑；MarkdownPreview 移除成死代码）。
                  保存契约：工作区内 md → writeText 相对路径（原子写 + 2MB 上限），编辑即保存；
                  工作区外（批量识别外部文件夹）→ 不落盘，仅供查看（saveRelPath 空 = 无写契约）。 */}
              <Show when={isMd()}>
                <div
                  class="h-[60vh] bg-surface-100 rounded-xl overflow-hidden relative note-editor-wrap"
                  onContextMenu={onContextMenu}
                >
                  <NoteEditorModal
                    filePath={previewFile()?.path ?? ""}
                    saveRelPath={mdSaveRelPath()}
                    onClose={closePreview}
                    onSaved={() => {
                      showToast("success", "笔记已保存");
                      previewContext().onDelete?.(); // 复用回调刷新列表
                    }}
                    onOpenWithSystem={() => void openCurrentWithSystem()}
                  />
                </div>
              </Show>
              <Show when={!isMd()}>
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
                </div>
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
                    scope="file" // v2.5.7（A3）：文件/笔记域标签
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
