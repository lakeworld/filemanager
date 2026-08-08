/**
 * 缩略图服务（对照原 Go files.go ensureThumbnail / thumbnailPath；sharp 替代 nfnt/resize）
 * 保持 `.thumbnails/<sha256前2位>/<hash><ext>.thumb.jpg` 路径结构，旧缩略图兼容。
 * 生成放 worker 线程（阶段 6 优化为队列，当前先同步实现保证正确性）。
 */
import sharp from 'sharp'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { thumbnailPath, classifyFileType } from './core/paths'
import { WorkspaceService } from './core/workspace'
import type { ThumbnailProvider } from './core/files'

export class SharpThumbnailService implements ThumbnailProvider {
  constructor(private workspace: WorkspaceService) {}

  /** 限并发队列：批量导入时最多 2 个 sharp 任务并行，避免资源争抢 */
  private queue: Array<() => Promise<void>> = []
  private running = 0
  private readonly MAX_CONCURRENCY = 2

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

  async ensureThumbnail(filePath: string): Promise<string> {
    if (classifyFileType(filePath) !== 'image') return ''
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return ''
    const thumb = thumbnailPath(ws, filePath)
    // mtime 缓存检查：缩略图新于源图则复用（对照原 Go 逻辑）
    try {
      const [ti, si] = await Promise.all([fsp.stat(thumb), fsp.stat(filePath)])
      if (ti.mtimeMs > si.mtimeMs) return thumb
    } catch {
      // 缩略图或源图不存在 → 继续生成
    }
    return this.enqueue(async () => {
      try {
        await fsp.mkdir(path.dirname(thumb), { recursive: true })
        await sharp(filePath, { limitInputPixels: false })
          .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toFile(thumb)
        return thumb
      } catch (err) {
        console.error('[thumbnail] 生成失败:', filePath, err)
        return ''
      }
    })
  }

  async thumbnailUrl(filePath: string): Promise<string> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return ''
    const thumb = thumbnailPath(ws, filePath)
    try {
      await fsp.access(thumb)
      return thumb
    } catch {
      return ''
    }
  }

  async removeThumbnail(filePath: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) return
    await fsp.rm(thumbnailPath(ws, filePath), { force: true }).catch(() => {})
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
          await fsp.rm(thumbnailPath(ws, full), { force: true }).catch(() => {})
        }
      }
    }
    await walk(dir)
  }
}
