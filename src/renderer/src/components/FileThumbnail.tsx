import { Show, createSignal, createEffect, onCleanup } from "solid-js";

/**
 * 文件缩略图（v2.4.x 三态状态机重构）：
 * - 图片 + PDF：一次 IPC thumbnailUrl（内部 ensureThumbnail + 返回 qihebox://thumb/ URL，缺失自动生成）
 * - 渲染层 LRU URL 缓存：虚拟滚动来回滚动时命中率≈100%，免重复 IPC 往返
 * - 三态渲染：url 就绪 → <img>；IPC 在途 → 骨架屏；真实失败/非图片 → emoji 占位
 * - 竞态防护：组件级 loadId 序号守卫（不依赖 onCleanup 语义）——切文件夹后旧异步结果一律作废，
 *   避免旧文件夹的 URL 覆盖新状态（显示错图）
 * - 内存：组件卸载（滚出视口）才清 src 释放解码位图
 * - LRU 缓存校验（v2.4.2）：URL 经 img.onload 验证可加载后才写入缓存（IPC 返回不代表图片可解码）；
 *   img.onError 时剔除缓存中的坏 URL（下次滚动重试），避免坏图被 LRU 长期复用
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

/** v2.4.2：从 LRU 剔除坏 URL（img onError 调用），下次滚动时重新走 IPC 重试 */
function evictThumbUrl(filePath: string): void {
  thumbUrlCache.delete(filePath);
}

export default function FileThumbnail(props: { filePath: string | null; fileType: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);
  let imgRef: HTMLImageElement | undefined;
  // 组件级加载序号：每次 filePath 变化自增，旧异步结果凭序号作废。
  // 不能用 onCleanup 闭包标志——实测 Solid 的 onCleanup 只在组件卸载时执行，
  // 效果重跑（切文件夹）时旧 Promise 仍存活，若无序号守卫会以旧文件夹的 URL 覆盖新状态（显示错图）。
  let loadId = 0;

  // 组件顶层 onCleanup：仅在组件真正卸载（滚出视口/列表销毁）时清 src 释放解码位图。
  onCleanup(() => {
    if (imgRef) imgRef.src = "";
  });

  createEffect(() => {
    const fp = props.filePath;
    const id = ++loadId;
    // v2.1.0 决策：仅图片生成缩略图；PDF 以预览（pdfjs）查看为准，列表保持 📄 占位
    if (!fp || props.fileType !== "image") {
      setUrl(null);
      setError(true);
      return;
    }
    setError(false);

    const cached = cachedThumbUrl(fp);
    if (cached) {
      // 缓存命中：直接换图（浏览器内存缓存同 URL 秒显），跳过骨架屏
      setUrl(cached);
      return;
    }

    // 未缓存：先卸下旧图（解码立即释放，不跨图叠放）→ 骨架屏 → IPC 返回即显
    setUrl(null);

    (window.qihebox.files.thumbnailUrl(fp) as Promise<any>)
      .then((r) => {
        if (id !== loadId) return null; // 已切到别的文件，过期结果丢弃
        if (r?.success && r.data) {
          // 不在此处写缓存：URL 需经 img.onload 验证可加载后才进 LRU（IPC 返回不代表可解码）
          return r.data;
        }
        return null;
      })
      .then((u) => {
        if (id !== loadId) return;
        if (u) setUrl(u);
        else setError(true);
      })
      .catch(() => {
        if (id !== loadId) return;
        setError(true);
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
      fallback={
        <Show
          when={!error()}
          fallback={<span class="text-3xl">{fallbackIcon()}</span>}
        >
          {/* IPC 在途骨架屏：柔和加载态，替代观感「坏了」的大 emoji */}
          <div class={`${props.class || "w-full h-full"} animate-pulse bg-surface-200/60`} />
        </Show>
      }
    >
      <img
        ref={imgRef}
        src={url()!}
        class={props.class || "w-full h-full object-cover"}
        alt=""
        draggable={false}
        loading="lazy"
        onLoad={() => {
          // v2.4.2：onload 验证可解码后才写 LRU（缓存命中路径也经此确认，坏图不会长期复用）
          const fp = props.filePath;
          const u = url();
          if (fp && u) storeThumbUrl(fp, u);
        }}
        onError={() => {
          // v2.4.2：剔除缓存坏 URL + 转占位；下次滚动重新走 IPC 重试
          const fp = props.filePath;
          if (fp) evictThumbUrl(fp);
          setError(true);
        }}
      />
    </Show>
  );
}
