import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { api } from "~/wails/api";

/**
 * 文件缩略图（v2.4.x 三态状态机重构）：
 * - 图片 + PDF：一次 IPC thumbnailUrl（内部 ensureThumbnail + 返回 qihebox://thumb/ URL，缺失自动生成）
 * - v2.4.4 视频：渲染层抓帧缩略图——videoThumbnail 命中直取 URL；miss 则 workspaceUrl 协议流式加载
 *   隐藏 <video> 定位到 10%（≤1s）→ canvas 320px 绘制 JPEG → saveVideoFrame 落盘 → 复用 URL
 * - 渲染层 LRU URL 缓存：虚拟滚动来回滚动时命中率≈100%，免重复 IPC 往返
 * - 三态渲染：url 就绪 → <img>；IPC 在途 → 骨架屏；真实失败/非图片 → emoji 占位
 * - 竞态防护：组件级 loadId 序号守卫（不依赖 onCleanup 语义）——切文件夹后旧异步结果一律作废，
 *   避免旧文件夹的 URL 覆盖新状态（显示错图）
 * - 内存：组件卸载（滚出视口）才清 src 释放解码位图；视频抓帧的 video/canvas 由 dispose 即时释放
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

// —— v2.4.4 渲染层视频抓帧（模块级 helper，非组件内联）——
const MAX_CONCURRENT_FRAME_FETCH = 2;
const FRAME_FETCH_TIMEOUT_MS = 15000;
/** 抓帧失败（不可解码如 mkv/avi 等）黑名单：失败后不再重试（上限 2000，防长列表滚动膨胀） */
const failedFramePaths = new Set<string>();
let activeFrameFetch = 0;
const frameFetchQueue: Array<{ run: () => void; cancelled: () => boolean }> = [];

function pumpFrameFetch(): void {
  while (frameFetchQueue.length > 0 && activeFrameFetch < MAX_CONCURRENT_FRAME_FETCH) {
    const next = frameFetchQueue.shift()!;
    if (next.cancelled()) {
      // v2.4.6：等待者已卸载/过期——cancelled() 内已以 false 唤醒它，跳过不占槽位。
      // 修复 v2.4.4 旧实现：cancelled() 无条件 resolve(false) 且恒定返回 false，
      // 排队请求永远拿不到槽位；且槽位双重自增（pump 与 run 各 ++）只释放一次，
      // 两轮泄漏后抓帧全局永久卡死（≥3 个视频并发即触发）。
      continue;
    }
    activeFrameFetch++;
    next.run();
  }
}

/** 获取抓帧槽位：并发满时 FIFO 排队；返回 false 表示等待期间被取消 */
function awaitFrameSlot(cancelled: () => boolean): Promise<boolean> {
  if (activeFrameFetch < MAX_CONCURRENT_FRAME_FETCH) {
    activeFrameFetch++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    frameFetchQueue.push({
      run: () => resolve(true),
      cancelled: () => {
        // v2.4.6：仅在谓词确认已取消时才以 false 唤醒并放弃槽位
        if (!cancelled()) return false;
        resolve(false);
        return true;
      },
    });
  });
}

function markFrameFailed(filePath: string): void {
  if (failedFramePaths.size >= 2000) failedFramePaths.clear();
  failedFramePaths.add(filePath);
}

// —— v2.4.6 图片缩略图 IPC 并发闸（仿上方视频抓帧 MAX_CONCURRENT_FRAME_FETCH）——
// 快速滚动大列表时瞬间几百个 thumbnailUrl IPC 打向主进程：上限 8，超出 FIFO 排队；
// 排队期间组件卸载/切文件（loadId 作废）的请求跳过不发、不占槽位。
const MAX_CONCURRENT_THUMB_FETCH = 8;
let activeThumbFetch = 0;
const thumbFetchQueue: Array<{ run: () => void; cancelled: () => boolean }> = [];

function pumpThumbFetch(): void {
  while (thumbFetchQueue.length > 0 && activeThumbFetch < MAX_CONCURRENT_THUMB_FETCH) {
    const next = thumbFetchQueue.shift()!;
    if (next.cancelled()) {
      // 等待者已卸载/过期：cancelled() 内已以 false 唤醒它，跳过不占槽位
      continue;
    }
    activeThumbFetch++;
    next.run();
  }
}

/** 获取图片缩略图 IPC 槽位：并发满时 FIFO 排队；返回 false 表示等待期间被取消 */
function awaitThumbSlot(cancelled: () => boolean): Promise<boolean> {
  if (activeThumbFetch < MAX_CONCURRENT_THUMB_FETCH) {
    activeThumbFetch++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    thumbFetchQueue.push({
      run: () => resolve(true),
      cancelled: () => {
        if (!cancelled()) return false;
        resolve(false);
        return true;
      },
    });
  });
}

interface FrameCtx {
  video: HTMLVideoElement | null;
  canvas: HTMLCanvasElement | null;
  timer: number | undefined;
  pendingResolve: ((v: Blob | null) => void) | null;
}

function createFrameCtx(): FrameCtx {
  return { video: null, canvas: null, timer: undefined, pendingResolve: null };
}

/**
 * 隐藏 <video> 抓一帧：协议流式 URL（qihebox://file/...，Range/206 支持 seek）
 * → currentTime = min(1, duration*0.1) → seeked/loadeddata 后 canvas 320px 等比绘制 → toBlob JPEG(0.8)。
 * 任何失败 / 15s 超时 → null（调用方转 🎬 占位，不报错）。settle 即释放 video/canvas 与定时器。
 */
function captureVideoFrameBlob(
  src: string,
  ctx: FrameCtx,
  cancelled: () => boolean,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (cancelled()) {
      resolve(null);
      return;
    }
    const video = document.createElement("video");
    ctx.video = video;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    // 隐藏挂载：display:none 在部分平台不触发媒体管线，用不可见定位代替
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    video.src = src;
    document.body.appendChild(video);

    const canvas = document.createElement("canvas");
    ctx.canvas = canvas;

    let settled = false;
    let drew = false;

    const settle = (v: Blob | null) => {
      if (settled) return;
      settled = true;
      ctx.pendingResolve = null;
      if (ctx.timer !== undefined) {
        window.clearTimeout(ctx.timer);
        ctx.timer = undefined;
      }
      if (ctx.video) {
        ctx.video.removeAttribute("src");
        ctx.video.load();
        ctx.video.remove();
        ctx.video = null;
      }
      ctx.canvas = null;
      resolve(v);
    };
    ctx.pendingResolve = settle;

    const maybeDraw = () => {
      if (settled || drew || cancelled()) return;
      if (video.readyState < 2) return; // HAVE_CURRENT_DATA
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      drew = true;
      const targetW = 320;
      canvas.width = targetW;
      canvas.height = Math.max(1, Math.round((h / w) * targetW));
      const g = canvas.getContext("2d");
      if (!g) {
        settle(null);
        return;
      }
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => settle(blob), "image/jpeg", 0.8);
    };

    const onError = () => settle(null);
    const onSeeked = () => maybeDraw();
    const onLoadedData = () => maybeDraw();
    const onLoadedMetadata = () => {
      if (settled) return;
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) {
        video.currentTime = Math.min(1, dur * 0.1);
      } else {
        // 无 duration 的媒体：loadeddata 时直接绘制当前帧
        maybeDraw();
      }
    };

    video.addEventListener("error", onError);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    // 整体兜底：事件链卡住（不支持容器等）一律 15s 放弃
    ctx.timer = window.setTimeout(() => settle(null), FRAME_FETCH_TIMEOUT_MS);
  });
}

/**
 * 视频帧缩略图（v2.4.4）：videoThumbnail 命中 → URL；miss → 抓帧落盘 → URL。
 * 失败/不可解码/超时 → ''（🎬 占位，不抛错、不重试）。
 * 返回 { promise, dispose }：dispose 供组件卸载/切换时即时释放抓帧资源与排队槽位。
 */
function captureVideoFrame(
  filePath: string,
  isStale: () => boolean,
): { promise: Promise<string>; dispose: () => void } {
  let disposed = false;
  let ctx: FrameCtx | null = null;

  const dispose = () => {
    disposed = true;
    // 挂起中的抓帧 → 触发 settle(null) 完整释放；已完成/未开始则无操作
    if (ctx?.pendingResolve) ctx.pendingResolve(null);
  };

  const promise = (async () => {
    if (failedFramePaths.has(filePath)) return "";
    let gotSlot = false;
    try {
      gotSlot = await awaitFrameSlot(() => disposed || isStale());
      if (!gotSlot || disposed || isStale()) return "";

      // ① 主进程缓存命中（mtime 校验）
      const hit = await api.files.videoThumbnail(filePath);
      if (disposed || isStale()) return "";
      if (hit?.success && hit.data) return hit.data;

      // ② 协议流式 URL（qihebox://file/...，Range/206 可 seek）
      const ws = await api.files.workspaceUrl(filePath);
      if (disposed || isStale()) return "";
      if (!ws?.success || !ws.data) {
        markFrameFailed(filePath);
        return "";
      }

      // ③ 抓帧（≤15s；不可解码容器走 error/超时落空）
      ctx = createFrameCtx();
      const blob = await captureVideoFrameBlob(ws.data, ctx, () => disposed || isStale());
      ctx = null;
      if (disposed || isStale()) return "";
      if (!blob) {
        markFrameFailed(filePath);
        return "";
      }

      // ④ JPEG 落盘（主进程缓存目录，不进坚果云同步）
      const buf = await blob.arrayBuffer();
      const saved = await api.files.saveVideoFrame(filePath, buf);
      if (disposed || isStale()) return "";
      if (saved?.success && saved.data) return saved.data;
      markFrameFailed(filePath);
      return "";
    } catch {
      markFrameFailed(filePath);
      return "";
    } finally {
      if (gotSlot) {
        activeFrameFetch--;
        pumpFrameFetch();
      }
    }
  })();

  return { promise, dispose };
}

export default function FileThumbnail(props: { filePath: string | null; fileType: string; class?: string }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal(false);
  let imgRef: HTMLImageElement | undefined;
  // 组件级加载序号：每次 filePath 变化自增，旧异步结果凭序号作废。
  // 不能用 onCleanup 闭包标志——实测 Solid 的 onCleanup 只在组件卸载时执行，
  // 效果重跑（切文件夹）时旧 Promise 仍存活，若无序号守卫会以旧文件夹的 URL 覆盖新状态（显示错图）。
  let loadId = 0;
  // v2.4.4：当前视频抓帧任务的 dispose（切换/卸载时即时释放 video/canvas 与排队槽位）
  let disposeFrame: (() => void) | null = null;
  // v2.4.6：组件卸载标志——图片缩略图 IPC 排队中的请求凭它跳过不发（loadId 在卸载时不变，守卫不到）
  let unmounted = false;

  // 组件顶层 onCleanup：仅在组件真正卸载（滚出视口/列表销毁）时清 src 释放解码位图。
  onCleanup(() => {
    unmounted = true;
    if (imgRef) imgRef.src = "";
    disposeFrame?.();
  });

  createEffect(() => {
    const fp = props.filePath;
    const id = ++loadId;
    // 切换文件时先释放上一抓帧任务的 video/canvas（旧异步结果由 loadId 守卫作废）
    disposeFrame?.();
    disposeFrame = null;
    // v2.1.0 决策：仅图片生成缩略图；PDF 以预览（pdfjs）查看为准，列表保持 📄 占位
    // v2.4.4：视频走渲染层抓帧缩略图；其余类型 emoji 占位
    if (!fp || (props.fileType !== "image" && props.fileType !== "video")) {
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

    // 未缓存：先卸下旧图（解码立即释放，不跨图叠放）→ 骨架屏 → 结果返回即显
    setUrl(null);

    if (props.fileType === "video") {
      // v2.4.4：视频抓帧（模块级并发 ≤2 + 15s 超时 + 失败黑名单，全流程容错）
      const task = captureVideoFrame(fp, () => id !== loadId);
      disposeFrame = task.dispose;
      task.promise
        .then((u) => {
          if (id !== loadId) return;
          if (u) setUrl(u);
          else setError(true);
        })
        .catch(() => {
          if (id !== loadId) return;
          setError(true);
        });
      return;
    }

    // v2.4.6：图片缩略图 IPC 走模块级并发闸（≤8，超出 FIFO 排队；排队期间卸载/过期跳过不发）。
    // LRU/错误剔除/骨架屏占位逻辑不变；槽位在 finally 释放并泵起后续排队请求
    void (async () => {
      let gotSlot = false;
      try {
        gotSlot = await awaitThumbSlot(() => unmounted || id !== loadId);
        if (!gotSlot || unmounted || id !== loadId) return; // 已卸载/已切到别的文件，过期请求不发
        const r = await (window.qihebox.files.thumbnailUrl(fp) as Promise<any>);
        if (unmounted || id !== loadId) return; // 已卸载/已切到别的文件，过期结果丢弃
        if (r?.success && r.data) {
          // 不在此处写缓存：URL 需经 img.onload 验证可加载后才进 LRU（IPC 返回不代表可解码）
          setUrl(r.data);
        } else {
          setError(true);
        }
      } catch {
        if (unmounted || id !== loadId) return;
        setError(true);
      } finally {
        if (gotSlot) {
          activeThumbFetch--;
          pumpThumbFetch();
        }
      }
    })();
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
          // v2.4.4：视频帧 URL 无法解码同样进黑名单（不重试，保持 🎬）
          if (props.fileType === "video" && fp) markFrameFailed(fp);
          setError(true);
        }}
      />
    </Show>
  );
}
