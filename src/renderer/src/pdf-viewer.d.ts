/**
 * pdfjs-dist/web/pdf_viewer 官方组件模块声明。
 * 该模块（pdf_viewer.js）未自带 .d.ts，这里按 PdfPreview.tsx 实际用到的符号做宽松声明，
 * 保证类型检查通过即可；具体行为以 pdfjs-dist 运行时为准。
 */
declare module 'pdfjs-dist/web/pdf_viewer' {
  export class EventBus {
    constructor(options?: unknown)
    on(eventName: string, listener: (e: any) => void): void
    off(eventName: string, listener: (e: any) => void): void
    dispatch(eventName: string, data: unknown): void
  }

  export class PDFLinkService {
    constructor(options?: unknown)
    setViewer(viewer: unknown): void
    setDocument(doc: unknown, baseUrl?: unknown): void
  }

  export class PDFFindController {
    constructor(options?: unknown)
  }

  export class PDFViewer {
    constructor(options: unknown)
    setDocument(doc: unknown): void
    currentPageNumber: number
    currentScale: number
    currentScaleValue: string | number
  }
}
