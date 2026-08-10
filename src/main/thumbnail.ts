/**
 * 缩略图服务（对照原 Go files.go ensureThumbnail / thumbnailPath；sharp 替代 nfnt/resize）
 * v2.1.0：
 * - 缓存根迁移到 userData（app.getPath('userData')/thumbs/<workspaceHash>）：
 *   工作区不再被 .thumbnails 污染，坚果云目录不会被缓存文件刷屏
 * - 新增 PDF 首屏缩略图（pdfjs-dist + @napi-rs/canvas）：证书页 PDF 有真实预览图
 * - 旧工作区 .thumbnails 缓存自动回退/迁移：新位置 miss 时查旧位置，命中则复制（不删除旧文件）
 * 性能：sharp / pdfjs / canvas 均延迟加载（动态 import），启动不加载原生库。
 *
 * v2.4.2（修复 2）队列改造（ThumbQueue 为独立可测类）：
 * - 任务分来源：browse（浏览请求，插队队首）/ background（导入/改名/移动/拖拽图标）
 * - 代际作废：cancelPendingBrowse()（files:list 入口调用）作废所有排队中的 browse 任务 →
 *   切文件夹后旧积压立即清空，新文件夹请求优先拿到生成槽位
 * - 单任务 15s 超时（防 sharp 挂死/同步目录读阻塞占满 4 槽位 = 全局真死锁）
 * - 队列上限 200：background 超限快速失败；browse 不受限（切文件夹时会被代际作废清空）
 *
 * v2.4.6：新增预览降采样副本管线（ensurePreview）——渲染层图片预览不再 <img> 直挂原图
 * 全尺寸解码（6000×4000 解码位图 ~96MB，渲染进程 RSS 膨胀主因），改为 sharp 预生成
 * ≤2048px JPEG q85 副本，存缓存根 preview/ 子目录，走同一 qihebox://thumb 协议与长缓存头。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { thumbnailPath, classifyFileType } from './core/paths'
import { WorkspaceService } from './core/workspace'
import type { ThumbnailProvider, ThumbOrigin } from './core/files'

const THUMB_SIZE = 256
// v2.4.6：预览降采样副本边长上限（渲染层预览用大尺寸副本，原图不再进渲染进程全尺寸解码）
const PREVIEW_SIZE = 2048
const JPEG_QUALITY = 85

// v2.4.x 生成端内存上界：
// - fastShrinkOnLoad（sharp 0.33 起默认 true）：JPEG/WebP 按输出尺寸分载解码，超大原图不再全量进内存
// - limitInputPixels 兜底上限：实测该值按原始尺寸校验，因此取 250MP（≈15800×15800）——
//   容纳所有真实图片（电商图远小于此），仅拒绝会 OOM 的病态输入（千兆像素拼接全景等）
// v2.4.2（P0-1）：旧 `shrinkOnLoad` 选项名在 sharp 0.33 已移除（改名 fastShrinkOnLoad 且默认 true），
// 显式传旧名是 TS 类型错误且无效果，已删除。
const MAX_INPUT_PIXELS = 250_000_000

// v2.2.1：sharp/libvips 进程内缓存收紧（一次性设置）。
// 默认 50MB/20 句柄/100 操作对「磁盘缓存 + mtime 命中」的应用是白占内存与句柄。
let sharpCacheTuned = false
async function loadSharp(): Promise<typeof import('sharp')['default']> {
  const { default: sharp } = await import('sharp')
  if (!sharpCacheTuned) {
    sharpCacheTuned = true
    try {
      sharp.cache({ memory: 16, files: 4, items: 32 })
    } catch {
      // 缓存设置失败不影响功能
    }
  }
  return sharp
}

export interface ThumbnailServiceOptions {
  /** 缩略图缓存根（主进程传 app.getPath('userData')/thumbs）。不传则回退旧位置（工作区 .thumbnails） */
  userDataThumbsDir?: string
}

/** v2.4.2（修复 2）：单任务超时与队列上限 */
const TASK_TIMEOUT_MS = 15_000
const QUEUE_MAX = 200

interface QueueEntry<T> {
  origin: ThumbOrigin
  /** 作废时以「取消值」收尾（调用方按 falsy 处理为失败） */
  settle: () => void
  run: () => Promise<void>
}

/**
 * v2.4.2（修复 2）：限并发任务队列（纯逻辑，可 node 直测）。
 * - browse 任务插队队首；background 排队尾
 * - cancelPendingBrowse()：作废全部排队中的 browse 任务（settle 取消值），运行中任务不打断
 * - 单任务超时（taskTimeoutMs）：任务永不 settle 时释放槽位，杜绝全局死锁
 * - 队列上限（queueMax）：background 超限立即 settle 取消值
 */
export class ThumbQueue<T> {
  private queue: QueueEntry<T>[] = []
  private running = 0
  private cancelledValue: T

  constructor(
    private readonly maxConcurrency: number,
    private readonly taskTimeoutMs: number,
    private readonly queueMax: number,
  ) {
    this.cancelledValue = '' as unknown as T
  }

  /** 排队中任务数（测试断言用） */
  get pendingCount(): number {
    return this.queue.length
  }

  /** 运行中任务数（测试断言用） */
  get runningCount(): number {
    return this.running
  }

  /** 作废所有排队中的 browse 任务，返回作废数量 */
  cancelPendingBrowse(): number {
    let cancelled = 0
    const keep: QueueEntry<T>[] = []
    for (const e of this.queue) {
      if (e.origin === 'browse') {
        e.settle()
        cancelled++
      } else {
        keep.push(e)
      }
    }
    this.queue = keep
    return cancelled
  }

  enqueue(task: () => Promise<T>, origin: ThumbOrigin): Promise<T> {
    return new Promise<T>((resolve) => {
      let cancelled = false
      const entry: QueueEntry<T> = {
        origin,
        settle: () => {
          cancelled = true
          resolve(this.cancelledValue)
        },
        run: async () => {
          this.running++
          try {
            if (cancelled) {
              resolve(this.cancelledValue)
              return
            }
            resolve(await this.runWithTimeout(task))
          } catch {
            // 生成失败/超时统一按取消值收尾（前端显示占位，重进会重试）
            resolve(this.cancelledValue)
          } finally {
            this.running--
            this.pump()
          }
        },
      }
      // 队列上限：background 超限快速失败（browse 由代际作废清空，不受限）
      if (this.queue.length >= this.queueMax && origin === 'background') {
        resolve(this.cancelledValue)
        return
      }
      // 优先级：browse 插队队首（新文件夹优先），background 排队尾
      if (origin === 'browse') {
        this.queue.unshift(entry)
      } else {
        this.queue.push(entry)
      }
      this.pump()
    })
  }

  private runWithTimeout(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        void logWarn(`[thumbnail] 生成超时（${this.taskTimeoutMs}ms），按失败处理`)
        rej(new Error('缩略图生成超时'))
      }, this.taskTimeoutMs)
      timer.unref?.()
      task().then(
        (v) => {
          clearTimeout(timer)
          res(v)
        },
        (e) => {
          clearTimeout(timer)
          rej(e)
        },
      )
    })
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) void next.run()
    }
  }
}

export class SharpThumbnailService implements ThumbnailProvider {
  /** v2.4.2（修复 2）：限并发生成队列（browse 优先 + 代际作废 + 超时 + 上限） */
  private readonly genQueue = new ThumbQueue<string>(4, TASK_TIMEOUT_MS, QUEUE_MAX)
  /** v2.4.x 在途生成去重：同一路径并发请求共享一次生成（列表+预览同文件只生成一次） */
  private pending = new Map<string, Promise<string>>()

  constructor(
    private workspace: WorkspaceService,
    private opts: ThumbnailServiceOptions = {},
  ) {}

  /** 当前工作区对应的缓存根（新位置）；无 userData 配置时返回空（走旧位置） */
  currentThumbsRoot(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws || !this.opts.userDataThumbsDir) return ''
    return this.thumbRootFor(ws)
  }

  private thumbRootFor(ws: string): string {
    if (!this.opts.userDataThumbsDir) return ''
    // 工作区绝对路径 hash 前 8 位做子目录，避免多工作区同名相对路径冲突
    const hash = createHash('sha256').update(path.resolve(ws)).digest('hex').slice(0, 8)
    return path.join(this.opts.userDataThumbsDir, hash)
  }

  /** 新缓存位置（userData）；无配置时返回空串 */
  private newThumbPath(ws: string, filePath: string): string {
    const root = this.thumbRootFor(ws)
    return root ? thumbnailPath(ws, filePath, root) : ''
  }

  /** 旧缓存位置（工作区 .thumbnails，v2.0.x 及更早写入） */
  private legacyThumbPath(ws: string, filePath: string): string {
    return thumbnailPath(ws, filePath)
  }

  /**
   * v2.4.6：预览降采样副本位置（缓存根 preview/ 子目录，与缩略图同哈希推导）。
   * 无 userData 配置（thumbRootFor 返回 ''）时返回空串——不污染工作区，预览副本不做旧位置回退。
   */
  private previewPathFor(ws: string, filePath: string): string {
    const root = this.thumbRootFor(ws)
    return root ? thumbnailPath(ws, filePath, path.join(root, 'preview')) : ''
  }

  /** v2.4.2（修复 2）：作废所有排队中的浏览任务（切文件夹入口调用） */
  cancelPendingBrowse(): void {
    this.genQueue.cancelPendingBrowse()
  }

  /** 缩略图比源图新（mtime 命中）则复用，否则需重新生成 */
  private async isFresh(thumb: string, src: string): Promise<boolean> {
    if (!thumb) return false
    try {
      const [ti, si] = await Promise.all([fsp.stat(thumb), fsp.stat(src)])
      return ti.mtimeMs > si.mtimeMs
    } catch {
      return false
    }
  }

  async ensureThumbnail(filePath: string, origin: ThumbOrigin = 'background'): Promise<string> {
    // v2.1.0 决策：只给图片生成缩略图。PDF 缩略图曾用隐藏窗口 PDFium 渲染（成本高、
    // 失败回退占位等于白做），且真实证书渲染有原生崩溃史——证书以预览（pdfjs）查看为准
    const type = classifyFileType(filePath)
    if (type !== 'image') return ''
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return ''
    const newThumb = this.newThumbPath(ws, filePath)
    const legacyThumb = this.legacyThumbPath(ws, filePath)

    // 1. 新位置 mtime 命中 → 直接返回
    if (newThumb && (await this.isFresh(newThumb, filePath))) return newThumb
    // 2. 旧位置 mtime 命中 → 迁移复制到新位置（一次性），返回新位置
    if (await this.isFresh(legacyThumb, filePath)) {
      if (newThumb) {
        try {
          await fsp.mkdir(path.dirname(newThumb), { recursive: true })
          await fsp.copyFile(legacyThumb, newThumb)
          return newThumb
        } catch {
          return legacyThumb // 复制失败用旧位置，不阻断
        }
      }
      return legacyThumb
    }
    // 3. 生成（v2.4.x 在途去重：同一路径并发请求共享一次生成）
    const inFlight = this.pending.get(filePath)
    if (inFlight) return inFlight
    const task = this.genQueue.enqueue(
      async () => {
        try {
          const outPath = newThumb || legacyThumb
          // 延迟加载 sharp（首次生成缩略图时才加载原生库）+ 收紧 libvips 缓存
          const sharp = await loadSharp()
          await fsp.mkdir(path.dirname(outPath), { recursive: true })
          // v2.4.x：fastShrinkOnLoad 分载解码（默认开启）+ limitInputPixels 上限兜底
          await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
            .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toFile(outPath)
          return outPath
        } catch (err) {
          console.error('[thumbnail] 生成失败:', filePath, err)
          return ''
        } finally {
          this.pending.delete(filePath)
        }
      },
      origin,
    )
    this.pending.set(filePath, task)
    return task
  }

  /**
   * v2.4.6：确保图片预览降采样副本存在（渲染层预览用），返回副本路径。
   * 仅图片；无工作区/无 userData 缓存配置/生成失败 → 空串（渲染层回退原图）。
   * 与缩略图共用 genQueue（browse）与在途去重（key 加 'prev:' 前缀区分同文件缩略图任务）。
   */
  async ensurePreview(filePath: string): Promise<string> {
    if (classifyFileType(filePath) !== 'image') return ''
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return ''
    const preview = this.previewPathFor(ws, filePath)
    if (!preview) return ''
    // 1. mtime 命中 → 直接返回
    if (await this.isFresh(preview, filePath)) return preview
    // 2. 生成（在途去重）
    const key = `prev:${filePath}`
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const task = this.genQueue.enqueue(async () => {
      try {
        // 延迟加载 sharp 复用 loadSharp()（与缩略图同一原生库）
        const sharp = await loadSharp()
        await fsp.mkdir(path.dirname(preview), { recursive: true })
        await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
          .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY })
          .toFile(preview)
        return preview
      } catch (err) {
        console.error('[thumbnail] 预览副本生成失败:', filePath, err)
        return ''
      } finally {
        this.pending.delete(key)
      }
    }, 'browse')
    this.pending.set(key, task)
    return task
  }

  async thumbnailUrl(filePath: string): Promise<string> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return ''
    const newThumb = this.newThumbPath(ws, filePath)
    if (newThumb && (await this.isFresh(newThumb, filePath))) return newThumb
    const legacy = this.legacyThumbPath(ws, filePath)
    if (await this.isFresh(legacy, filePath)) return legacy
    return ''
  }

  // —— v2.4.4：视频帧缩略图（渲染层 <video>+canvas 抓帧，主进程仅落盘；与图片同根同哈希）——

  /** 视频帧缩略图路径（userData 缓存根；非视频返回空串） */
  videoThumbPath(filePath: string): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws || classifyFileType(filePath) !== 'video') return ''
    return this.newThumbPath(ws, filePath)
  }

  /** 写入渲染层抓取的视频帧（尺寸/大小已在 IPC 层校验） */
  async saveVideoFrame(filePath: string, data: Buffer): Promise<string> {
    const p = this.videoThumbPath(filePath)
    if (!p) return ''
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, data, { mode: 0o644 })
    return p
  }

  /** 视频帧缓存命中返回路径（mtime 校验），否则空串 */
  async videoThumbnail(filePath: string): Promise<string> {
    const p = this.videoThumbPath(filePath)
    if (p && (await this.isFresh(p, filePath))) return p
    return ''
  }

  async removeThumbnail(filePath: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return
    // v2.4.6：删缩略图时同步删预览降采样副本（preview/ 子目录，无配置时 previewPathFor 返回空被过滤）
    const paths = [this.newThumbPath(ws, filePath), this.legacyThumbPath(ws, filePath), this.previewPathFor(ws, filePath)].filter(Boolean)
    await Promise.all(paths.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
  }

  /** v2.4.2（D2）：批量删除多个文件的缩略图（回收站 purge 目录类条目用） */
  async removeThumbnails(files: string[]): Promise<void> {
    await Promise.all(files.map((f) => this.removeThumbnail(f)))
  }

  async removeThumbnailsInDir(dir: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return
    const walk = async (d: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          await walk(full)
        } else {
          // v2.4.6：同步删预览降采样副本
          const paths = [this.newThumbPath(ws, full), this.legacyThumbPath(ws, full), this.previewPathFor(ws, full)].filter(Boolean)
          await Promise.all(paths.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
        }
      }
    }
    await walk(dir)
  }
}

/** 超时告警日志（避免引入 electron 依赖，core 保持纯 TS 可测） */
function logWarn(msg: string): void {
  console.warn(`[main] ${msg}`)
}
