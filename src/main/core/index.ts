/**
 * BoxService：业务层组装（对应原 Go App 的高层 API 面）
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 *
 * 依赖注入：
 * - ThumbnailProvider（缩略图）由 main 层提供（sharp 实现）
 * - 平台能力（剪贴板/资源管理器/默认应用打开/对话框）不属于 core，由 main 层 ipc 直接处理
 */
import { WorkspaceService } from './workspace'
import type { ProductSetInfo } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, ThumbnailProvider } from './files'
import { DashboardService } from './dashboard'
import { SearchService } from './search'
import { XlsxService } from './xlsx'
import { PRODUCT_SETS_DIR, isPathInsideWorkspaceReal, classifyFileType } from './paths'
import { TagService } from './tags'
import { TrashService } from './trash'
import { ArchiveService } from './archive'
import path from 'node:path'
import fsp from 'node:fs/promises'

export class BoxService {
  workspace: WorkspaceService
  metadata: MetadataService
  files: FilesService
  dashboard: DashboardService
  search: SearchService
  xlsx: XlsxService
  tags: TagService
  trash: TrashService
  archive: ArchiveService
  private thumbs: ThumbnailProvider

  constructor(thumbs: ThumbnailProvider, workspace?: WorkspaceService) {
    this.workspace = workspace ?? new WorkspaceService()
    this.metadata = new MetadataService(this.workspace)
    this.trash = new TrashService(this.workspace, this.metadata, thumbs)
    this.files = new FilesService(this.workspace, this.metadata, thumbs, this.trash)
    this.dashboard = new DashboardService(this.workspace, this.metadata, this.files)
    this.search = new SearchService(this.workspace, this.files, this.metadata)
    this.xlsx = new XlsxService(this.workspace)
    this.tags = new TagService(this.workspace, this.metadata)
    this.archive = new ArchiveService(this.workspace)
    this.thumbs = thumbs
  }

  async xlsxExportTemplate(filePath: string): Promise<void> {
    return this.xlsx.exportTemplate(filePath)
  }

  async xlsxImport(filePath: string): Promise<ProductSetInfo[]> {
    return this.xlsx.importProductSets(filePath)
  }

  /** 删除产品集（v2.3.1：移入回收站；目录移走即从列表消失，extra 保留供恢复后还原 tags/notes） */
  async deleteProductSet(name: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    const dir = path.join(ws, PRODUCT_SETS_DIR, name.trim())
    await fsp.stat(dir)
    await this.trash.trashItem(ws, dir, 'productSet')
  }

  /** 确保图片/PDF 缩略图存在（缺失自动生成，mtime 命中直接返回），返回缩略图路径 */
  async ensureThumbnailFor(filePath: string, origin: 'browse' | 'background' = 'browse'): Promise<string> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
    const t = classifyFileType(filePath)
    if (t !== 'image' && t !== 'pdf') return ''
    return this.thumbs.ensureThumbnail(filePath, origin)
  }

  /**
   * v2.4.2（修复 2）：切文件夹入口调用——作废所有排队中的浏览缩略图任务，
   * 旧文件夹积压立即清空，新文件夹请求优先拿到生成槽位（根治切文件夹后图片长时间不渲染）。
   */
  beginBrowse(): void {
    this.thumbs.cancelPendingBrowse?.()
  }

  // —— v2.4.4：视频帧缩略图（能力由 ThumbnailProvider 可选方法提供）——

  videoThumbPathFor(filePath: string): string {
    return this.thumbs.videoThumbPath?.(filePath) ?? ''
  }

  async saveVideoFrame(filePath: string, data: Buffer): Promise<string> {
    const t = classifyFileType(filePath)
    if (t !== 'video') return ''
    // v2.4.6：修复脱绑调用（旧写法 const fn = this.thumbs.saveVideoFrame; fn(...) 丢失 this，
    // SharpThumbnailService 方法内部依赖 this.workspace → 缓存写入一直静默失败，每次访问重抓帧）
    return this.thumbs.saveVideoFrame ? this.thumbs.saveVideoFrame(filePath, data) : ''
  }

  async videoThumbnail(filePath: string): Promise<string> {
    const t = classifyFileType(filePath)
    if (t !== 'video') return ''
    // v2.4.6：同上修复脱绑调用（缓存读取静默失败 → mtime 命中永不生效）
    return this.thumbs.videoThumbnail ? this.thumbs.videoThumbnail(filePath) : ''
  }

  /** v2.4.6：图片预览降采样副本（能力由 ThumbnailProvider 可选方法提供；IPC 层已做工作区边界校验） */
  async ensurePreviewFor(filePath: string): Promise<string> {
    if (classifyFileType(filePath) !== 'image') return ''
    return this.thumbs.ensurePreview ? this.thumbs.ensurePreview(filePath) : ''
  }
}
