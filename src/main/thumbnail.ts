/**
 * 缩略图服务（对照原 Go files.go ensureThumbnail / thumbnailPath；sharp 替代 nfnt/resize）
 * v2.1.0：
 * - 缓存根迁移到 userData（app.getPath('userData')/thumbs/<workspaceHash>）：
 *   工作区不再被 .thumbnails 污染，坚果云目录不会被缓存文件刷屏
 * - 新增 PDF 首屏缩略图（pdfjs-dist + @napi-rs/canvas）：证书页 PDF 有真实预览图
 * - 旧工作区 .thumbnails 缓存自动回退/迁移：新位置 miss 时查旧位置，命中则复制（不删除旧文件）
 * 性能：sharp / pdfjs / canvas 均延迟加载（动态 import），启动不加载原生库。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { thumbnailPath, classifyFileType } from './core/paths'
import { WorkspaceService } from './core/workspace'
import type { ThumbnailProvider } from './core/files'

const THUMB_SIZE = 256
const JPEG_QUALITY = 85

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

export class SharpThumbnailService implements ThumbnailProvider {
  /** 限并发队列：批量导入时最多 2 个生成任务并行，避免资源争抢 */
  private queue: Array<() => Promise<void>> = []
  private running = 0
  private readonly MAX_CONCURRENCY = 2

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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async (): Promise<void> => {
        this.running++
        try {
          resolve(await task())
        } catch (e) {
          reject(e)
        } finally {
          this.running--
          this.pump()
        }
      }
      this.queue.push(run)
      this.pump()
    })
  }

  private pump(): void {
    while (this.running < this.MAX_CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) void next()
    }
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

  async ensureThumbnail(filePath: string): Promise<string> {
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
    // 3. 生成
    return this.enqueue(async () => {
      try {
        const outPath = newThumb || legacyThumb
        // 延迟加载 sharp（首次生成缩略图时才加载原生库）+ 收紧 libvips 缓存
        const sharp = await loadSharp()
        await fsp.mkdir(path.dirname(outPath), { recursive: true })
        await sharp(filePath, { limitInputPixels: false })
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: JPEG_QUALITY })
          .toFile(outPath)
        return outPath
      } catch (err) {
        console.error('[thumbnail] 生成失败:', filePath, err)
        return ''
      }
    })
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

  async removeThumbnail(filePath: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return
    const paths = [this.newThumbPath(ws, filePath), this.legacyThumbPath(ws, filePath)].filter(Boolean)
    await Promise.all(paths.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
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
          const paths = [this.newThumbPath(ws, full), this.legacyThumbPath(ws, full)].filter(Boolean)
          await Promise.all(paths.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
        }
      }
    }
    await walk(dir)
  }
}
