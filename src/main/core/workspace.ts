/**
 * 工作区 / 产品集 / 配置 / 最近工作区（对照原 Go workspace.go）
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  WorkspaceConfig,
  defaultWorkspaceConfig,
  ensureWorkspaceDirs,
  configPath,
  productSetsInfoPath,
  recentPath,
  productSetRootPath,
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  DOCS_DIR,
  CUSTOMERS_DIR,
  filterSlice,
  writeJsonAtomic,
  readJsonFile,
  assertSafeFolderName,
  isReservedRootName,
} from './paths'
import { globalCountCache } from './scanCache'
import { globalWorkspaceIndex } from './indexCache'
import type { WorkspaceInfo, ProductSetInfo, ProductSetStats, ProductSetCreateRequest, ProductSetUpdateRequest } from '../../shared/types'

export type { WorkspaceInfo, ProductSetInfo, ProductSetStats, ProductSetCreateRequest, ProductSetUpdateRequest } from '../../shared/types'

/** 产品集附加信息（tags/notes），持久化于 .qihefilemanager/product_sets.json */
export interface ProductSetExtraInfo {
  tags: string[]
  notes: string
}

export function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 递归统计目录内非隐藏文件数（带 mtime 签名缓存，原 countFiles 同步版 → 缓存异步版） */
export async function countFiles(dir: string): Promise<number> {
  return globalCountCache.countFiles(dir)
}

export class WorkspaceService {
  private currentWS = ''
  private homeDir: string
  private onWorkspaceChangedCb?: () => void

  constructor(homeDir?: string) {
    // 测试时注入临时目录，避免污染真实用户 recents
    this.homeDir = homeDir ?? os.homedir()
  }

  /** 当前工作区路径（原 App.currentWorkspacePath） */
  currentWorkspacePath(): string {
    return this.currentWS
  }

  private recentFilePath(): string {
    return recentPath(this.homeDir)
  }

  /** 注册工作区切换回调（index.ts 用于切换时重建文件监听；纯回调，不依赖 electron） */
  onWorkspaceChanged(cb: () => void): void {
    this.onWorkspaceChangedCb = cb
  }

  async setCurrentWorkspace(workspace: string): Promise<void> {
    if (!workspace) {
      this.currentWS = ''
      return
    }
    const stat = await fsp.stat(workspace)
    if (!stat.isDirectory()) throw new Error('不是有效目录')
    ensureWorkspaceDirs(workspace)
    this.currentWS = workspace
    globalCountCache.clear() // 切换工作区后清理扫描缓存
    globalWorkspaceIndex.clear() // v2.4.x：切换工作区后清理文件索引快照
    await this.addRecentWorkspace(workspace)
    this.onWorkspaceChangedCb?.() // v2.4.x：通知 index.ts 重建新工作区的文件监听
  }

  // —— 最近工作区（对照 addRecentWorkspace / loadRecentWorkspaces）——

  async addRecentWorkspace(workspace: string): Promise<void> {
    const recents = await this.loadRecentWorkspaces()
    const list = [workspace, ...recents.filter((r) => r !== workspace)].slice(0, 10)
    await writeJsonAtomic(this.recentFilePath(), list)
  }

  async loadRecentWorkspaces(): Promise<string[]> {
    const data = await readJsonFile<string[]>(this.recentFilePath())
    if (!data) return []
    const list: string[] = []
    for (const p of data) {
      try {
        const s = await fsp.stat(p)
        if (s.isDirectory()) list.push(p)
      } catch {
        // 目录不存在则过滤
      }
    }
    return list
  }

  // —— 配置（对照 loadConfig / saveConfig / GetWorkspaceConfig / UpdateWorkspaceConfig）——

  async loadConfig(workspace?: string): Promise<WorkspaceConfig> {
    const ws = workspace ?? this.currentWS
    const cfg = await readJsonFile<WorkspaceConfig>(configPath(ws))
    if (!cfg) {
      const def = defaultWorkspaceConfig()
      await this.saveConfig(ws, def)
      return def
    }
    // v2.4.7：旧 config 缺 customer_subfolders → 合并默认值并写回（向后兼容零迁移；
    // 已存在但为空数组 = 用户主动清空，不覆盖）
    if (cfg.customer_subfolders === undefined || cfg.customer_subfolders === null) {
      cfg.customer_subfolders = defaultWorkspaceConfig().customer_subfolders
      await this.saveConfig(ws, cfg)
    }
    // v2.5.1（F1，D30）：旧 config 缺 doc_subfolders → 合并默认值并写回（同 customer 机制）
    if (cfg.doc_subfolders === undefined || cfg.doc_subfolders === null) {
      cfg.doc_subfolders = defaultWorkspaceConfig().doc_subfolders
      await this.saveConfig(ws, cfg)
    }
    return cfg
  }

  async saveConfig(workspace: string, cfg: WorkspaceConfig): Promise<void> {
    ensureWorkspaceDirs(workspace)
    await writeJsonAtomic(configPath(workspace), cfg)
  }

  // —— 产品集附加信息（对照 loadProductSetsInfo / saveProductSetsInfo）——

  async loadProductSetsInfo(workspace?: string): Promise<Record<string, ProductSetExtraInfo>> {
    const ws = workspace ?? this.currentWS
    const store = await readJsonFile<Record<string, ProductSetExtraInfo>>(productSetsInfoPath(ws))
    return store ?? {}
  }

  async saveProductSetsInfo(workspace: string, store: Record<string, ProductSetExtraInfo>): Promise<void> {
    ensureWorkspaceDirs(workspace)
    await writeJsonAtomic(productSetsInfoPath(workspace), store)
  }

  // —— 工作区 API（对照 WorkspaceList / Current / Create / Open / Switch）——

  async workspaceInfo(workspace: string): Promise<WorkspaceInfo> {
    const stat = await fsp.stat(workspace)
    return { path: workspace, name: path.basename(workspace), created_at: formatTime(stat.mtime) }
  }

  async list(): Promise<WorkspaceInfo[]> {
    const paths = await this.loadRecentWorkspaces()
    const infos: WorkspaceInfo[] = []
    for (const p of paths) {
      try {
        infos.push(await this.workspaceInfo(p))
      } catch {
        // 跳过不可访问的
      }
    }
    return infos
  }

  async current(): Promise<WorkspaceInfo | null> {
    if (!this.currentWS) return null
    return this.workspaceInfo(this.currentWS)
  }

  async create(pathArg: string): Promise<WorkspaceInfo> {
    const ws = pathArg.trim()
    if (!ws) throw new Error('路径不能为空')
    ensureWorkspaceDirs(ws)
    await this.saveConfig(ws, defaultWorkspaceConfig())
    await this.setCurrentWorkspace(ws)
    return this.workspaceInfo(ws)
  }

  async open(pathArg: string): Promise<WorkspaceInfo> {
    const ws = pathArg.trim()
    if (!ws) throw new Error('路径不能为空')
    await this.setCurrentWorkspace(ws)
    return this.workspaceInfo(ws)
  }

  async switchTo(pathArg: string): Promise<WorkspaceInfo> {
    return this.open(pathArg)
  }

  /**
   * 启动时恢复或创建默认工作区（对照原 Go restoreLastWorkspace + 默认工作区需求）：
   * - 有最近工作区 → 自动打开最近一个
   * - 无 → 自动创建默认工作区（用户主目录/启禾文件管理）并打开
   */
  async restoreOrCreateDefault(): Promise<WorkspaceInfo> {
    const recents = await this.loadRecentWorkspaces()
    if (recents.length > 0) {
      await this.setCurrentWorkspace(recents[0])
      return this.workspaceInfo(recents[0])
    }
    const def = path.join(os.homedir(), '启禾文件管理')
    return this.create(def)
  }

  async getConfig(): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    return this.loadConfig()
  }

  async updateConfig(config: WorkspaceConfig): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    await this.saveConfig(this.currentWS, config)
    return config
  }

  /**
   * 子文件夹重命名（v2.2.1）：同步迁移所有已有产品集下的同名目录，并更新工作区配置。
   * v2.4.7：type 扩展 'customer'——迁移所有 客户/<名>/<old> → <new>，config 操作对象为 customer_subfolders。
   * v2.5.1（F1）：type 扩展 'doc'——迁移所有 产品集/<名>/文档/<old> → <new>，config 操作对象为 doc_subfolders。
   * - 目录迁移：{产品集}/{images|certs|doc}/{oldName} → {newName} 或 {客户}/{oldName} → {newName}（目标存在跳过、源不存在跳过，幂等）
   * - metadata 按相对工作区路径存储，无需迁移
   * - 返回更新后的完整配置（Settings 页直接用于刷新）
   */
  async renameSubfolder(
    type: 'image' | 'cert' | 'customer' | 'doc',
    oldName: string,
    newName: string,
  ): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    oldName = oldName.trim()
    // v2.4.2（S1）：新名称完整校验（拒绝分隔符 / .. / Windows 非法字符等）
    newName = assertSafeFolderName(newName, '子文件夹名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return this.loadConfig()
    const cfg = await this.loadConfig()
    // v2.4.7：type='customer' 时配置操作对象为 cfg.customer_subfolders（旧 config 缺省已由 loadConfig 合并默认值）
    // v2.5.1（F1）：type='doc' 时操作对象为 cfg.doc_subfolders
    const list =
      type === 'image' ? cfg.image_subfolders : type === 'cert' ? cfg.cert_subfolders : type === 'doc' ? (cfg.doc_subfolders ?? []) : cfg.customer_subfolders
    if (!list || !list.includes(oldName)) throw new Error(`子文件夹「${oldName}」不存在`)
    if (list.includes(newName)) throw new Error(`子文件夹「${newName}」已存在`)

    // 同步迁移所有 产品集 或 客户 目录下的同名子文件夹（源不存在跳过、目标存在跳过，幂等）
    const parentDir =
      type === 'customer' ? path.join(this.currentWS, CUSTOMERS_DIR) : path.join(this.currentWS, PRODUCT_SETS_DIR)
    // v2.5.1（F1）：doc 类型 → 文档 目录
    const typeDir =
      type === 'customer' ? '' : type === 'image' ? IMAGES_DIR : type === 'cert' ? CERTS_DIR : DOCS_DIR
    const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const oldPath = path.join(parentDir, e.name, typeDir, oldName)
      const newPath = path.join(parentDir, e.name, typeDir, newName)
      try {
        await fsp.stat(oldPath)
        const exists = await fsp.stat(newPath).then(() => true).catch(() => false)
        if (exists) continue
        await fsp.rename(oldPath, newPath)
      } catch {
        // 源目录不存在（该产品集/客户未建此子目录）→ 跳过
      }
    }

    // 更新配置（list 是 cfg 的引用，改后写回）
    const idx = list.indexOf(oldName)
    list[idx] = newName
    await this.saveConfig(this.currentWS, cfg)
    return cfg
  }

  // —— 产品集 API（对照 ProductSetList / Create / Delete / Stats / Rename / UpdateInfo）——

  async productSetList(): Promise<ProductSetInfo[]> {
    this.requireWorkspace()
    const dir = path.join(this.currentWS, PRODUCT_SETS_DIR)
    const extra = await this.loadProductSetsInfo()
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    const sets: ProductSetInfo[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const setName = e.name
      const [info, imgCount, certCount, docCount] = await Promise.all([
        fsp.stat(path.join(dir, setName)),
        countFiles(path.join(dir, setName, IMAGES_DIR)),
        countFiles(path.join(dir, setName, CERTS_DIR)),
        // v2.5.1（F1）：文档文件数（文档/ 递归；目录不存在 countFiles 内部处理为空）
        countFiles(path.join(dir, setName, DOCS_DIR)),
      ])
      const ex = extra[setName] ?? { tags: [], notes: '' }
      sets.push({
        name: setName,
        image_count: imgCount,
        cert_count: certCount,
        doc_count: docCount,
        created_at: formatTime(info.mtime),
        tags: ex.tags ?? [],
        notes: ex.notes ?? '',
      })
    }
    sets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return sets
  }

  async productSetCreate(req: ProductSetCreateRequest): Promise<ProductSetInfo> {
    this.requireWorkspace()
    // v2.4.2（S1）：产品集名称完整校验（拒绝分隔符 / .. / Windows 非法字符等）
    const name = assertSafeFolderName(req.name, '产品集名称')
    if (!name) throw new Error('名称不能为空')
    // v2.4.7（§3.7）：工作区根目录保留名拦截（metadata key 首段区域判别用，不区分大小写）
    if (isReservedRootName(name)) throw new Error(`${name} 为工作区保留目录名，不可用作产品集`)
    const dir = productSetRootPath(this.currentWS, name)
    try {
      await fsp.stat(dir)
      throw new Error('产品集已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '产品集已存在') throw err
    }
    const cfg = await this.loadConfig()
    await fsp.mkdir(dir, { recursive: true })
    for (const sub of cfg.image_subfolders) {
      await fsp.mkdir(path.join(dir, IMAGES_DIR, sub), { recursive: true })
    }
    for (const sub of cfg.cert_subfolders) {
      await fsp.mkdir(path.join(dir, CERTS_DIR, sub), { recursive: true })
    }
    // v2.5.1（F1，D18）：新建产品集自动建 文档/ 及其默认子文件夹
    for (const sub of cfg.doc_subfolders ?? []) {
      await fsp.mkdir(path.join(dir, DOCS_DIR, sub), { recursive: true })
    }
    if (req.tags && req.tags.length > 0 || (req.notes ?? '').trim() !== '') {
      const extra = await this.loadProductSetsInfo()
      extra[name] = { tags: req.tags ?? [], notes: (req.notes ?? '').trim() }
      await this.saveProductSetsInfo(this.currentWS, extra)
    }
    const info = await fsp.stat(dir)
    return { name, image_count: 0, cert_count: 0, doc_count: 0, created_at: formatTime(info.mtime), tags: req.tags ?? [], notes: (req.notes ?? '').trim() }
  }

  async productSetStats(name: string): Promise<ProductSetStats> {
    this.requireWorkspace()
    const dir = productSetRootPath(this.currentWS, name.trim())
    const info = await fsp.stat(dir)
    const [imgCount, certCount, docCount] = await Promise.all([
      countFiles(path.join(dir, IMAGES_DIR)),
      countFiles(path.join(dir, CERTS_DIR)),
      // v2.5.1（F1）：文档文件数
      countFiles(path.join(dir, DOCS_DIR)),
    ])
    return { image_count: imgCount, cert_count: certCount, doc_count: docCount, created_at: formatTime(info.mtime) }
  }

  async productSetDelete(name: string): Promise<void> {
    this.requireWorkspace()
    const dir = productSetRootPath(this.currentWS, name.trim())
    await fsp.stat(dir)
    await fsp.rm(dir, { recursive: true, force: true })
    // 元数据清理由 MetadataService 完成（在 deleteProductSet 编排中调用）
  }

  async renameProductSet(oldName: string, newName: string): Promise<void> {
    this.requireWorkspace()
    oldName = oldName.trim()
    // v2.4.2（S1）：新名称完整校验
    newName = assertSafeFolderName(newName, '产品集名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    // v2.4.7（§3.7）：工作区根目录保留名拦截（metadata key 首段区域判别用，不区分大小写）
    if (isReservedRootName(newName)) throw new Error(`${newName} 为工作区保留目录名，不可用作产品集`)
    const oldDir = productSetRootPath(this.currentWS, oldName)
    const newDir = productSetRootPath(this.currentWS, newName)
    await fsp.stat(oldDir)
    try {
      await fsp.stat(newDir)
      throw new Error('新产品集已存在')
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '新产品集已存在') throw err
    }
    // 阻止重命名含有文件的产品集（对照原逻辑）
    const hasFiles = await this.dirContainsFile(oldDir)
    if (hasFiles) {
      throw new Error('该产品集下已有文件，无法重命名。如需修改名称，请先删除文件或新建空产品集。')
    }
    await fsp.rename(oldDir, newDir)
    // 迁移 tags/notes
    const extra = await this.loadProductSetsInfo()
    if (extra[oldName]) {
      extra[newName] = extra[oldName]
      delete extra[oldName]
      await this.saveProductSetsInfo(this.currentWS, extra)
    }
  }

  async updateProductSetInfo(req: ProductSetUpdateRequest): Promise<void> {
    this.requireWorkspace()
    const name = req.name.trim()
    const dir = productSetRootPath(this.currentWS, name)
    await fsp.stat(dir)
    const extra = await this.loadProductSetsInfo()
    if ((!req.tags || req.tags.length === 0) && (req.notes ?? '').trim() === '') {
      delete extra[name]
    } else {
      extra[name] = { tags: req.tags ?? [], notes: (req.notes ?? '').trim() }
    }
    await this.saveProductSetsInfo(this.currentWS, extra)
  }

  private requireWorkspace(): void {
    if (!this.currentWS) throw new Error('未打开工作区')
  }

  private async dirContainsFile(dir: string): Promise<boolean> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (await this.dirContainsFile(path.join(dir, e.name))) return true
        } else {
          return true
        }
      }
    } catch {
      // 忽略
    }
    return false
  }
}
