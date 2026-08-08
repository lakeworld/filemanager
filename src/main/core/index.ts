/**
 * BoxService：业务层组装（对应原 Go App 的高层 API 面）
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 *
 * 依赖注入：
 * - ThumbnailProvider（缩略图）由 main 层提供（sharp 实现）
 * - 平台能力（剪贴板/资源管理器/默认应用打开/对话框）不属于 core，由 main 层 ipc 直接处理
 */
import { WorkspaceService } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, ThumbnailProvider } from './files'
import { DashboardService } from './dashboard'
import { SearchService } from './search'
import { XlsxService } from './xlsx'
import { PRODUCT_SETS_DIR } from './paths'
import path from 'node:path'
import fsp from 'node:fs/promises'

export class BoxService {
  workspace: WorkspaceService
  metadata: MetadataService
  files: FilesService
  dashboard: DashboardService
  search: SearchService
  xlsx: XlsxService
  private thumbs: ThumbnailProvider

  constructor(thumbs: ThumbnailProvider, workspace?: WorkspaceService) {
    this.workspace = workspace ?? new WorkspaceService()
    this.metadata = new MetadataService(this.workspace)
    this.files = new FilesService(this.workspace, this.metadata, thumbs)
    this.dashboard = new DashboardService(this.workspace, this.metadata, this.files)
    this.search = new SearchService(this.workspace, this.files)
    this.xlsx = new XlsxService(this.workspace)
    this.thumbs = thumbs
  }

  async xlsxExportTemplate(filePath: string): Promise<void> {
    return this.xlsx.exportTemplate(filePath)
  }

  async xlsxImport(filePath: string): Promise<ProductSetInfo[]> {
    return this.xlsx.importProductSets(filePath)
  }

  /** 删除产品集：缩略图 + 元数据 + 目录（组合编排） */
  async deleteProductSet(name: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    const dir = path.join(ws, PRODUCT_SETS_DIR, name.trim())
    await fsp.stat(dir)
    await this.thumbs.removeThumbnailsInDir(dir)
    await this.workspace.productSetDelete(name)
    await this.metadata.removeFileMetadataForProductSet(name.trim())
  }
}
