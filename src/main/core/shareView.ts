/**
 * share 能力域 core（v2.5.1 A2，PLAN-v2.6-v2.7 §3.2）：把工作区发布为只读实体视图 + 拉取写。
 * - 实体视图字段白名单：不含 erp_ext / ocr_ext 命名空间（D10 附录白名单）
 * - 两级元数据粒度：文件路径 → metadata store；产品集根路径 → product_sets.json
 * - 拉取写拒绝清单（D18）：.qihefilemanager/（含 trash）、导出/、交换区/；realpath 逃逸 → 拒绝
 * - readFileChunk：host 侧定位读（fs.read position），≤4MB/次，越界截断到 EOF（短读）
 * 纯 TS：不 import electron（ThumbnailProvider 由装配层注入，getThumb 薄壳在 host 层），node 可直测。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  CUSTOMERS_DIR,
  PRODUCT_SETS_DIR,
  EXPORTS_DIR,
  EXCHANGE_DIR,
  APP_DATA_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  DOCS_DIR,
  productSetRootPath,
  customerRootPath,
  assertSafeFolderName,
  assertSafePathSegment,
} from './paths'
import type { BoxService } from './index'

/** 单 chunk 上限（对端 4MB 对齐，PLAN §3.2 readFileChunk/writePulledFile） */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024
/** mergePulledMetadata 单批上限（PLAN §3.2） */
export const MAX_MERGE_BATCH = 500

/** D18 拒绝清单：工作区隐藏/命名空间目录（相对工作区根，/ 分隔） */
const HIDDEN_TOP = new Set([APP_DATA_DIR, EXPORTS_DIR, EXCHANGE_DIR])

/** relPath（/ 分隔）是否命中拒绝清单（D18）：首段为隐藏目录 → true */
export function isHiddenRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const first = norm.split('/')[0]
  return HIDDEN_TOP.has(first)
}

/** D10 元数据合并纯函数：tags 并集；notes 本地为空采纳远端、本地非空且不同 → 保留本地（计入冲突） */
export function mergeTagsNotes(
  local: { tags: string[]; notes: string },
  remote: { tags: string[]; notes: string },
): { tags: string[]; notes: string; conflict: boolean } {
  const tags = [...new Set([...(local.tags ?? []), ...(remote.tags ?? [])])]
  const localNotes = (local.notes ?? '').trim()
  const remoteNotes = (remote.notes ?? '').trim()
  if (!localNotes) return { tags, notes: remoteNotes, conflict: false }
  if (localNotes === remoteNotes) return { tags, notes: localNotes, conflict: false }
  return { tags, notes: localNotes, conflict: true }
}

interface TreeEntry {
  name: string
  kind: 'dir' | 'file'
  size: number
  mtime: string
}

/** v2.5.5：share 域注册后的可见性反馈钩子——装配层据此向渲染侧广播面板刷新 */
export interface ShareViewHooks {
  /** 子文件夹自动注册成功回调（payload：kind/holder/name；幂等重注册也触发，渲染侧刷新幂等） */
  onSubfolderRegistered?: (info: { kind: 'image' | 'cert' | 'doc' | 'customer'; holder: string; name: string }) => void
}

/** 拉取写结果（writePulledFile 幂等语义） */
export class ShareViewService {
  constructor(private box: BoxService, private hooks?: ShareViewHooks) {}

  private requireWS(): string {
    const ws = this.box.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /** relPath（/ 分隔）→ 工作区内绝对路径；拒绝清单 / 逃逸 → 抛错 */
  private resolveInWs(relPath: string): string {
    const ws = this.requireWS()
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!norm || norm.includes('\0')) throw new Error('非法路径')
    if (isHiddenRelPath(norm)) throw new Error('隐藏目录（.qihefilemanager/导出/交换区）不可访问')
    const abs = path.resolve(ws, norm)
    const rel = path.relative(path.resolve(ws), abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径超出工作区')
    return abs
  }

  // —— 实体视图（只读，白名单）——

  /** 产品集实体视图：name/统计/tags/notes（不含 erp_ext/ocr_ext） */
  async listProductSets(): Promise<unknown[]> {
    const ws = this.requireWS()
    const sets = await this.box.workspace.productSetList()
    return sets.map((s) => ({
      name: s.name,
      image_count: s.image_count,
      cert_count: s.cert_count,
      doc_count: s.doc_count,
      created_at: s.created_at,
      tags: s.tags ?? [],
      notes: s.notes ?? '',
    }))
  }

  /** 客户实体视图：档案白名单字段（不含 erp_ext） */
  async listCustomers(): Promise<unknown[]> {
    const ws = this.requireWS()
    const list = await this.box.clients.list()
    return list.map((c) => ({
      name: c.name,
      file_count: c.file_count,
      alias: c.alias,
      country: c.country,
      contact: c.contact,
      source: c.source,
      type: c.type,
      phone: c.phone,
      email: c.email,
      address: c.address,
      tags: c.tags ?? [],
      notes: c.notes ?? '',
      related_product_sets: c.related_product_sets ?? [],
      created_at: c.created_at,
      updated_at: c.updated_at,
    }))
  }

  /** 目录树一层（名称/类型/大小/mtime）；缺省 = 工作区根；隐藏目录排除 */
  async listTree(relPath?: string): Promise<TreeEntry[]> {
    const ws = this.requireWS()
    const dir = relPath && relPath.length > 0 ? this.resolveInWs(relPath) : ws
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    const out: TreeEntry[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (isHiddenRelPath(e.name)) continue
      let size = 0
      let mtime = ''
      try {
        const st = await fsp.stat(path.join(dir, e.name))
        size = st.isFile() ? st.size : 0
        mtime = st.mtime.toISOString()
      } catch {
        // stat 失败条目仍列出（目录），大小 0
      }
      out.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size, mtime })
    }
    out.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind === 'dir' ? -1 : 1))
    return out
  }

  /** 两级元数据：文件路径 → metadata store；产品集根路径 → product_sets.json（D10） */
  async getMetadata(relPath: string): Promise<{ tags: string[]; notes: string }> {
    const ws = this.requireWS()
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!norm) throw new Error('非法路径')
    // 产品集根路径判定：产品集/<名>（其后无子路径）
    const psPrefix = `${PRODUCT_SETS_DIR}/`
    if (norm.startsWith(psPrefix)) {
      const rest = norm.slice(psPrefix.length)
      if (rest && !rest.includes('/')) {
        const abs = productSetRootPath(ws, rest)
        try {
          await fsp.stat(abs)
          const extra = await this.box.workspace.loadProductSetsInfo()
          const ex = extra[rest] ?? { tags: [], notes: '' }
          return { tags: ex.tags ?? [], notes: ex.notes ?? '' }
        } catch {
          // 目录不存在 → 落文件级路径（下方 resolve 会抛）
        }
      }
    }
    const abs = this.resolveInWs(norm)
    const meta = await this.box.metadata.get(abs)
    return { tags: meta.tags ?? [], notes: meta.notes ?? '' }
  }

  /** 文件信息（大小/mtime） */
  async statFile(relPath: string): Promise<{ size: number; mtime: string }> {
    const abs = this.resolveInWs(relPath)
    const st = await fsp.stat(abs).catch(() => {
      throw new Error('文件不存在')
    })
    if (!st.isFile()) throw new Error('非文件')
    return { size: st.size, mtime: st.mtime.toISOString() }
  }

  /** Range 读：定位读（fs.read position），≤4MB/次；越界截断到 EOF（短读） */
  async readFileChunk(relPath: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
      throw new Error('offset/length 非法')
    }
    if (length > MAX_CHUNK_BYTES) throw new Error(`单次读取超过 ${MAX_CHUNK_BYTES / 1024 / 1024}MB 上限`)
    const abs = this.resolveInWs(relPath)
    const fh = await fsp.open(abs, 'r').catch(() => {
      throw new Error('文件不存在')
    })
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await fh.close()
    }
  }

  // —— 拉取写（对端 → 本工作区）——

  /** 拉取写：offset=0 新建截断、>0 定位写；单 chunk ≤4MB；拒绝清单 → 抛错；写入后失效目标目录索引 */
  async writePulledFile(targetRelPath: string, chunk: Uint8Array, offset: number): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 非法')
    if (!chunk || chunk.byteLength > MAX_CHUNK_BYTES) throw new Error('chunk 超限')
    const ws = this.requireWS()
    const abs = this.resolveInWs(targetRelPath)
    const parent = path.dirname(abs)
    const parentRel = path.relative(ws, parent)
    if (parentRel && isHiddenRelPath(parentRel)) throw new Error('隐藏目录不可写')
    await fsp.mkdir(parent, { recursive: true })
    const flag = offset === 0 ? 'w' : 'r+'
    const fh = await fsp.open(abs, flag as 'w' | 'r+')
    try {
      await fh.write(chunk as Uint8Array, 0, chunk.byteLength, offset)
    } finally {
      await fh.close()
    }
    const { globalWorkspaceIndex } = await import('./indexCache')
    globalWorkspaceIndex.invalidate(parent)
  }

  /** 同名合并：存在 → 'exists'（零覆盖）；不存在 → 复用 productSetCreate/clients.create → 'created' */
  async ensureProductSet(name: string): Promise<'created' | 'exists'> {
    const ws = this.requireWS()
    const dir = productSetRootPath(ws, name)
    try {
      await fsp.stat(dir)
      return 'exists'
    } catch {
      await this.box.workspace.productSetCreate({ name })
      return 'created'
    }
  }

  async ensureCustomer(name: string): Promise<'created' | 'exists'> {
    const ws = this.requireWS()
    const dir = customerRootPath(ws, name)
    try {
      await fsp.stat(dir)
      return 'exists'
    } catch {
      await this.box.clients.create({ name })
      return 'created'
    }
  }

  /** LAN v0.2.3：目录拉取后按需把第一层子文件夹注册进工作区白名单（让宿主面板显示拉来的目录）。
   *  kind=image|cert|doc → 产品集/<holder>/<图包|证书|文档>/<name>；kind=customer → 客户/<holder>/<name>（holder 槽位传客户名）。
   *  缺失目录 → 创建+注册；已存在 → 仅补注册（幂等去重）；名称/holder 防穿越；非白名单 kind 拒绝。 */
  async ensureSubfolder(kind: 'image' | 'cert' | 'doc' | 'customer', holder: string, name: string): Promise<void> {
    if (!['image', 'cert', 'doc', 'customer'].includes(kind)) throw new Error('不支持的子文件夹类别：kind')
    const ws = this.requireWS()
    const safe = assertSafeFolderName(name, '子文件夹名称')
    const holderSafe = assertSafePathSegment(holder, kind === 'customer' ? '客户名称' : '产品集')
    const dir =
      kind === 'image'
        ? path.join(ws, PRODUCT_SETS_DIR, holderSafe, IMAGES_DIR, safe)
        : kind === 'cert'
          ? path.join(ws, PRODUCT_SETS_DIR, holderSafe, CERTS_DIR, safe)
          : kind === 'doc'
            ? path.join(ws, PRODUCT_SETS_DIR, holderSafe, DOCS_DIR, safe)
            : path.join(ws, CUSTOMERS_DIR, holderSafe, safe)
    const existed = await fsp.stat(dir).then(() => true).catch(() => false)
    if (!existed) await fsp.mkdir(dir, { recursive: true })
    const cfg = await this.box.workspace.loadConfig(ws)
    const list =
      kind === 'image'
        ? cfg.image_subfolders
        : kind === 'cert'
          ? cfg.cert_subfolders
          : kind === 'doc'
            ? (cfg.doc_subfolders ??= [])
            : (cfg.customer_subfolders ??= [])
    if (!list.includes(safe)) list.push(safe)
    await this.box.workspace.saveConfig(ws, cfg)
    const { globalWorkspaceIndex } = await import('./indexCache')
    if (existed) globalWorkspaceIndex.invalidate(dir)
    globalWorkspaceIndex.invalidate(path.dirname(dir))
    // v2.5.5：注册成功后通知装配层 → 渲染侧面板即时刷新（可见性反馈）
    this.hooks?.onSubfolderRegistered?.({ kind, holder: holderSafe, name: safe })
  }

  /**
   * 元数据合并导入（D10 两级粒度）：文件路径 → metadata store；产品集根路径 → product_sets.json；
   * tags 并集；notes 本地为空采纳远端、本地非空且不同 → 保留本地（计入冲突清单）；单批 ≤500。
   */
  async mergePulledMetadata(
    entries: { path: string; tags: string[]; notes: string }[],
  ): Promise<{ conflicts: string[] }> {
    if (entries.length > MAX_MERGE_BATCH) throw new Error(`单批超过 ${MAX_MERGE_BATCH} 条上限`)
    const ws = this.requireWS()
    const conflicts: string[] = []
    const psStore = await this.box.workspace.loadProductSetsInfo()
    let psStoreDirty = false
    for (const e of entries) {
      const norm = e.path.replace(/\\/g, '/').replace(/^\/+/, '')
      // 产品集根路径：产品集/<名>（其后无子路径）
      const psPrefix = `${PRODUCT_SETS_DIR}/`
      if (norm.startsWith(psPrefix)) {
        const rest = norm.slice(psPrefix.length)
        if (rest && !rest.includes('/')) {
          const abs = productSetRootPath(ws, rest)
          try {
            await fsp.stat(abs)
            const local = psStore[rest] ?? { tags: [], notes: '' }
            const merged = mergeTagsNotes(
              { tags: local.tags ?? [], notes: local.notes ?? '' },
              { tags: e.tags ?? [], notes: e.notes ?? '' },
            )
            psStore[rest] = { tags: merged.tags, notes: merged.notes }
            psStoreDirty = true
            if (merged.conflict) conflicts.push(norm)
            continue
          } catch {
            // 目录不存在 → 落文件级
          }
        }
      }
      // 文件级 → metadata store
      const abs = this.resolveInWs(norm)
      const local = await this.box.metadata.get(abs)
      const merged = mergeTagsNotes(
        { tags: local.tags ?? [], notes: local.notes ?? '' },
        { tags: e.tags ?? [], notes: e.notes ?? '' },
      )
      await this.box.metadata.update({
        file_path: abs,
        tags: merged.tags,
        notes: merged.notes,
        cert_type: local.cert_type ?? '',
        expiry_date: local.expiry_date ?? '',
      })
      if (merged.conflict) conflicts.push(norm)
    }
    if (psStoreDirty) await this.box.workspace.saveProductSetsInfo(ws, psStore)
    return { conflicts }
  }
}
