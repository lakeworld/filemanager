/**
 * 仪表盘统计（对照原 Go dashboard.go）
 * 纯 TS 业务层。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR } from './paths'
import { WorkspaceService, countFiles, formatTime } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, FileEntry } from './files'
import type { DashboardStats } from '../../shared/types'

export type { DashboardStats } from '../../shared/types'

export class DashboardService {
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
    private files: FilesService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /** 检查 30 天内到期证书（对照 checkExpiringCerts） */
  async checkExpiringCerts(): Promise<[string, string, string][]> {
    const ws = this.requireWS()
    const store = await this.metadata.loadMetadataStore()
    const threshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const result: [string, string, string][] = []
    for (const [key, meta] of Object.entries(store.files)) {
      if (!meta.expiry_date || !meta.expiry_date.trim()) continue
      const t = new Date(meta.expiry_date + 'T00:00:00')
      if (Number.isNaN(t.getTime())) continue
      if (t.getTime() > threshold.getTime()) continue
      const fileName = path.basename(key)
      const productSet = path.dirname(key)
      result.push([productSet, fileName, meta.expiry_date])
    }
    result.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
    return result
  }

  async dashboardStats(): Promise<DashboardStats> {
    const ws = this.requireWS()
    const stats: DashboardStats = {
      total_product_sets: 0,
      total_images: 0,
      total_certs: 0,
      expiring_certs: 0,
      recent_files: [],
    }
    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const entries = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [])
    stats.total_product_sets = entries.filter((e) => e.isDirectory()).length

    const allFiles: FileEntry[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const setDir = path.join(setsDir, e.name)
      const [imgFiles, certFiles] = await Promise.all([
        this.files.listDirFilesRecursive(path.join(setDir, IMAGES_DIR)),
        this.files.listDirFilesRecursive(path.join(setDir, CERTS_DIR)),
      ])
      stats.total_images += imgFiles.length
      stats.total_certs += certFiles.length
      allFiles.push(...imgFiles, ...certFiles)
    }
    allFiles.sort((a, b) => (a.modified > b.modified ? -1 : a.modified < b.modified ? 1 : 0))
    stats.recent_files = allFiles.slice(0, 10)

    const expiring = await this.checkExpiringCerts()
    stats.expiring_certs = expiring.length
    return stats
  }
}
