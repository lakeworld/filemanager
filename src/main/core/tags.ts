/**
 * 标签体系（v2.0.2）：父/子层级 + 固定色预设标签
 * 数据：<ws>/.qihefilemanager/tags.json
 *   { "标签名": { "color": "#xxx", "parent": "父标签名", "builtin": true } }
 * - parent：子标签关联父标签名（两层结构，parent 本身不可再有 parent）
 * - builtin：固定色预设标签（颜色不可改，名称可重命名、可删除）
 * 引用：文件级 tags（metadata.json）+ 产品集级 tags（product_sets.json）
 * 迁移：旧版 tags_state.json.colors 并入；缺失 builtin 标签自动补全
 * 纯 TS：可在 node 环境直接测试。
 */
import path from 'node:path'
import { WorkspaceService } from './workspace'
import { MetadataService } from './metadata'
import { TAGS_FILE, cmDir, ensureWorkspaceDirs, writeJsonAtomic, readJsonFile } from './paths'

export interface TagDef {
  color: string
  parent?: string
  builtin?: boolean
}

export interface TagInfo {
  name: string
  color: string
  count: number
  parent: string | null
  children: string[]
  builtin: boolean
  /** v2.3.0：是否为已定义标签；false = 被引用但 tags.json 无定义的「孤儿标签」 */
  defined: boolean
}

export const DEFAULT_TAG_COLOR = '#94a3b8'

/** 固定色预设标签（颜色固定、名称可重命名） */
export const BUILTIN_TAGS: Record<string, string> = {
  重要: '#ef4444',
  待更新: '#f97316',
  已更新: '#22c55e',
  问题: '#eab308',
  归档: '#64748b',
}

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

  /** 迁移 + 初始化：旧版 tags_state.colors 并入；补全缺失的 builtin 固定色标签 */
  private async migrateAndInit(ws: string): Promise<void> {
    const defs = await this.loadDefs(ws)
    let changed = false

    // 旧版 tags_state.json.colors → tags.json（仅当 tags.json 尚无任何定义时）
    if (Object.keys(defs).length === 0) {
      const legacyPath = path.join(cmDir(ws), 'tags_state.json')
      const legacy = await readJsonFile<{ colors?: Record<string, string> }>(legacyPath)
      if (legacy?.colors) {
        for (const [name, color] of Object.entries(legacy.colors)) {
          if (name && color && !defs[name]) {
            defs[name] = { color }
            changed = true
          }
        }
      }
    }

    // 补全 builtin 固定色标签（已存在同名则保留其颜色，只补缺）
    for (const [name, color] of Object.entries(BUILTIN_TAGS)) {
      if (!defs[name]) {
        defs[name] = { color, builtin: true }
        changed = true
      } else if (!defs[name].builtin && !defs[name].parent) {
        // 旧用户自定义的同名顶层标签 → 标记为 builtin（颜色保留用户原色）
        defs[name].builtin = true
        changed = true
      }
    }

    if (changed) await this.saveDefs(ws, defs)
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

  /** 标签树列表：顶层标签（含 children）+ 子标签 */
  async list(): Promise<TagInfo[]> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    const defs = await this.loadDefs(ws)
    const counts = await this.collectUsedTags(ws)

    // 校验 parent 指向的父标签必须存在且本身无 parent（两层结构）
    const names = new Set(Object.keys(defs))
    const childrenOf = new Map<string, string[]>()
    const normalized: Record<string, TagDef> = {}
    for (const [name, def] of Object.entries(defs)) {
      let parent = def.parent
      if (parent) {
        const pDef = defs[parent]
        if (!pDef || pDef.parent) {
          // 父标签缺失或父标签本身是子标签 → 视为顶层
          parent = undefined
        } else {
          const list = childrenOf.get(parent) ?? []
          list.push(name)
          childrenOf.set(parent, list)
        }
      }
      normalized[name] = { ...def, parent }
    }

    const mkInfo = (name: string): TagInfo => {
      const def = normalized[name]
      return {
        name,
        color: def?.color || DEFAULT_TAG_COLOR,
        count: counts.get(name) ?? 0,
        parent: def?.parent ?? null,
        children: childrenOf.get(name) ?? [],
        builtin: !!def?.builtin,
        defined: !!def,
      }
    }

    const topLevel = Object.keys(normalized)
      .filter((n) => !normalized[n].parent)
      .sort((a, b) => {
        // builtin 优先，其次按使用数倒序
        const ab = normalized[a].builtin ? 0 : 1
        const bb = normalized[b].builtin ? 0 : 1
        if (ab !== bb) return ab - bb
        return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b, 'zh')
      })

    const out: TagInfo[] = []
    for (const name of topLevel) {
      out.push(mkInfo(name))
      const children = childrenOf.get(name) ?? []
      children.sort((a, b) => a.localeCompare(b, 'zh'))
      for (const c of children) out.push(mkInfo(c))
    }

    // v2.3.0：孤儿标签（被引用但无定义）追加在末尾，设置页可治理
    const orphanNames = Array.from(counts.keys())
      .filter((n) => !normalized[n])
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b, 'zh'))
    for (const name of orphanNames) out.push(mkInfo(name))
    return out
  }

  /** v2.3.0：孤儿标签转为正式定义（引用不动，仅补 tags.json 定义） */
  async adopt(name: string, color: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = (color || DEFAULT_TAG_COLOR).trim()
    if (!name) throw new Error('名称不能为空')
    const defs = await this.loadDefs(ws)
    if (defs[name]) return // 已定义
    const counts = await this.collectUsedTags(ws)
    if (!counts.has(name)) throw new Error(`标签「${name}」未被使用`)
    defs[name] = { color }
    await this.saveDefs(ws, defs)
  }

  async setColor(name: string, color: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = color.trim()
    if (!name || !color) throw new Error('参数不完整')
    const defs = await this.loadDefs(ws)
    if (!defs[name]) throw new Error('标签不存在')
    if (defs[name].builtin) throw new Error('固定色标签颜色不可修改')
    defs[name].color = color
    await this.saveDefs(ws, defs)
  }

  /** 新建标签（可选父级与颜色） */
  async create(name: string, color: string, parentName?: string | null): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = (color || DEFAULT_TAG_COLOR).trim()
    parentName = parentName?.trim() || null
    if (!name) throw new Error('名称不能为空')
    const defs = await this.loadDefs(ws)
    if (defs[name]) throw new Error('标签已存在')
    if (parentName) {
      const pDef = defs[parentName]
      if (!pDef) throw new Error('父标签不存在')
      if (pDef.parent) throw new Error('父标签不能是子标签（仅支持两层）')
    }
    const def: TagDef = { color }
    if (parentName) def.parent = parentName
    defs[name] = def
    await this.saveDefs(ws, defs)
  }

  /** 设置/解除父子关系（parentName=null 提升为顶层） */
  async setParent(name: string, parentName: string | null): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    parentName = parentName?.trim() || null
    if (!name) throw new Error('名称不能为空')
    if (parentName === name) throw new Error('不能以自身为父标签')
    const defs = await this.loadDefs(ws)
    if (!defs[name]) throw new Error('标签不存在')
    if (parentName) {
      const pDef = defs[parentName]
      if (!pDef) throw new Error('父标签不存在')
      if (pDef.parent) throw new Error('父标签不能是子标签（仅支持两层）')
      if (defs[name].parent === parentName) return
      defs[name].parent = parentName
    } else {
      delete defs[name].parent
    }
    await this.saveDefs(ws, defs)
  }

  /** 重命名标签：定义 + 子标签 parent 引用 + 文件/产品集引用同步 */
  async rename(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    oldName = oldName.trim()
    newName = newName.trim()
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return

    const defs = await this.loadDefs(ws)
    if (!defs[oldName]) throw new Error('标签不存在')
    if (defs[newName]) throw new Error('新名称已存在')

    const moved = defs[oldName]
    delete defs[oldName]
    defs[newName] = moved
    // 子标签的 parent 引用同步
    for (const def of Object.values(defs)) {
      if (def.parent === oldName) def.parent = newName
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

  /** 删除标签：定义 + 引用移除；删除父标签时其子标签提升为顶层 */
  async delete(name: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    if (!name) throw new Error('名称不能为空')

    const defs = await this.loadDefs(ws)
    const defined = !!defs[name]
    // v2.3.0：孤儿标签（未定义但被引用）也可删除——仅清理引用，跳过定义
    if (defined) {
      delete defs[name]
      // 子标签提升为顶层
      for (const def of Object.values(defs)) {
        if (def.parent === name) delete def.parent
      }
      await this.saveDefs(ws, defs)
    }

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
