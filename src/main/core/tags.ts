/**
 * 标签体系（v2.0.2）：父/子层级 + 固定色预设标签
 * 数据：<ws>/.qihefilemanager/tags.json
 *   { "标签名": { "color": "#xxx", "parent": "父标签名", "builtin": true } }
 * - parent：子标签关联父标签名（两层结构，parent 本身不可再有 parent）
 * - builtin：固定色预设标签（v2.3.2 起一次性迁移清除，字段仅作历史数据兼容保留）
 * 引用：文件级 tags（metadata.json）+ 产品集级 tags（product_sets.json）
 * 迁移：旧版 tags_state.json.colors 并入；v2.3.2 一次性迁移清除内置固定色标签并写入标记，
 *       此后不再补全/改动任何标签（删除后不再复活、颜色均可改）
 * 纯 TS：可在 node 环境直接测试。
 */
import path from 'node:path'
import { WorkspaceService } from './workspace'
import { MetadataService } from './metadata'
import { TAGS_FILE, cmDir, ensureWorkspaceDirs, readJsonFile } from './paths'
import { mutateJsonFile } from './jsonStore'
import type { TagInfo } from '../../shared/types'

export type { TagInfo } from '../../shared/types'

export interface TagDef {
  color: string
  parent?: string
  builtin?: boolean
}

/**
 * v2.4.4（T7）：标签引用源——可枚举「实体 → 标签数组」并整体回写的存储。
 * 内置源：文件（metadata.json）、产品集（product_sets.json）。
 * v2.4.7 已接入：客户（customers.json）、发票（invoices.json）——registerSource 即用，
 * rename/delete/adopt/迁移/计数全部自动覆盖，不再手写逐库传播。
 * list() 必须返回 tags 的副本（调用方原地修改后经 save() 回写，避免污染共享引用）。
 */
export interface TagReferenceSource {
  readonly id: string
  list(): Promise<{ name: string; tags: string[] }[]>
  save(entries: { name: string; tags: string[] }[]): Promise<void>
}

export const DEFAULT_TAG_COLOR = '#94a3b8'

/** 内置预设标签（v2.3.2 起仅用于迁移识别，不再用于补全/创建） */
export const BUILTIN_TAGS: Record<string, string> = {
  重要: '#ef4444',
  待更新: '#f97316',
  已更新: '#22c55e',
  问题: '#eab308',
  归档: '#64748b',
}

/** 迁移标记键（tags.json 内部键：遍历排除、不对外暴露，create/rename 拒绝同名） */
export const MIGRATED_BUILTIN_KEY = '_migrated_builtin'

/** 是否为内部保留键（迁移标记，不可作为真实标签操作） */
function isInternalKey(name: string): boolean {
  return name === MIGRATED_BUILTIN_KEY
}

export class TagService {
  private refSources = new Map<string, TagReferenceSource>()

  constructor(
    private workspace: WorkspaceService,
    private metadata: MetadataService,
  ) {
    this.registerDefaultSources()
  }

  /** 注册标签引用源（未来实体接入点） */
  registerSource(id: string, src: TagReferenceSource): void {
    this.refSources.set(id, src)
  }

  /** 内置引用源：文件元数据 + 产品集（list 返回 tags 副本，防原地修改污染共享引用） */
  private registerDefaultSources(): void {
    this.registerSource('files', {
      id: 'files',
      list: async () => {
        const store = await this.metadata.loadMetadataStore()
        return Object.entries(store.files).map(([name, meta]) => ({ name, tags: [...(meta.tags ?? [])] }))
      },
      save: async (entries) => {
        // v2.5.3（P1-3）：改走 mutateKeys 锁内读改写——旧实现「锁外读旧快照 + 整档替换」在标签
        // 传播与其他 metadata 写并发时会抹掉锁内最新值。回调内保留「逐条比较、有差异才改」的
        // 原语义；无变化时多一次原子重写（PLAN 已接受）。
        const ws = this.requireWS()
        await this.metadata.mutateKeys(ws, (files) => {
          for (const { name, tags } of entries) {
            const meta = files[name]
            if (!meta) continue
            if (JSON.stringify(meta.tags ?? []) !== JSON.stringify(tags)) {
              meta.tags = tags
            }
          }
        })
      },
    })
    this.registerSource('productSets', {
      id: 'productSets',
      list: async () => {
        const extra = await this.workspace.loadProductSetsInfo()
        return Object.entries(extra).map(([name, ex]) => ({ name, tags: [...(ex.tags ?? [])] }))
      },
      save: async (entries) => {
        const ws = this.requireWS()
        const extra = await this.workspace.loadProductSetsInfo()
        let changed = false
        for (const { name, tags } of entries) {
          const ex = extra[name]
          if (!ex) continue
          if (JSON.stringify(ex.tags ?? []) !== JSON.stringify(tags)) {
            ex.tags = tags
            changed = true
          }
        }
        if (changed) await this.workspace.saveProductSetsInfo(ws, extra)
      },
    })
  }

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

  /**
   * tags.json 定义区的锁内读改写事务（v2.5.3 T2，S1）：读取/构造/查重/修改全部在 mutate 回调内完成，
   * 保证基于锁内最新磁盘内容，杜绝并发丢更新与「内存已改、写盘失败」假成功。
   * 回调通过 markChanged() 声明实际变更——未声明则 save 返回 false 不写盘（无变化不刷 mtime）。
   * 结构非法视为损坏：写路径拒绝覆盖并隔离留证（.corrupt-* 备份）；校验/查重失败直接上抛。
   */
  private async mutateDefs<R>(
    ws: string,
    mutate: (defs: Record<string, TagDef>, markChanged: () => void) => Promise<R> | R,
  ): Promise<R> {
    ensureWorkspaceDirs(ws)
    const p = this.tagsPath(ws)
    let changed = false
    const result = await mutateJsonFile<Record<string, TagDef>, R>(p, {
      read: async () => ({}), // 文件缺失按空定义区起步
      mutate: async (defs) => mutate(defs, () => (changed = true)),
      save: async () => changed,
      validate: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, TagDef>) : null),
    })
    return result
  }

  /**
   * v2.5.3（T2，S1）：同一次 rename/delete/迁移中串行处理全部引用源——逐源 list → 回调在
   * 各源返回的条目副本上判定/修改 → 有变更才 save。仍是逐文件顺序提交、不声称跨 JSON 原子；
   * 任一源失败（含中段失败）直接上抛，不静默半截成功。
   */
  private async mutateTagReferences(mutator: (entries: { name: string; tags: string[] }[]) => boolean): Promise<void> {
    for (const src of this.refSources.values()) {
      const entries = await src.list()
      if (mutator(entries)) await src.save(entries)
    }
  }

  /**
   * 一次性迁移（v2.3.2）：旧版 tags_state.colors 并入；清除内置固定色标签（定义 + 引用）。
   * 完成后写入 _migrated_builtin 标记，此后不再补全/改动任何标签（删除后不再复活）。
   * 已存在标记 → 直接返回，不做任何处理。
   */
  private async migrateAndInit(ws: string): Promise<void> {
    // 已迁移（只读先行，读侧遇损坏仍宽容）→ 不做任何处理、不写盘
    const initial = await this.loadDefs(ws)
    if (initial[MIGRATED_BUILTIN_KEY]) return

    let migrated = false
    await this.mutateDefs(ws, async (defs, markChanged) => {
      if (defs[MIGRATED_BUILTIN_KEY]) return // 锁内复核（并发首建防重入）

      // 旧版 tags_state.json.colors → tags.json（仅当 tags.json 尚无任何定义时）
      if (Object.keys(defs).length === 0) {
        const legacyPath = path.join(cmDir(ws), 'tags_state.json')
        const legacy = await readJsonFile<{ colors?: Record<string, string> }>(legacyPath)
        if (legacy?.colors) {
          for (const [name, color] of Object.entries(legacy.colors)) {
            if (name && color && !defs[name]) {
              defs[name] = { color }
            }
          }
        }
      }

      // 删除内置固定色标签定义（曾经的 builtin：删除后不再复活）
      for (const name of Object.keys(defs)) {
        if (defs[name].builtin) delete defs[name]
      }

      // 写入迁移标记（内部键，后续 list()/create 等遍历会跳过该键）
      defs[MIGRATED_BUILTIN_KEY] = { color: '' }
      markChanged()
      migrated = true
    })

    // 移除引用：全部引用源中的内置名称（文件 + 产品集 + 未来实体，统一走引用源；
    // 不同 JSON 文件逐文件顺序提交，中段失败上抛）
    if (migrated) {
      const builtinNames = Object.keys(BUILTIN_TAGS)
      await this.mutateTagReferences((entries) => {
        let changed = false
        for (const e of entries) {
          const tags = (e.tags ?? []).filter((t) => !builtinNames.includes(t))
          if (tags.length !== (e.tags ?? []).length) {
            e.tags = tags
            changed = true
          }
        }
        return changed
      })
    }
  }

  /** 聚合所有已使用标签（全部引用源）及计数 */
  private async collectUsedTags(): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const src of this.refSources.values()) {
      const entries = await src.list()
      for (const e of entries) {
        for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    return counts
  }

  /** 标签树列表：顶层标签（含 children）+ 子标签 */
  async list(): Promise<TagInfo[]> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    const defs = await this.loadDefs(ws)
    const counts = await this.collectUsedTags()

    // 校验 parent 指向的父标签必须存在且本身无 parent（两层结构）；排除内部迁移标记键
    const names = new Set(Object.keys(defs).filter((n) => !isInternalKey(n)))
    const childrenOf = new Map<string, string[]>()
    const normalized: Record<string, TagDef> = {}
    for (const [name, def] of Object.entries(defs)) {
      if (isInternalKey(name)) continue // 内部标记键不作为真实标签
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

  /** v2.3.0：孤儿标签转为正式定义（引用不动，仅补 tags.json 定义；锁内查重：已定义则幂等返回） */
  async adopt(name: string, color: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = (color || DEFAULT_TAG_COLOR).trim()
    if (!name) throw new Error('名称不能为空')
    const counts = await this.collectUsedTags()
    await this.mutateDefs(ws, (defs, markChanged) => {
      if (defs[name]) return // 已定义
      if (!counts.has(name)) throw new Error(`标签「${name}」未被使用`)
      defs[name] = { color }
      markChanged()
    })
  }

  async setColor(name: string, color: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = color.trim()
    if (!name || !color) throw new Error('参数不完整')
    if (isInternalKey(name)) throw new Error('标签不存在')
    await this.mutateDefs(ws, (defs, markChanged) => {
      if (!defs[name]) throw new Error('标签不存在')
      // v2.3.2：颜色均可改（不再有固定色不可改限制）；同色不写盘
      if (defs[name].color !== color) {
        defs[name].color = color
        markChanged()
      }
    })
  }

  /** 新建标签（可选父级与颜色）；查重/父级校验均锁内完成 */
  async create(name: string, color: string, parentName?: string | null): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    color = (color || DEFAULT_TAG_COLOR).trim()
    parentName = parentName?.trim() || null
    if (!name) throw new Error('名称不能为空')
    if (isInternalKey(name)) throw new Error('该名称为系统保留，不可用作标签')
    await this.mutateDefs(ws, (defs, markChanged) => {
      if (defs[name]) throw new Error('标签已存在')
      if (parentName) {
        if (isInternalKey(parentName)) throw new Error('父标签不存在')
        const pDef = defs[parentName]
        if (!pDef) throw new Error('父标签不存在')
        if (pDef.parent) throw new Error('父标签不能是子标签（仅支持两层）')
      }
      const def: TagDef = { color }
      if (parentName) def.parent = parentName
      defs[name] = def
      markChanged()
    })
  }

  /** 设置/解除父子关系（parentName=null 提升为顶层）；无实际变化不写盘 */
  async setParent(name: string, parentName: string | null): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    parentName = parentName?.trim() || null
    if (!name) throw new Error('名称不能为空')
    if (parentName === name) throw new Error('不能以自身为父标签')
    if (isInternalKey(name)) throw new Error('标签不存在')
    await this.mutateDefs(ws, (defs, markChanged) => {
      if (!defs[name]) throw new Error('标签不存在')
      if (parentName) {
        if (isInternalKey(parentName)) throw new Error('父标签不存在')
        const pDef = defs[parentName]
        if (!pDef) throw new Error('父标签不存在')
        if (pDef.parent) throw new Error('父标签不能是子标签（仅支持两层）')
        if (defs[name].parent === parentName) return // 无变化不写盘
        defs[name].parent = parentName
      } else {
        if (!defs[name].parent) return // 无变化不写盘
        delete defs[name].parent
      }
      markChanged()
    })
  }

  /** 重命名标签：定义 + 子标签 parent 引用（锁内事务）→ 文件/产品集等引用源顺序传播 */
  async rename(oldName: string, newName: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    oldName = oldName.trim()
    newName = newName.trim()
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return

    await this.mutateDefs(ws, (defs, markChanged) => {
      if (isInternalKey(oldName)) throw new Error('标签不存在')
      if (!defs[oldName]) throw new Error('标签不存在')
      if (isInternalKey(newName)) throw new Error('新名称为系统保留')
      if (defs[newName]) throw new Error('新名称已存在')

      const moved = defs[oldName]
      delete defs[oldName]
      defs[newName] = moved
      // 子标签的 parent 引用同步
      for (const def of Object.values(defs)) {
        if (def.parent === oldName) def.parent = newName
      }
      markChanged()
    })

    // 文件/产品集/未来实体引用统一经引用源传播（逐文件顺序提交，任一失败上抛，不静默半截成功）
    await this.mutateTagReferences((entries) => {
      let changed = false
      for (const e of entries) {
        const tags = e.tags ?? []
        const idx = tags.indexOf(oldName)
        if (idx >= 0) {
          tags[idx] = newName
          changed = true
        }
      }
      return changed
    })
  }

  /** 删除标签：定义 + 引用移除；删除父标签时其子标签提升为顶层 */
  async delete(name: string): Promise<void> {
    const ws = this.requireWS()
    await this.migrateAndInit(ws)
    name = name.trim()
    if (!name) throw new Error('名称不能为空')

    await this.mutateDefs(ws, (defs, markChanged) => {
      if (isInternalKey(name)) throw new Error('标签不存在')
      if (defs[name]) {
        delete defs[name]
        // 子标签提升为顶层
        for (const def of Object.values(defs)) {
          if (def.parent === name) delete def.parent
        }
        markChanged()
      }
      // 孤儿标签（未定义但被引用）也可删除——仅清理引用，跳过定义（不写盘）
    })

    // 全部引用源移除该标签（孤儿标签删除同样只走引用清理；逐源顺序提交，任一失败上抛）
    await this.mutateTagReferences((entries) => {
      let changed = false
      for (const e of entries) {
        const tags = (e.tags ?? []).filter((t) => t !== name)
        if (tags.length !== (e.tags ?? []).length) {
          e.tags = tags
          changed = true
        }
      }
      return changed
    })
  }
}
