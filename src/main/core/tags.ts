/**
 * 标签体系（v2.0.1 新增）：全局标签定义（颜色） + 已使用标签聚合
 * 数据：<ws>/.qihefilemanager/tags.json  { "标签名": { "color": "#ef4444" } }
 * 引用：文件级 tags（metadata.json）+ 产品集级 tags（product_sets.json）
 * 迁移：旧版 tags_state.json.colors 惰性并入 tags.json
 * 纯 TS：可在 node 环境测试。
 */
import path from 'node:path'
import { WorkspaceService } from './workspace'
import { MetadataService } from './metadata'
import { TAGS_FILE, cmDir, ensureWorkspaceDirs, writeJsonAtomic, readJsonFile } from './paths'

export interface TagDef {
  color: string
}

export interface TagInfo {
  name: string
  color: string
  count: number
}

export const DEFAULT_TAG_COLOR = '#94a3b8' // 未定义颜色时的默认灰

export class TagService {
  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  private tagsPath(ws: string): string {
    return path.join(cmDir(ws), TAGS_FILE)
  }

  private async loadDefs(ws: string): Promise<Record<string, TagDef>> {
    return (await readJsonFile<Record<string, TagDef>>(this.tagsPath(ws))) ?? {}
  }

  private async saveDefs(ws: string, defs: Record<string, TagDef>): Promise<void> {
    ensureWorkspaceDirs(ws)
    await writeJsonAtomic(this.tagsPath(ws), defs)
  }

  /** 惰性迁移旧版 tags_state.json.colors → tags.json（一次性） */
  private async migrateLegacy(ws: string): Promise<void> {
    const legacyPath = path.join(cmDir(ws), 'tags_state.json')
    const defs = await this.loadDefs(ws)
    if (Object.keys(defs).length > 0) return
    const legacy = await readJsonFile<{ colors?: Record<string, string> }>(legacyPath)
    if (!legacy?.colors || Object.keys(legacy.colors).length === 0) return
    const migrated: Record<string, TagDef> = {}
    for (const [name, color] of Object.entries(legacy.colors)) {
      if (name && color) migrated[name] = { color }
    }
    if (Object.keys(migrated).length > 0) await this.saveDefs(ws, migrated)
  }

  /** 聚合所有已使用标签（文件 + 产品集）及计数 */
  private async collectUsedTags(ws: string): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    const store = await this.metadata.loadMetadataStore(ws)
    for (const meta of Object.values(store.files)) {
      for (const t of meta.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const extra = await this.workspace.loadProductSetsInfo(ws)
    for (const ex of Object.values(extra)) {
      for (const t of ex.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return counts
  }

  async list(): Promise<TagInfo[]> {
    const ws = this.requireWS()
    await this.migrateLegacy(ws)
    const defs = await this.loadDefs(ws)
    const counts = await this.collectUsedTags(ws)
    const names = new Set([...Object.keys(defs), ...counts.keys()])
    const out: TagInfo[] = [...names].map((name) => ({
      name,
      color: defs[name]?.color || DEFAULT_TAG_COLOR,
      count: counts.get(name) ?? 0,
    }))
    out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
    return out
  }

  async setColor(name: string, color: string): Promise<void> {
    const ws = this.requireWS()
    name = name.trim()
    color = color.trim()
    if (!name || !color) throw new Error('参数不完整')
    const defs = await this.loadDefs(ws)
    defs[name] = { color }
    await this.saveDefs(ws, defs)
  }

  /** 重命名标签：定义 + 所有引用（文件/产品集）同步 */
  async rename(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    oldName = oldName.trim()
    newName = newName.trim()
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return

    const defs = await this.loadDefs(ws)
    if (defs[oldName]) {
      defs[newName] = defs[oldName]
      delete defs[oldName]
    }
    await this.saveDefs(ws, defs)

    // 文件引用
    const store = await this.metadata.loadMetadataStore(ws)
    let fileChanged = false
    for (const meta of Object.values(store.files)) {
      const tags = meta.tags ?? []
      const idx = tags.indexOf(oldName)
      if (idx >= 0) {
        tags[idx] = newName
        fileChanged = true
      }
    }
    if (fileChanged) await this.metadata.saveMetadataStore(store, ws)

    // 产品集引用
    const extra = await this.workspace.loadProductSetsInfo(ws)
    let psChanged = false
    for (const ex of Object.values(extra)) {
      const tags = ex.tags ?? []
      const idx = tags.indexOf(oldName)
      if (idx >= 0) {
        tags[idx] = newName
        psChanged = true
      }
    }
    if (psChanged) await this.workspace.saveProductSetsInfo(ws, extra)
  }

  /** 删除标签：定义 + 所有引用移除 */
  async delete(name: string): Promise<void> {
    const ws = this.requireWS()
    name = name.trim()
    if (!name) throw new Error('名称不能为空')

    const defs = await this.loadDefs(ws)
    delete defs[name]
    await this.saveDefs(ws, defs)

    const store = await this.metadata.loadMetadataStore(ws)
    let fileChanged = false
    for (const meta of Object.values(store.files)) {
      const tags = (meta.tags ?? []).filter((t) => t !== name)
      if (tags.length !== (meta.tags ?? []).length) {
        meta.tags = tags
        fileChanged = true
      }
    }
    if (fileChanged) await this.metadata.saveMetadataStore(store, ws)

    const extra = await this.workspace.loadProductSetsInfo(ws)
    let psChanged = false
    for (const ex of Object.values(extra)) {
      const tags = (ex.tags ?? []).filter((t) => t !== name)
      if (tags.length !== (ex.tags ?? []).length) {
        ex.tags = tags
        psChanged = true
      }
    }
    if (psChanged) await this.workspace.saveProductSetsInfo(ws, extra)
  }
}
