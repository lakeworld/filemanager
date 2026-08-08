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
  filterSlice,
  writeJsonAtomic,
  readJsonFile,
} from './paths'
import { globalCountCache } from './scanCache'

export interface WorkspaceInfo {
  path: string
  name: string
  created_at: string
}

export interface ProductSetInfo {
  name: string
  image_count: number
  cert_count: number
  created_at: string
  tags: string[]
  notes: string
}

export interface ProductSetStats {
  image_count: number
  cert_count: number
  created_at: string
}

export interface ProductSetCreateRequest {
  name: string
  tags?: string[]
  notes?: string
}

export interface ProductSetUpdateRequest {
  name: string
  tags?: string[]
  notes?: string
}

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
    await this.addRecentWorkspace(workspace)
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
    if (cfg) return cfg
    const def = defaultWorkspaceConfig()
    await this.saveConfig(ws, def)
    return def
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

  async getConfig(): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    return this.loadConfig()
  }

  async updateConfig(config: WorkspaceConfig): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    await this.saveConfig(this.currentWS, config)
    return config
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
      const [info, imgCount, certCount] = await Promise.all([
        fsp.stat(path.join(dir, setName)),
        countFiles(path.join(dir, setName, IMAGES_DIR)),
        countFiles(path.join(dir, setName, CERTS_DIR)),
      ])
      const ex = extra[setName] ?? { tags: [], notes: '' }
      sets.push({
        name: setName,
        image_count: imgCount,
        cert_count: certCount,
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
    const name = req.name.trim()
    if (!name) throw new Error('名称不能为空')
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
    if (req.tags && req.tags.length > 0 || (req.notes ?? '').trim() !== '') {
      const extra = await this.loadProductSetsInfo()
      extra[name] = { tags: req.tags ?? [], notes: (req.notes ?? '').trim() }
      await this.saveProductSetsInfo(this.currentWS, extra)
    }
    const info = await fsp.stat(dir)
    return { name, image_count: 0, cert_count: 0, created_at: formatTime(info.mtime), tags: req.tags ?? [], notes: (req.notes ?? '').trim() }
  }

  async productSetStats(name: string): Promise<ProductSetStats> {
    this.requireWorkspace()
    const dir = productSetRootPath(this.currentWS, name.trim())
    const info = await fsp.stat(dir)
    const [imgCount, certCount] = await Promise.all([
      countFiles(path.join(dir, IMAGES_DIR)),
      countFiles(path.join(dir, CERTS_DIR)),
    ])
    return { image_count: imgCount, cert_count: certCount, created_at: formatTime(info.mtime) }
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
    newName = newName.trim()
    if (!oldName || !newName) throw new Error('名称不能为空')
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
