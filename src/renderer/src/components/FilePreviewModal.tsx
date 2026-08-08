import { Show, For, Switch, Match, createSignal } from "solid-js";
import { api } from "~/wails/api";
import {
  showPreview,
  previewFile,
  previewUrl,
  previewError,
  setPreviewError,
  previewContext,
  metadata,
  tagInput,
  setTagInput,
  setMetadata,
  closePreview,
  saveCurrentMetadata,
  deleteCurrentFile,
  openCurrentWithSystem,
  addTag,
  removeTag,
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

  const [contextMenu, setContextMenu] = createSignal<{ show: boolean; x: number; y: number }>({
    show: false,
    x: 0,
    y: 0,
  });

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, show: false }));

  const handleCopyFile = async () => {
    const file = previewFile();
    if (!file) return;
    const result = await api.files.copyFilesToClipboard([file.path]);
    if (!result.success) {
      setPreviewError(result.error || "复制失败");
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
              <button class="btn-secondary text-sm" onClick={handleCopyFile}>
                📋 复制文件
              </button>
              <button class="btn-secondary text-sm" onClick={openCurrentWithSystem}>
                🗂 用系统程序打开
              </button>
              <button class="btn-secondary text-sm" onClick={deleteCurrentFile}>
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
                      <iframe
                        src={previewUrl()}
                        class="h-full w-full"
                        style={{ border: "none" }}
                        title={previewFile()?.name}
                      />
                    </Match>
                  </Switch>
                </Show>

                {/* Context menu inside preview */}
                <Show when={contextMenu().show}>
                  <div
                    class="fixed z-50 bg-white shadow-lg rounded-lg border border-surface-200 py-1 min-w-[160px]"
                    style={{
                      left: `${contextMenu().x}px`,
                      top: `${contextMenu().y}px`,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
                      onClick={() => {
                        handleCopyFile();
                        closeContextMenu();
                      }}
                    >
                      📋 复制文件到剪贴板
                    </button>
                    <button
                      class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
                      onClick={() => {
                        openCurrentWithSystem();
                        closeContextMenu();
                      }}
                    >
                      🗂 用系统程序打开
                    </button>
                    <button
                      class="w-full px-4 py-2 text-left text-sm hover:bg-surface-100"
                      onClick={() => {
                        closePreview();
                        closeContextMenu();
                      }}
                    >
                      ❌ 关闭
                    </button>
                  </div>
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
                  <input
                    type="date"
                    class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                    value={metadata().expiry_date}
                    onInput={(e) => setMetadata((prev) => ({ ...prev, expiry_date: e.currentTarget.value }))}
                  />
                </div>

                <div>
                  <label class="block text-sm font-medium text-surface-700 mb-1">标签</label>
                  <div class="flex gap-2 mb-2">
                    <input
                      type="text"
                      class="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm"
                      value={tagInput()}
                      onInput={(e) => setTagInput(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && addTag(tagInput())}
                      placeholder="输入标签按回车"
                    />
                    <button class="btn-secondary px-3 text-sm" onClick={() => addTag(tagInput())}>
                      添加
                    </button>
                  </div>
                  <div class="flex flex-wrap gap-1">
                    <For each={metadata().tags}>
                      {(tag, index) => (
                        <span class="inline-flex items-center gap-1 px-2 py-1 bg-primary-50 text-primary-700 rounded text-xs">
                          {tag}
                          <button class="hover:text-primary-900" onClick={() => removeTag(index())}>
                            ✕
                          </button>
                        </span>
                      )}
                    </For>
                  </div>
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

                <button class="btn-primary w-full" onClick={saveCurrentMetadata}>
                  保存元数据
                </button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
