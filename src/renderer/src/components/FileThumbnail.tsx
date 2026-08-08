import { Show, createSignal, createEffect, onCleanup } from "solid-js";

/**
 * 文件缩略图（v2.1.0）：
 * - 图片 + PDF：一次 IPC thumbnailUrl（内部 ensureThumbnail + 返回 qihebox://thumb/ URL，缺失自动生成）
 * - 渲染层 LRU URL 缓存：虚拟滚动来回滚动时命中率≈100%，免重复 IPC 往返
 * - 非图片/PDF / 生成失败：emoji 占位
 */
const thumbUrlCache = new Map<string, string>();
const CACHE_MAX = 1000;

function cachedThumbUrl(filePath: string): string | null {
  const hit = thumbUrlCache.get(filePath);
  if (hit !== undefined) {
    // 触摸更新 LRU 顺序
    thumbUrlCache.delete(filePath);
    thumbUrlCache.set(filePath, hit);
    return hit;
  }
  return null;
}

function storeThumbUrl(filePath: string, url: string): void {
  thumbUrlCache.set(filePath, url);
  if (thumbUrlCache.size > CACHE_MAX) {
    const oldest = thumbUrlCache.keys().next().value;
    if (oldest !== undefined) thumbUrlCache.delete(oldest);
  }
}

export default function FileThumbnail(props: { filePath: string | null; fileType: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);
  let imgRef: HTMLImageElement | undefined;

  createEffect(() => {
    const fp = props.filePath;
    // v2.1.0 决策：仅图片生成缩略图；PDF 以预览（pdfjs）查看为准，列表保持 📄 占位
    if (!fp || props.fileType !== "image") {
      setUrl(null);
      setError(true);
      return;
    }
    setError(false);

    const cached = cachedThumbUrl(fp);
    if (cached) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    (window.qihebox.files.thumbnailUrl(fp) as Promise<any>)
      .then((r) => {
        if (cancelled) return null;
        if (r?.success && r.data) {
          storeThumbUrl(fp, r.data);
          return r.data;
        }
        return null;
      })
      .then((u) => {
        if (cancelled) return;
        if (u) setUrl(u);
        else setError(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    onCleanup(() => {
      cancelled = true;
      // v2.3.0 内存压制：卸载即释放解码位图（虚拟滚动滚出视口 → 内存只留当前屏）。
      // URL 保留在 LRU 缓存，重挂载时复用 URL 免重复 IPC，仅重新解码。
      if (imgRef) imgRef.src = "";
    });
  });

  const fallbackIcon = () =>
    props.fileType === "image"
      ? "🖼️"
      : props.fileType === "pdf"
        ? "📄"
        : props.fileType === "video"
          ? "🎬"
          : "📎";

  return (
    <Show
      when={url() && !error()}
      fallback={<span class="text-3xl">{fallbackIcon()}</span>}
    >
      <img
        ref={imgRef}
        src={url()!}
        class={props.class || "w-full h-full object-cover"}
        alt=""
        draggable={false}
        loading="lazy"
        onError={() => setError(true)}
      />
    </Show>
  );
}
