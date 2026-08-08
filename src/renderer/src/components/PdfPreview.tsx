import { Show, createEffect, createSignal, onMount } from "solid-js";
// pdfjs worker 作为静态资源打包（vite ?url）：dev 与打包后 file:// 环境均可加载
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * PDF 预览（v2.1.0 崩溃/不渲染修复）
 * Chromium 内置 PDFium 不渲染 iframe 中的 qihebox:// 自定义协议 PDF，
 * 改用 pdfjs-dist 在渲染进程渲染到 canvas（支持翻页/缩放）。
 * 渲染进程崩溃由主进程 crash-recovery 兜底，不会导致整个应用闪退。
 */
interface PdfPreviewProps {
  url: string;
  onError?: (msg: string) => void;
}

export default function PdfPreview(props: PdfPreviewProps) {
  let canvasRef: HTMLCanvasElement | undefined;
  const [pageNum, setPageNum] = createSignal(1);
  const [numPages, setNumPages] = createSignal(0);
  const [scale, setScale] = createSignal(1);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");

  // pdfjs 类型体系复杂（PDFDocumentProxy/RenderTask），组件内用宽松类型
  let doc: any = null
  let renderTask: { promise: Promise<unknown>; cancel: () => void } | null = null

  const renderPage = async (num: number, s: number): Promise<void> => {
    if (!doc || !canvasRef) return
    const pending = renderTask
    if (pending) {
      pending.cancel()
      renderTask = null
    }
    const page = await doc.getPage(num)
    const viewport = page.getViewport({ scale: s })
    canvasRef.width = Math.max(1, Math.floor(viewport.width))
    canvasRef.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvasRef.getContext("2d")
    if (!ctx) return
    const task = page.render({ canvasContext: ctx, viewport })
    renderTask = task
    await task.promise
    renderTask = null
  }

  onMount(async () => {
    try {
      setLoading(true)
      const pdfjs = await import("pdfjs-dist")
      // workerSrc 用 blob URL：asar 内 worker 文件无法被 new Worker 直接加载（Electron 经典坑），
      // fetch 出字节 → objectURL，dev 与打包环境通用
      const workerResp = await fetch(pdfWorkerUrl)
      const workerBlob = await workerResp.blob()
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob)
      const resp = await fetch(props.url)
      if (!resp.ok) throw new Error(`PDF 加载失败 (${resp.status})`)
      const buf = await resp.arrayBuffer()
      const loadingTask = pdfjs.getDocument({ data: buf })
      doc = await loadingTask.promise
      setNumPages(doc.numPages)
      await renderPage(1, scale())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      props.onError?.(msg)
    } finally {
      setLoading(false)
    }
  })

  createEffect(() => {
    const n = pageNum()
    const s = scale()
    if (doc && n >= 1 && n <= numPages()) {
      void renderPage(n, s).catch(() => {})
    }
  })

  const prev = () => setPageNum((n) => Math.max(1, n - 1))
  const next = () => setPageNum((n) => Math.min(numPages(), n + 1))
  const zoomIn = () => setScale((s) => Math.min(3, Math.round((s + 0.25) * 100) / 100))
  const zoomOut = () => setScale((s) => Math.max(0.25, Math.round((s - 0.25) * 100) / 100))

  return (
    <div class="w-full h-full flex flex-col">
      <Show when={error()} fallback={
        <Show when={loading()} fallback={
          <div class="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-surface-50 rounded-lg">
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
  )
}
