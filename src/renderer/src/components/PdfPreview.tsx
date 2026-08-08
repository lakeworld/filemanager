import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
// pdfjs worker 作为静态资源打包（vite ?url）：dev 与打包后 file:// 环境均可加载
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * PDF 预览（v2.2.1 深度优化，按 PDF 调研报告 A 方案）
 * 供独立预览窗口（#/preview）使用：
 * - 流式加载：getDocument({ url }) 走 Range 请求（qihebox:// 协议已支持 206），
 *   不再全量把整个 PDF 读进内存；协议不支持 Range 时 pdfjs 自动回退全量
 * - 页缓存 LRU（6 页）：翻页/缩放命中复用 canvas，避免整页重画
 * - 降采样：渲染分辨率限制在适配容器所需，大扫描件不全分辨率铺满
 * - 渲染队列：只渲染最新目标页，快速翻页取消中间任务（吞 RenderingCancelledException）
 * - worker 模块级单例 + 组件销毁时 doc.destroy()/loadingTask.destroy()
 */
interface PdfPreviewProps {
  url: string;
  onError?: (msg: string) => void;
  /** PDF 加载完成后提供文本提取函数（供 AI 证书抽取；只取文本不上传图片） */
  onTextExtract?: (extract: () => Promise<string>) => void;
}

// worker blob URL 模块级单例（只建一次，避免每次打开重建/泄漏）
let workerUrlPromise: Promise<string> | null = null;
function getWorkerUrl(): Promise<string> {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      const workerResp = await fetch(pdfWorkerUrl);
      const workerBlob = await workerResp.blob();
      return URL.createObjectURL(workerBlob);
    })();
  }
  return workerUrlPromise;
}

const PAGE_CACHE_MAX = 6;

export default function PdfPreview(props: PdfPreviewProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  const [pageNum, setPageNum] = createSignal(1);
  const [numPages, setNumPages] = createSignal(0);
  const [scale, setScale] = createSignal(1);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");

  // pdfjs 类型体系复杂，组件内用宽松类型
  let doc: any = null;
  let loadingTask: { destroy: () => Promise<void> } | null = null;
  let renderTask: { promise: Promise<unknown>; cancel: () => void } | null = null;
  let renderSeq = 0;
  // 页缓存：pageNum → { canvas, scale }
  const pageCache = new Map<number, { canvas: HTMLCanvasElement; scale: number }>();

  const renderPage = async (num: number, s: number): Promise<void> => {
    if (!doc || !canvasRef) return;
    const seq = ++renderSeq;

    // 命中页缓存：直接复用 canvas
    const cached = pageCache.get(num);
    if (cached && cached.scale === s) {
      drawCached(cached.canvas);
      return;
    }
    if (cached && cached.scale !== s) {
      // 缩放变化：先 drawImage 放大旧图占位，再异步重渲（渐进体验）
      drawCached(cached.canvas);
    }

    const pending = renderTask;
    if (pending) {
      try {
        pending.cancel();
      } catch {
        // 忽略取消异常
      }
      renderTask = null;
    }
    const page = await doc.getPage(num);
    if (seq !== renderSeq || !canvasRef) {
      page.cleanup?.();
      return;
    }
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    // 降采样：限制渲染分辨率不超过适配容器需要
    const maxW = containerRef?.clientWidth ? containerRef.clientWidth - 24 : 0;
    const maxH = containerRef?.clientHeight ? containerRef.clientHeight - 24 : 0;
    let renderScale = s;
    if (maxW > 0 && maxH > 0) {
      const fitW = maxW / viewport.width;
      const fitH = maxH / viewport.height;
      const fit = Math.min(fitW, fitH, 1);
      // 基础视图（scale<=1）降采样到适配；放大视图保留用户缩放比例
      renderScale = s <= 1.05 ? Math.max(0.5, s * fit * 0.98) : s;
    }
    const rv = page.getViewport({ scale: renderScale });
    canvas.width = Math.max(1, Math.floor(rv.width));
    canvas.height = Math.max(1, Math.floor(rv.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const task = page.render({ canvasContext: ctx, viewport: rv });
    renderTask = task;
    try {
      await task.promise;
    } catch (e: unknown) {
      // 渲染取消是正常流程（快速翻页），不算错误
      if ((e as { name?: string })?.name !== "RenderingCancelledException") {
        throw e;
      }
      return;
    } finally {
      if (renderTask === task) renderTask = null;
      page.cleanup?.();
    }
    if (seq !== renderSeq || !canvasRef) return;
    // 写回主 canvas
    canvasRef.width = canvas.width;
    canvasRef.height = canvas.height;
    const ctx2 = canvasRef.getContext("2d");
    ctx2?.drawImage(canvas, 0, 0);
    // 缓存（LRU）
    if (pageCache.size >= PAGE_CACHE_MAX) {
      const first = pageCache.keys().next().value;
      if (first !== undefined) pageCache.delete(first);
    }
    pageCache.set(num, { canvas, scale: s });
  };

  const drawCached = (c: HTMLCanvasElement): void => {
    if (!canvasRef) return;
    canvasRef.width = c.width;
    canvasRef.height = c.height;
    canvasRef.getContext("2d")?.drawImage(c, 0, 0);
  };

  // v2.2.0：惰性提取 PDF 文本（前 5 页，2 万字符上限），供 AI 证书抽取使用
  const extractText = async (): Promise<string> => {
    if (!doc) return "";
    try {
      const parts: string[] = [];
      const maxPages = Math.min(doc.numPages, 5);
      for (let i = 1; i <= maxPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const str = (tc.items as { str?: string }[])
          .map((it) => (typeof it.str === "string" ? it.str : ""))
          .join(" ");
        parts.push(str);
        if (parts.join("\n").length > 12000) break;
      }
      return parts.join("\n").slice(0, 20000);
    } catch {
      return "";
    }
  };

  onMount(async () => {
    try {
      setLoading(true);
      const pdfjs = await import("pdfjs-dist");
      // worker 单例（blob URL 只建一次）
      pdfjs.GlobalWorkerOptions.workerSrc = await getWorkerUrl();
      // 流式加载：走 Range 请求（协议层支持 206），不全量读内存
      const loading = pdfjs.getDocument({ url: props.url, rangeChunkSize: 65536 });
      loadingTask = loading;
      doc = await loading.promise;
      setNumPages(doc.numPages);
      props.onTextExtract?.(extractText);
      await renderPage(1, scale());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      props.onError?.(msg);
    } finally {
      setLoading(false);
    }
  });

  createEffect(() => {
    const n = pageNum();
    const s = scale();
    if (doc && n >= 1 && n <= numPages()) {
      void renderPage(n, s).catch(() => {});
    }
  });

  onCleanup(() => {
    renderSeq++;
    try {
      renderTask?.cancel();
    } catch {
      // 忽略
    }
    renderTask = null;
    pageCache.clear();
    try {
      void doc?.destroy?.();
    } catch {
      // 忽略
    }
    try {
      void loadingTask?.destroy?.();
    } catch {
      // 忽略
    }
    doc = null;
  });

  const prev = () => setPageNum((n) => Math.max(1, n - 1));
  const next = () => setPageNum((n) => Math.min(numPages(), n + 1));
  const zoomIn = () => setScale((s) => Math.min(4, Math.round((s + 0.25) * 100) / 100));
  const zoomOut = () => setScale((s) => Math.max(0.5, Math.round((s - 0.25) * 100) / 100));

  return (
    <div class="w-full h-full flex flex-col">
      <Show when={error()} fallback={
        <Show when={loading()} fallback={
          <div ref={containerRef} class="flex-1 min-h-0 flex items-center justify-center overflow-auto bg-surface-50 rounded-lg">
            <canvas ref={canvasRef} class="max-w-full max-h-full shadow-sm" />
          </div>
        }>
          <div class="flex-1 flex items-center justify-center text-surface-400">PDF 加载中…</div>
        </Show>
      }>
        <div class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-red-600">
          <span>PDF 预览失败：{error()}</span>
          <span class="text-surface-400 text-xs">可尝试用系统程序打开</span>
        </div>
      </Show>
      <Show when={!error() && numPages() > 0}>
        <div class="flex items-center justify-center gap-3 mt-3 text-xs text-surface-600 shrink-0">
          <button class="btn-secondary px-2 py-1" onClick={zoomOut} title="缩小">−</button>
          <button class="btn-secondary px-2 py-1" onClick={prev} disabled={pageNum() <= 1}>上一页</button>
          <span>{pageNum()} / {numPages()}</span>
          <button class="btn-secondary px-2 py-1" onClick={next} disabled={pageNum() >= numPages()}>下一页</button>
          <button class="btn-secondary px-2 py-1" onClick={zoomIn} title="放大">+</button>
        </div>
      </Show>
    </div>
  );
}
