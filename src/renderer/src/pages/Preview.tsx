/**
 * 独立预览窗口渲染页（v2.2.1，路由 #/preview?file=<path>）
 * - 在独立 BrowserWindow（独立渲染进程）中运行，关闭即销毁释放内存
 * - PDF：优化后 PdfPreview（流式加载/页缓存/渐进，丝滑翻页缩放）
 * - 图片：全分辨率大图 + 下方同目录缩略图条（点击切换，图片查看器惯例）
 * - 精简元数据面板（证书类型/到期日/标签/备注）—— AI 功能本期不发布，未集成
 */
import { Show, For, createSignal, createMemo, onMount } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { api } from "~/wails/api";
import PdfPreview from "~/components/PdfPreview";
import FileThumbnail from "~/components/FileThumbnail";
import type { FileEntry, FileMetadata } from "~/types";

const defaultMetadata: FileMetadata = {
  cert_type: "",
  expiry_date: "",
  tags: [],
  notes: "",
  added_at: "",
};

function isPdfPath(p: string): boolean {
  return /\.pdf$/i.test(p);
}
function isImagePath(p: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp|tiff?|svg)$/i.test(p);
}

/** 从文件路径推断产品集 / 类型 / 子文件夹（/产品集/{ps}/{图包|证书}/{sub}/...） */
function inferDir(p: string): { ps: string; type: string; sub: string } | null {
  const m = p.match(/\/产品集\/([^/]+)\/(图包|证书)\/([^/]+)\//);
  if (!m) return null;
  return { ps: decodeURIComponent(m[1]), type: m[2] === "图包" ? "image" : "cert", sub: m[3] };
}

export default function Preview() {
  const [searchParams] = useSearchParams();
  const [currentPath, setCurrentPath] = createSignal<string>("");
  const fileName = createMemo(() => {
    const p = currentPath();
    const idx = p.lastIndexOf("/");
    return idx >= 0 ? p.slice(idx + 1) : p;
  });
  const dir = createMemo(() => inferDir(currentPath()));

  const [url, setUrl] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);

  // 同目录图片列表（缩略图条）
  const [siblings, setSiblings] = createSignal<FileEntry[]>([]);

  // 元数据
  const [meta, setMeta] = createSignal<FileMetadata>({ ...defaultMetadata });
  const [showMeta, setShowMeta] = createSignal(false);
  const [tagInput, setTagInput] = createSignal("");
  const [savedTip, setSavedTip] = createSignal("");

  const loadFile = async (p: string): Promise<void> => {
    setLoading(true);
    setError("");
    setUrl("");
    const r = await api.files.workspaceUrl(p);
    if (r.success && r.data) {
      setUrl(r.data);
    } else {
      setError(r.error || "无法加载文件");
    }
    // 元数据
    const d = inferDir(p);
    if (d) {
      const name = p.slice(p.lastIndexOf("/") + 1);
      const m = await api.metadata.get(d.ps, name);
      if (m.success && m.data) setMeta(m.data);
      else setMeta({ ...defaultMetadata });
    } else {
      setMeta({ ...defaultMetadata });
    }
    setLoading(false);
  };

  const loadSiblings = async (): Promise<void> => {
    const d = inferDir(currentPath());
    if (!d || d.type !== "image") {
      setSiblings([]);
      return;
    }
    const r = await api.files.list({ product_set: d.ps, file_type: "image", sub_folder: d.sub });
    if (r.success && r.data) {
      setSiblings(r.data.filter((f) => isImagePath(f.name)));
    }
  };

  const switchTo = (p: string) => {
    if (p === currentPath()) return;
    setCurrentPath(p);
    void loadFile(p);
  };

  onMount(async () => {
    const initial = searchParams.file;
    const p = typeof initial === "string" ? initial : "";
    if (!p) {
      setError("缺少文件参数");
      setLoading(false);
      return;
    }
    setCurrentPath(p);
    await loadFile(p);
    await loadSiblings();
  });

  const handleSaveMeta = async () => {
    const d = dir();
    if (!d) return;
    const r = await api.metadata.update({
      product_set: d.ps,
      file_name: fileName(),
      cert_type: meta().cert_type,
      expiry_date: meta().expiry_date,
      tags: meta().tags,
      notes: meta().notes,
    });
    if (r.success) {
      setSavedTip("已保存");
      setTimeout(() => setSavedTip(""), 2000);
    } else {
      setError(r.error || "保存失败");
    }
  };

  const addTag = (t: string) => {
    const tag = t.trim();
    if (!tag) return;
    setMeta((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setTagInput("");
  };
  const removeTag = (i: number) => {
    setMeta((prev) => ({ ...prev, tags: prev.tags.filter((_, idx) => idx !== i) }));
  };

  return (
    <div class="h-screen w-screen flex flex-col bg-surface-50 overflow-hidden">
      {/* 顶部工具栏 */}
      <div class="flex items-center gap-2 px-4 py-2 bg-white border-b border-surface-200 shrink-0">
        <span class="text-sm font-semibold text-surface-800 truncate">{fileName()}</span>
        <span class="text-xs text-surface-400">{isPdfPath(currentPath()) ? "PDF" : "图片"}</span>
        <div class="flex-1" />
        <Show when={dir()}>
          <button class="btn-secondary px-3 py-1 text-xs" onClick={() => setShowMeta((v) => !v)}>
            {showMeta() ? "隐藏元数据" : "📋 元数据"}
          </button>
        </Show>
        <button
          class="btn-secondary px-3 py-1 text-xs"
          onClick={() => void api.files.openWithDefaultApp(currentPath())}
        >
          🗂 系统程序打开
        </button>
        <button class="btn-secondary px-3 py-1 text-xs" onClick={() => window.close()}>
          ✕ 关闭
        </button>
      </div>

      <Show when={error()}>
        <div class="p-4 text-sm text-red-600 bg-red-50 border-b border-red-100">{error()}</div>
      </Show>

      <div class="flex-1 min-h-0 flex">
        {/* 内容区 */}
        <div class="flex-1 min-w-0 p-4 flex flex-col">
          <div class="flex-1 min-h-0">
            <Show when={loading()}>
              <div class="h-full flex items-center justify-center text-surface-400">加载中…</div>
            </Show>
            <Show when={!loading() && url() && isPdfPath(currentPath())}>
              <div class="h-full">
                <PdfPreview url={url()} onError={(m) => setError(m)} />
              </div>
            </Show>
            <Show when={!loading() && url() && isImagePath(currentPath())}>
              <div class="h-full flex items-center justify-center overflow-auto bg-surface-100 rounded-lg">
                <img src={url()} alt={fileName()} class="max-w-full max-h-full object-contain" />
              </div>
            </Show>
          </div>

          {/* 图片缩略图条（同目录） */}
          <Show when={siblings().length > 1}>
            <div class="mt-3 shrink-0">
              <div class="flex gap-2 overflow-x-auto pb-1">
                <For each={siblings()}>
                  {(f) => {
                    const active = f.path === currentPath();
                    return (
                      <button
                        class={`w-20 h-20 shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${
                          active ? "border-primary-500" : "border-transparent hover:border-surface-300"
                        }`}
                        onClick={() => switchTo(f.path)}
                        title={f.name}
                      >
                        <div class="w-full h-full bg-surface-100 flex items-center justify-center">
                          <FileThumbnail filePath={f.path} fileType={f.file_type} />
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </div>

        {/* 元数据面板 */}
        <Show when={showMeta() && dir()}>
          <div class="w-72 shrink-0 border-l border-surface-200 bg-white p-4 overflow-y-auto space-y-3">
            <h4 class="text-sm font-semibold text-surface-900">元数据 · {dir()!.ps}</h4>
            <div>
              <label class="block text-xs font-medium text-surface-600 mb-1">证书类型</label>
              <input
                type="text"
                class="w-full px-2 py-1.5 border border-surface-200 rounded text-sm"
                value={meta().cert_type}
                onInput={(e) => setMeta((prev) => ({ ...prev, cert_type: e.currentTarget.value }))}
                placeholder="如：3C"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-surface-600 mb-1">到期日</label>
              <input
                type="date"
                class="w-full px-2 py-1.5 border border-surface-200 rounded text-sm"
                value={meta().expiry_date}
                onInput={(e) => setMeta((prev) => ({ ...prev, expiry_date: e.currentTarget.value }))}
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-surface-600 mb-1">标签</label>
              <div class="flex gap-1 mb-1.5">
                <input
                  type="text"
                  class="flex-1 px-2 py-1.5 border border-surface-200 rounded text-sm"
                  value={tagInput()}
                  onInput={(e) => setTagInput(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTag(tagInput())}
                  placeholder="回车添加"
                />
                <button class="btn-secondary px-2 text-xs" onClick={() => addTag(tagInput())}>+</button>
              </div>
              <div class="flex flex-wrap gap-1">
                <For each={meta().tags}>
                  {(tag, index) => (
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-100 text-primary-700 rounded text-xs">
                      {tag}
                      <button class="hover:opacity-70" onClick={() => removeTag(index())}>✕</button>
                    </span>
                  )}
                </For>
              </div>
            </div>
            <div>
              <label class="block text-xs font-medium text-surface-600 mb-1">备注</label>
              <textarea
                class="w-full px-2 py-1.5 border border-surface-200 rounded text-sm resize-none"
                rows={4}
                value={meta().notes}
                onInput={(e) => setMeta((prev) => ({ ...prev, notes: e.currentTarget.value }))}
              />
            </div>
            <button class="btn-primary w-full" onClick={handleSaveMeta}>
              {savedTip() || "保存元数据"}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
