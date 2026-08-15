import { Show, createSignal, onMount, onCleanup } from "solid-js";
// 官方 PDFViewer 组件（pdfjs-dist/web）：连续滚动、渲染队列、文本层、缩放、搜索
// 注意：必须动态 import（组件顶层依赖全局 pdfjsLib，需先注入核心库）
import type { PDFViewer, PDFLinkService, PDFFindController, EventBus } from "pdfjs-dist/web/pdf_viewer";
import "pdfjs-dist/web/pdf_viewer.css";
// v2.4.2（P1-P3 修复 dev 下 PDF 打不开的根因）：
// dev 下 vite 会给经 module graph 服务的文件注入 `import "/@vite/client"`，从 blob: URL 建模块 worker
// 无法解析该裸路径（"Invalid relative url or base scheme isn't hierarchical"）→ worker 失败 → PDF 打不开。
// 已实测：?url / 动态 ?raw / 直接 URL 三种方式在 dev 下均不可用，唯独「静态 ?raw + optimizeDeps.exclude
// （electron.vite.config.ts）取原始源码」可用。生产构建中 import.meta.env.DEV 为 false，
// ?raw 分支被死代码消除（不内联进主包），worker 仍走 ?url 独立资产（打包体积不变）。
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import pdfWorkerRaw from "pdfjs-dist/build/pdf.worker.min.mjs?raw";

/**
 * PDF 预览（v2.2.1 终版）：基于 pdfjs-dist 官方 PDFViewer 组件
 * - 连续滚动 + 渲染队列（视口内渲染、空闲预渲染，翻页/滚动流畅）
 * - 文本层（文字可选中复制）+ 缩放（适配页面/宽度/自定义）+ 页码跳转
 * - 全文搜索（PDFFindController）
 * - v2.4.2（P1-P1）：pdfjs 对非 http(s) 协议（qihebox://）不发 Range，实际为整文件加载——
 *   rangeChunkSize 是死参数，已删除；超大文件（>100MB）由 FilePreviewModal 拦截至「用系统程序打开」
 * - v2.4.2（P1-P3）：disposed 标志防异步挂载竞态——加载中关闭弹窗时，后续 await 立即销毁并返回，
 *   不再往已卸载 DOM 渲染、不再泄漏 PDFDocument + worker
 * - worker 单例 + 组件销毁清理
 */
interface PdfPreviewProps {
  url: string;
  onError?: (msg: string) => void;
}

// worker blob URL 模块级单例（只建一次，dev/prod 共用；单例 blob 与应用同生命周期，不 revoke）
let workerUrlPromise: Promise<string> | null = null;
function getWorkerUrl(): Promise<string> {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      if (import.meta.env.DEV) {
        // dev：用 ?raw 原始源码打 blob（无 vite 注入，实测唯一可用方式）
        const workerBlob = new Blob([pdfWorkerRaw], { type: "text/javascript" });
        return URL.createObjectURL(workerBlob);
      }
      const workerResp = await fetch(pdfWorkerUrl);
      const workerBlob = await workerResp.blob();
      return URL.createObjectURL(workerBlob);
    })();
  }
  return workerUrlPromise;
}

export default function PdfPreview(props: PdfPreviewProps) {
  let containerRef: HTMLDivElement | undefined;
  let viewerRef: HTMLDivElement | undefined;
  const [pageNum, setPageNum] = createSignal(0);
  const [numPages, setNumPages] = createSignal(0);
  const [zoom, setZoom] = createSignal(100);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchText, setSearchText] = createSignal("");
  const [matchInfo, setMatchInfo] = createSignal("");

  let viewer: PDFViewer | null = null;
  let linkService: PDFLinkService | null = null;
  let findController: PDFFindController | null = null;
  let eventBus: EventBus | null = null;
  let pdfDoc: any = null;
  let loadingTask: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null;
  /** v2.4.2（P1-P3）：组件已卸载标记——onCleanup 先置位，onMount 每个 await 后检查 */
  let disposed = false;

  /** 销毁 PDF 文档/加载任务（重复销毁的 rejection 吞掉，避免 unhandled rejection 噪音） */
  const destroyAll = () => {
    void pdfDoc?.destroy?.().catch(() => {});
    void loadingTask?.destroy?.().catch(() => {});
    pdfDoc = null;
    loadingTask = null;
  };

  onMount(async () => {
    try {
      setLoading(true);
      const pdfjs = await import("pdfjs-dist");
      if (disposed) return;
      // 官方 PDFViewer 组件通过全局 pdfjsLib 访问核心库（AbortException 等）——必须先注入再加载组件
      ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
      const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import("pdfjs-dist/web/pdf_viewer");
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = await getWorkerUrl();
      if (disposed) return;

      eventBus = new EventBus();
      linkService = new PDFLinkService({ eventBus });
      findController = new PDFFindController({ linkService, eventBus });
      viewer = new PDFViewer({
        container: containerRef!,
        viewer: viewerRef!,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1,
      });
      linkService.setViewer(viewer);

      // 页码 / 缩放同步
      eventBus.on("pagechanging", (e: { pageNumber: number }) => setPageNum(e.pageNumber));
      eventBus.on("scalechanging", (e: { scale: number }) => setZoom(Math.round(e.scale * 100)));
      // 搜索匹配数
      eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } | null }) => {
        const m = e.matchesCount;
        setMatchInfo(m && m.total > 0 ? `${m.current}/${m.total}` : "");
      });

      // 整文件加载（v2.4.2 P1-P1：非 http 协议 pdfjs 不支持 Range）
      loadingTask = pdfjs.getDocument({ url: props.url });
      pdfDoc = await loadingTask.promise;
      if (disposed) {
        destroyAll();
        return;
      }
      setNumPages(pdfDoc.numPages);
      viewer.setDocument(pdfDoc);
      linkService.setDocument(pdfDoc, null);
      // 默认适配页面宽度
      viewer.currentScaleValue = "page-fit";
      setZoom(Math.round(viewer.currentScale * 100));
    } catch (e) {
      if (disposed) {
        destroyAll();
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      props.onError?.(msg);
    } finally {
      if (!disposed) setLoading(false);
    }
  });

  onCleanup(() => {
    disposed = true;
    destroyAll();
    viewer = null;
    linkService = null;
    findController = null;
    eventBus = null;
  });

  // —— 工具条操作 ——
  const goPrev = () => {
    if (viewer && pageNum() > 1) viewer.currentPageNumber = pageNum() - 1;
  };
  const goNext = () => {
    if (viewer && pageNum() < numPages()) viewer.currentPageNumber = pageNum() + 1;
  };
  const zoomIn = () => {
    if (viewer) viewer.currentScale = Math.min(4, viewer.currentScale * 1.2);
  };
  const zoomOut = () => {
    if (viewer) viewer.currentScale = Math.max(0.4, viewer.currentScale / 1.2);
  };
  const fitPage = () => {
    if (viewer) viewer.currentScaleValue = "page-fit";
  };
  const doSearch = (query: string, findPrevious = false) => {
    if (!eventBus) return;
    eventBus.dispatch("find", {
      type: "",
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
    });
  };
  const searchNext = () => searchText() && doSearch(searchText(), false);
  const searchPrev = () => searchText() && doSearch(searchText(), true);

  return (
    <div class="flex flex-col w-full h-full min-h-0">
      {/* 工具条 */}
      <div class="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-surface-200 shrink-0 flex-wrap">
        <button class="btn-secondary px-2 py-1 text-xs" onClick={goPrev} disabled={!numPages() || pageNum() <= 1}>
          ← 上一页
        </button>
        <span class="text-xs text-surface-600 whitespace-nowrap">
          {pageNum()} / {numPages()}
        </span>
        <button class="btn-secondary px-2 py-1 text-xs" onClick={goNext} disabled={!numPages() || pageNum() >= numPages()}>
          下一页 →
        </button>
        <span class="w-px h-4 bg-surface-200 mx-1" />
        <button class="btn-secondary px-2 py-1 text-xs" onClick={zoomOut} title="缩小">−</button>
        <button class="btn-secondary px-2 py-1 text-xs" onClick={fitPage} title="适配页面">{zoom()}%</button>
        <button class="btn-secondary px-2 py-1 text-xs" onClick={zoomIn} title="放大">+</button>
        <span class="w-px h-4 bg-surface-200 mx-1" />
        <button
          class={`btn-secondary px-2 py-1 text-xs ${searchOpen() ? "bg-primary-50 text-primary-700" : ""}`}
          onClick={() => setSearchOpen((v) => !v)}
        >
          🔍 搜索
        </button>
        <Show when={searchOpen()}>
          <div class="flex items-center gap-1">
            <input
              type="text"
              class="w-36 px-2 py-1 border border-surface-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary-400"
              placeholder="输入查找内容..."
              value={searchText()}
              onInput={(e) => {
                setSearchText(e.currentTarget.value);
                if (e.currentTarget.value) doSearch(e.currentTarget.value);
              }}
              onKeyDown={(e) => e.key === "Enter" && searchNext()}
            />
            <button class="btn-secondary px-2 py-1 text-xs" onClick={searchPrev} title="上一处">↑</button>
            <button class="btn-secondary px-2 py-1 text-xs" onClick={searchNext} title="下一处">↓</button>
            <Show when={matchInfo()}>
              <span class="text-xs text-primary-600 whitespace-nowrap">{matchInfo()}</span>
            </Show>
          </div>
        </Show>
      </div>

      {/* 查看区：容器恒渲染（ref 在 onMount 前绑定），loading/error 用覆盖层 */}
      <div class="relative flex-1 min-h-0">
        <div ref={containerRef} class="absolute inset-0 overflow-auto bg-surface-100">
          <div ref={viewerRef} class="pdfViewer" />
        </div>
        <Show when={loading()}>
          <div class="absolute inset-0 flex items-center justify-center bg-surface-100 text-surface-400">PDF 加载中…</div>
        </Show>
        <Show when={error() && !loading()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-100 text-sm text-danger-600">
            <span>PDF 预览失败：{error()}</span>
            <span class="text-surface-400 text-xs">可尝试用系统程序打开</span>
          </div>
        </Show>
      </div>
    </div>
  );
}
