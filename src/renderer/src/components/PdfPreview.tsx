import { Show, createSignal, onMount, onCleanup } from "solid-js";
// 官方 PDFViewer 组件（pdfjs-dist/web）：连续滚动、渲染队列、文本层、缩放、搜索
// 注意：必须动态 import（组件顶层依赖全局 pdfjsLib，需先注入核心库）
import "pdfjs-dist/web/pdf_viewer.css";
// pdfjs worker 作为静态资源打包（vite ?url）：dev 与打包后 file:// 环境均可加载
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * PDF 预览（v2.2.1 终版）：基于 pdfjs-dist 官方 PDFViewer 组件
 * - 连续滚动 + 渲染队列（视口内渲染、空闲预渲染，翻页/滚动流畅）
 * - 文本层（文字可选中复制）+ 缩放（适配页面/宽度/自定义）+ 页码跳转
 * - 全文搜索（PDFFindController）
 * - 流式加载（Range）+ worker 单例 + 组件销毁清理
 */
interface PdfPreviewProps {
  url: string;
  onError?: (msg: string) => void;
  /** 加载完成后提供文本提取函数（供 AI 证书抽取；只取文本不上传图片） */
  onTextExtract?: (extract: () => Promise<string>) => void;
}

// worker blob URL 模块级单例（只建一次）
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
  let loadingTask: { destroy: () => Promise<void> } | null = null;

  // 惰性文本提取（前 5 页，2 万字符上限），供 AI 证书抽取
  const extractText = async (): Promise<string> => {
    if (!pdfDoc) return "";
    try {
      const parts: string[] = [];
      const maxPages = Math.min(pdfDoc.numPages, 5);
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdfDoc.getPage(i);
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
      // 官方 PDFViewer 组件通过全局 pdfjsLib 访问核心库（AbortException 等）——必须先注入再加载组件
      ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjs;
      const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import("pdfjs-dist/web/pdf_viewer");
      pdfjs.GlobalWorkerOptions.workerSrc = await getWorkerUrl();

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

      // 流式加载（Range）
      loadingTask = pdfjs.getDocument({ url: props.url, rangeChunkSize: 65536 });
      pdfDoc = await loadingTask.promise;
      setNumPages(pdfDoc.numPages);
      viewer.setDocument(pdfDoc);
      linkService.setDocument(pdfDoc, null);
      // 默认适配页面宽度
      viewer.currentScaleValue = "page-fit";
      setZoom(Math.round(viewer.currentScale * 100));
      props.onTextExtract?.(extractText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      props.onError?.(msg);
    } finally {
      setLoading(false);
    }
  });

  onCleanup(() => {
    try {
      void pdfDoc?.destroy?.();
    } catch { /* 忽略 */ }
    try {
      void loadingTask?.destroy?.();
    } catch { /* 忽略 */ }
    pdfDoc = null;
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
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-100 text-sm text-red-600">
            <span>PDF 预览失败：{error()}</span>
            <span class="text-surface-400 text-xs">可尝试用系统程序打开</span>
          </div>
        </Show>
      </div>
    </div>
  );
}
