/**
 * 工作区 / 产品集 / 配置 / 最近工作区（对照原 Go workspace.go）
 * 纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 */
import os from 'node:os'
import path from 'node:path'
import { listActualSubfolders } from './subfolders'
import { auditSubfolderDrift } from './healthAudit'
import type { SubfolderDriftReport } from '../../shared/types'
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
  BUILTIN_NOTES_SUBFOLDER,
  CUSTOMERS_DIR,
  SUPPLIERS_DIR,
  filterSlice,
  overwriteJson,
  writeJsonAtomic,
  readJsonFile,
  metadataPath,
  assertSafeFolderName,
  assertSafePathSegment,
  isReservedRootName,
} from './paths'
import { globalCountCache } from './scanCache'
import { mutateJsonFile } from './jsonStore'
import { validateMetadataStore } from './metadata'
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
    // v2.5.3（T5）：不再直接 globalWorkspaceIndex.clear() ——索引重建改走候选会话
    // （coordinator.beginRebuild→commit），避免「清空→重建」的中间空窗与旧 build 污染；
    // 新会话提交时整体替换，旧工作区快照不会残留。
    // v2.5.3（T5-S1）：切换通知在任何 await 之前同步触发——currentWS 赋值后先使旧索引
    // session 失效（setupWorkspaceIndex→beginRebuild）并停旧交换区（exchange.stop），
    // 再等待最近工作区落盘；addRecentWorkspace 失败（磁盘错误）不影响切换生效与通知。
    this.onWorkspaceChangedCb?.()
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
    // v2.5.5（对齐客户）：旧 config 缺 supplier_subfolders → 合并默认值并写回（原固定集决策废止后向后兼容）
    if (cfg.supplier_subfolders === undefined || cfg.supplier_subfolders === null) {
      cfg.supplier_subfolders = defaultWorkspaceConfig().supplier_subfolders
      await this.saveConfig(ws, cfg)
    }
    return cfg
  }

  async saveConfig(workspace: string, cfg: WorkspaceConfig): Promise<void> {
    ensureWorkspaceDirs(workspace)
    await overwriteJson(configPath(workspace), cfg)
  }

  // —— 产品集附加信息（对照 loadProductSetsInfo / saveProductSetsInfo）——

  async loadProductSetsInfo(workspace?: string): Promise<Record<string, ProductSetExtraInfo>> {
    const ws = workspace ?? this.currentWS
    const store = await readJsonFile<Record<string, ProductSetExtraInfo>>(productSetsInfoPath(ws))
    return store ?? {}
  }

  async saveProductSetsInfo(workspace: string, store: Record<string, ProductSetExtraInfo>): Promise<void> {
    ensureWorkspaceDirs(workspace)
    await overwriteJson(productSetsInfoPath(workspace), store)
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
   * 子文件夹重命名。**v2.5.9（A9 刀3b）起默认只改模板名**；
   * 传 `opts.acrossEntities: true` 才会同步迁移所有已有产品集/客户/供应商下的同名目录（会改盘）。
   * v2.4.7：type 扩展 'customer'——迁移所有 客户/<名>/<old> → <new>，config 操作对象为 customer_subfolders。
   * v2.5.1（F1）：type 扩展 'doc'——迁移所有 产品集/<名>/文档/<old> → <new>，config 操作对象为 doc_subfolders。
   * v2.5.5：type 扩展 'supplier'——迁移所有 供应商/<名>/<old> → <new>，config 操作对象为 supplier_subfolders。
   * - 目录迁移：{产品集}/{images|certs|doc}/{oldName} → {newName} 或 {客户}/{oldName} → {newName} 或 {供应商}/{oldName} → {newName}（目标存在跳过、源不存在跳过，幂等）
   * - metadata 按相对工作区路径存储 ⇒ **目录一改名夹内文件的 key 全变**，必须同步迁移（v2.6 批2.5·P1-9 修；
   *   旧注释「无需迁移」是错的——真表现是标签/备注/到期日在界面上凭空消失，见 `migrateMetadataKeysForDirs`）
   * - 返回更新后的完整配置（Settings 页直接用于刷新）
   */
  async renameSubfolder(
    type: 'image' | 'cert' | 'customer' | 'supplier' | 'doc',
    oldName: string,
    newName: string,
    opts: { acrossEntities?: boolean } = {},
  ): Promise<WorkspaceConfig> {
    this.requireWorkspace()
    oldName = oldName.trim()
    // v2.5.7（A2 笔记）：内建子文件夹不可改（含拒绝命名称其为内建名——防 config 写入内建名）
    if (oldName === BUILTIN_NOTES_SUBFOLDER) throw new Error(`内建「${BUILTIN_NOTES_SUBFOLDER}」子文件夹不可重命名`)
    if (newName.trim() === BUILTIN_NOTES_SUBFOLDER) throw new Error(`不能重命名为内建名「${BUILTIN_NOTES_SUBFOLDER}」`)
    // v2.4.2（S1）：新名称完整校验（拒绝分隔符 / .. / Windows 非法字符等）
    newName = assertSafeFolderName(newName, '子文件夹名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return this.loadConfig()
    const cfg = await this.loadConfig()
    // v2.4.7：type='customer' 时配置操作对象为 cfg.customer_subfolders（旧 config 缺省已由 loadConfig 合并默认值）
    // v2.5.1（F1）：type='doc' 时操作对象为 cfg.doc_subfolders
    // v2.5.5：type='supplier' 时操作对象为 cfg.supplier_subfolders
    const list =
      type === 'image'
        ? cfg.image_subfolders
        : type === 'cert'
          ? cfg.cert_subfolders
          : type === 'doc'
            ? (cfg.doc_subfolders ?? [])
            : type === 'supplier'
              ? (cfg.supplier_subfolders ?? [])
              : cfg.customer_subfolders
    if (!list || !list.includes(oldName)) throw new Error(`子文件夹「${oldName}」不存在`)
    if (list.includes(newName)) throw new Error(`子文件夹「${newName}」已存在`)

    // v2.5.9（A9 刀3b）：**默认只改模板名**。旧行为是把每个产品集/客户/供应商下的同名目录
    // **全部物理改名**——用户在设置页改个名，实际改动了整个工作区的盘（A9 病根之一，用户原话
    // 「它动的是全局的」）。现在要连实体一起改必须显式 `acrossEntities: true`（界面先弹一句确认，
    // 默认不动盘）。以下分支保留原能力：源不存在跳过、目标存在跳过，幂等。
    // ⚠ 只有显式点名才动盘上目录（默认不改，见上方说明）
    if (opts.acrossEntities) {
        const parentDir =
          type === 'customer'
            ? path.join(this.currentWS, CUSTOMERS_DIR)
            : type === 'supplier'
              ? path.join(this.currentWS, SUPPLIERS_DIR)
              : path.join(this.currentWS, PRODUCT_SETS_DIR)
        // v2.5.1（F1）：doc 类型 → 文档 目录；v2.5.5：supplier 同 customer（供应商/<名>/ 根下直接是子文件夹）
        const typeDir =
          type === 'customer' || type === 'supplier'
            ? ''
            : type === 'image'
              ? IMAGES_DIR
              : type === 'cert'
                ? CERTS_DIR
                : DOCS_DIR
        const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
        // v2.6（批2.5·P1-9）：成功改名的目录先记账，循环后**一次事务**把夹内文件的元数据 key 搬到新前缀
        const renamedDirs: { from: string; to: string }[] = []
        for (const e of entries) {
          if (!e.isDirectory()) continue
          const oldPath = path.join(parentDir, e.name, typeDir, oldName)
          const newPath = path.join(parentDir, e.name, typeDir, newName)
          try {
            await fsp.stat(oldPath)
            const exists = await fsp.stat(newPath).then(() => true).catch(() => false)
            if (exists) continue
            await fsp.rename(oldPath, newPath)
            renamedDirs.push({ from: oldPath, to: newPath })
          } catch {
            // 源目录不存在（该产品集/客户未建此子目录）→ 跳过
          }
        }
        await this.migrateMetadataKeysForDirs(renamedDirs)
    }

    // 更新配置（list 是 cfg 的引用，改后写回）
    const idx = list.indexOf(oldName)
    list[idx] = newName
    await this.saveConfig(this.currentWS, cfg)
    return cfg
  }

  /**
   * v2.5.9（A9 悬案·就地改名）：把**某一个实体下**的那一个子文件夹目录直接改名（只动盘）。
   * 与 `renameSubfolder` 的三点区别：不碰模板表、不碰其他实体、目标实体由调用方点名。
   * 内建「笔记」不可改（与 renameSubfolder 同一红线）。
   */
  async renameSubfolderInEntity(
    type: 'image' | 'cert' | 'customer' | 'supplier' | 'doc',
    entity: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    this.requireWorkspace()
    oldName = oldName.trim()
    if (oldName === BUILTIN_NOTES_SUBFOLDER) throw new Error(`内建「${BUILTIN_NOTES_SUBFOLDER}」不可改名`)
    if (newName.trim() === BUILTIN_NOTES_SUBFOLDER) throw new Error(`不能重命名为「${BUILTIN_NOTES_SUBFOLDER}」`)
    newName = assertSafeFolderName(newName, '子文件夹名称')
    if (!oldName || !newName) throw new Error('名称不能为空')
    if (oldName === newName) return
    const base =
      type === 'customer'
        ? path.join(this.currentWS, CUSTOMERS_DIR, assertSafePathSegment(entity, '客户名'))
        : type === 'supplier'
          ? path.join(this.currentWS, SUPPLIERS_DIR, assertSafePathSegment(entity, '供应商名'))
          : path.join(
              this.currentWS,
              PRODUCT_SETS_DIR,
              assertSafePathSegment(entity, '产品集名'),
              type === 'image' ? IMAGES_DIR : type === 'cert' ? CERTS_DIR : DOCS_DIR,
            )
    const from = path.join(base, oldName)
    const to = path.join(base, newName)
    if (!(await fsp.stat(from).then(() => true).catch(() => false))) {
      throw new Error(`目录「${oldName}」不存在（${type === 'customer' || type === 'supplier' ? entity : entity + '/' + (type === 'image' ? '图包' : type === 'cert' ? '证书' : '文档')}）`)
    }
    if (await fsp.stat(to).then(() => true).catch(() => false)) {
      throw new Error(`已存在同名目录「${newName}」`)
    }
    await fsp.rename(from, to)
    const { globalWorkspaceIndex } = await import('./indexCache')
    globalWorkspaceIndex.invalidate(base)
    globalWorkspaceIndex.invalidate(path.dirname(to))
    // v2.6（批2.5·P1-9）：盘改完了，数据面跟上——夹内文件的元数据 key 按前缀搬到新目录名
    await this.migrateMetadataKeysForDirs([{ from, to }])
  }

  /**
   * v2.6（批 2.5 · P1-9）：目录改名后的**数据面联动**——把 `files` 里以旧目录相对路径开头的 key
   * 原样搬到新前缀。为什么必须有：元数据 key 是「文件相对路径」的推导结果
   * （`MetadataService.fileMetadataKey`），目录一改名，夹内每个文件的 key 全体换样 ⇒
   * 旧条目留在原地成僵尸、新路径读到空库 ⇒ 用户看到的是标签/备注/到期日在界面上凭空消失
   * （不是旧注释写的"无需迁移"）。
   * 语义：**改名语境下源侧优先**——目标 key 被占住时源条目顶掉它（并删源 key）。为什么不是 moveFiles
   * 那条「新 key 已有内容则保留、不覆盖」的保守语义：本函数只在**目录改名**时被调，而改名的前置守卫
   * 要求目标目录在盘上**不存在**（`renameSubfolderInEntity` 的 `fsp.stat(to)`）⇒ 任何占用「新前缀/…」
   * 的条目必然对应盘上不存在的路径 = **回收站幽灵条目**（`trash.ts` 不清理元数据，恢复要原样还原），
   * 没有活文件；而源侧那条对应的是改名后**仍然活着**的文件。保守跳过会把活文件的标签留在已不存在的
   * 旧路径上，界面按新路径读出来的是**已删文件**的标签（v2.6 审查轮 1 的缺陷：目标 key 被幽灵占住 ⇒
   * 标签判给幽灵、真标签悬空）。`moveFiles` 的语境不同（两个 key 都可能有活文件），它走的是自己的
   * `metadata.mutateKeys`，本改动不碰它。被顶掉的幽灵逐条 `console.warn` 留痕（core 层既有口径），
   * 不做无痕的"标签换主人"。
   * 事务口径照先例走 `mutateJsonFile` 锁内读改写（锁外读旧快照再整档替换会抹掉迁移窗口内的并发元数据更新）。
   * 缩略图缓存 key 同理由路径推导（`paths.thumbnailPath` 的 sha256），但缓存根在 userData/thumbs
   * （装配层只注入给 ThumbnailService），本服务拿不到 ⇒ 此处不搬：旧条目成孤儿由缩略图 GC
   * （超龄/超量）兜底，新路径首屏经 `files:thumbnailUrl` 按需重建，看不到破图。
   */
  private async migrateMetadataKeysForDirs(pairs: { from: string; to: string }[]): Promise<void> {
    const ws = this.currentWS
    if (!ws || pairs.length === 0) return
    // 键规则**镜像** `MetadataService.fileMetadataKey`（唯一权威，住 metadata.ts）：产品集内相对
    // 「产品集/」、工作区内其余位置相对工作区根。之所以镜像而不是调用：键生成是 MetadataService 的
    // 实例方法，而 WorkspaceService 手上没有该实例（装配在 main/index.ts，两边互不可见）。
    // 规则若在那边变动，本文件的单测（a9-listSubfolders.test.ts 的 P1-9 两条，产品集/客户两分支）会红。
    const psBase = path.join(path.resolve(ws), PRODUCT_SETS_DIR)
    const toKey = (p: string): string => {
      const resolved = path.resolve(p)
      const psRel = path.relative(psBase, resolved)
      const rel = !psRel.startsWith('..') && !path.isAbsolute(psRel) ? psRel : path.relative(path.resolve(ws), resolved)
      return rel.split(path.sep).join('/')
    }
    const moves = pairs
      .map((p) => ({ from: `${toKey(p.from)}/`, to: `${toKey(p.to)}/` }))
      .filter((m) => !m.from.startsWith('..') && !m.to.startsWith('..') && m.from !== m.to)
    if (moves.length === 0) return
    const store = metadataPath(ws)
    const mtimeBefore = await fsp.stat(store).then((s) => s.mtimeMs).catch(() => 0)
    /** 被源侧顶掉的**幽灵** key（只作留痕用；Set 防 mutate 万一被复用重入时重复计数） */
    const displaced = new Set<string>()
    const moved = await mutateJsonFile(store, {
      read: async () => ({ files: {} }), // 文件缺失按空库起步（与 metadata.ts 同口径）
      validate: validateMetadataStore, // 结构非法即视为损坏：拒绝覆盖并留证，不借改名之手抹掉整档案
      mutate: (store: { files: Record<string, { tags?: string[] }> }) => {
        let moved = 0
        for (const { from, to } of moves) {
          for (const [key, meta] of Object.entries(store.files)) {
            if (!key.startsWith(from)) continue
            const next = to + key.slice(from.length)
            // 目标 key 被占住 → **源侧优先**（见方法头注释：改名语境下占用者必然是幽灵条目，没有活文件；
            // 保守跳过会让活文件的标签悬空在旧路径、界面把已删文件的标签显示给活文件）
            if (store.files[next]) displaced.add(next)
            store.files[next] = meta
            delete store.files[key]
            moved++
          }
        }
        return moved
      },
      save: async (_value, moved) => moved > 0, // 没命中就一个字节都不动（不白重写整档 metadata.json）
    })
    if (moved === 0) return
    if (displaced.size > 0) {
      // 不静默（红线）：顶掉的每一条都是回收站里的幽灵条目——用户若从回收站恢复该文件，会发现标签已被
      // 本轮改名顶替，所以留一行可查（core 层既有口径：[前缀] 说明，见 dedup/import 先例）。
      const list = [...displaced]
      console.warn(
        `[metadata] 目录改名：${list.length} 条回收站幽灵条目被源侧顶掉（这些路径盘上已无文件）: ` +
          `${list.slice(0, 5).join('、')}${list.length > 5 ? ' 等' : ''}`,
      )
    }
    // MetadataService 的读路径拿 metadata.json 的 **mtime** 当缓存判据（metadata.ts loadMetadataStore：
    // `hit.mtime === statMtime` 即认为缓存仍是磁盘最新）。两次写盘落在同一毫秒里会得到相同的 mtimeMs ⇒
    // 缓存会把迁移前的旧 store 继续供出去（界面上看着标签还是丢；本进程内实测约 30% 命中）——
    // 本服务拿不到 MetadataService 实例去主动清缓存，能做的最小手段就是把 mtime 明确推成
    // 「严格晚于改名前那一份」，让下一次读必然判为未命中。utimes 失败（个别文件系统不支持）不阻断改名：
    // 退回原状，最坏是缓存晚一拍，下一次元数据写入自愈。
    const written = await fsp.stat(store).catch(() => null)
    if (written && written.mtimeMs <= mtimeBefore) {
      await fsp.utimes(store, written.atime, new Date(mtimeBefore + 1)).catch(() => {})
    }
  }

  /**
   * v2.5.9（A9 刀4）：老工作区体检——「全局模板表 vs 盘上实际」的差额清单。
   * 只读：不建目录、不删目录、不改配置。给用户在把聚合页也改成以盘为准（刀1d）之前看清存量。
   */
  async healthAudit(): Promise<SubfolderDriftReport> {
    this.requireWorkspace()
    const cfg = await this.loadConfig()
    return auditSubfolderDrift(this.currentWS, cfg)
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
      // v2.5.9（A9 刀1c）：卡片上那排文件夹名改看**盘**（用户拍板"以盘为准"）。
      // 与文件区 tab 共用 `listActualSubfolders` ⇒ 同一实体在两处给同一个答案。
      const setDir = path.join(dir, setName)
      const [imageFolders, certFolders, docFolders] = await Promise.all([
        listActualSubfolders(path.join(setDir, IMAGES_DIR)),
        listActualSubfolders(path.join(setDir, CERTS_DIR)),
        listActualSubfolders(path.join(setDir, DOCS_DIR)),
      ])
      sets.push({
        name: setName,
        image_count: imgCount,
        cert_count: certCount,
        doc_count: docCount,
        image_folders: imageFolders,
        cert_folders: certFolders,
        doc_folders: docFolders,
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
