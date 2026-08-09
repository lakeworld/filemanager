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
  private thumbs: ThumbnailProvider

  constructor(thumbs: ThumbnailProvider, workspace?: WorkspaceService) {
    this.workspace = workspace ?? new WorkspaceService()
    this.metadata = new MetadataService(this.workspace)
    this.trash = new TrashService(this.workspace, this.metadata, thumbs)
    this.files = new FilesService(this.workspace, this.metadata, thumbs, this.trash)
    this.dashboard = new DashboardService(this.workspace, this.metadata, this.files)
    this.search = new SearchService(this.workspace, this.files)
    this.xlsx = new XlsxService(this.workspace)
    this.tags = new TagService(this.workspace, this.metadata)
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
}
