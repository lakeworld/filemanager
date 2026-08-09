/**
 * 仪表盘统计（对照原 Go dashboard.go）
 * 纯 TS 业务层。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR } from './paths'
import { WorkspaceService, countFiles, formatTime } from './workspace'
import { MetadataService, parseExpiryDate } from './metadata'
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

  /**
   * 检查 30 天内到期证书（对照 checkExpiringCerts）。
   * v2.4.2：
   * - C1：日期宽松解析（parseExpiryDate 兼容 YYYY/M/D、ISO 带时间等），非法日期记 warn 并跳过、不误伤其他
   * - C2：校验文件真实存在——已删除（回收站内）/外部删除的证书不再提醒（孤儿元数据不骚扰）
   * - P2：过期超过 30 天的证书不再按「即将到期」提醒
   */
  async checkExpiringCerts(): Promise<[string, string, string][]> {
    const ws = this.requireWS()
    const store = await this.metadata.loadMetadataStore()
    const now = Date.now()
    const upper = now + 30 * 24 * 60 * 60 * 1000
    const lower = now - 30 * 24 * 60 * 60 * 1000
    interface Row {
      ps: string
      file: string
      expiry: string
      filePath: string | null
    }
    const rows: Row[] = []
    let badDates = 0
    for (const [key, meta] of Object.entries(store.files)) {
      if (!meta.expiry_date || !meta.expiry_date.trim()) continue
      const t = parseExpiryDate(meta.expiry_date)
      if (Number.isNaN(t.getTime())) {
        badDates++
        continue
      }
      const ms = t.getTime()
      if (ms > upper || ms < lower) continue
      // 新 key：产品集/图包|证书/子文件夹/文件名（跨平台已统一 / 分隔符；兼容旧 \ key）
      const parts = key.replace(/\\/g, '/').split('/')
      let ps = ''
      let file = ''
      let filePath: string | null = null
      if (parts.length === 4 && (parts[1] === IMAGES_DIR || parts[1] === CERTS_DIR)) {
        ps = parts[0]
        file = parts[3]
        filePath = path.join(ws, PRODUCT_SETS_DIR, parts[0], parts[1], parts[2], parts[3])
      } else {
        // 旧 key：产品集/文件名 → 产品集内查找真实位置（找不到 = 已删除/已移走）
        ps = parts[0] ?? ''
        file = parts[parts.length - 1] ?? ''
        if (ps && file) filePath = await this.findFileInProductSet(ws, ps, file)
      }
      if (ps && file) rows.push({ ps, file, expiry: meta.expiry_date, filePath })
    }
    if (badDates > 0) {
      console.warn(`[cert] ${badDates} 条证书到期日期无法解析，已跳过（可在元数据中重新填写）`)
    }
    // C2：文件不存在的条目（回收站内 / 外部删除 / 迁移后未匹配）不提醒
    const alive = await Promise.all(
      rows.map(async (r) => {
        if (!r.filePath) return false
        try {
          await fsp.stat(r.filePath)
          return true
        } catch {
          return false
        }
      }),
    )
    const result: [string, string, string][] = []
    rows.forEach((r, i) => {
      if (alive[i]) result.push([r.ps, r.file, r.expiry])
    })
    result.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0))
    return result
  }

  /** 旧 key（产品集/文件名）在产品集 图包/证书 各子文件夹中查找同名文件（返回存在的第一个） */
  private async findFileInProductSet(ws: string, ps: string, file: string): Promise<string | null> {
    const setDir = path.join(ws, PRODUCT_SETS_DIR, ps)
    const candidates: string[] = []
    for (const type of [IMAGES_DIR, CERTS_DIR]) {
      const subs = await fsp.readdir(path.join(setDir, type), { withFileTypes: true }).catch(() => [])
      for (const s of subs) {
        if (!s.isDirectory()) continue
        candidates.push(path.join(setDir, type, s.name, file))
      }
    }
    for (const c of candidates) {
      if (await fsp.stat(c).then(() => true).catch(() => false)) return c
    }
    return null
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
