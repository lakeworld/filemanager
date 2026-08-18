/**
 * 全局搜索（对照原 Go search.go）
 * 纯 TS 业务层。
 * v2.4.4（T1）：搜索命中标签——产品集与文件的 tags 参与关键词匹配；
 * 文件侧经 metadata 内存缓存按路径 join（不重建文件索引），命中条目附带 tags 供展示。
 * v2.4.7（§4.2）：
 * - result.customers：客户实体命中（客户名/别名/标签，对齐产品集结果形态）
 * - result.files 纳入 客户/、发票/、入库/ 目录文件（文件名/标签命中；FileEntry.path 自明来源区域）
 * - 实体记录（发票台账/入库单条目）不进全局搜索——台账检索由页内筛选/搜索承担（§6.5）
 * - 产品集扫描逻辑不动（存量兼容优先，§4.1 判读规则）
 * v2.4.9（§6.2）：result.files 再纳入 供应商/、报价/ 目录原件（供应商/<名>/<子文件夹>、报价/<YYYY>/，
 * 同发票/入库先例；供应商/报价台账记录同发票不进全局搜索）
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  PRODUCT_SETS_DIR,
  IMAGES_DIR,
  CERTS_DIR,
  CUSTOMERS_DIR,
  SUPPLIERS_DIR,
  QUOTES_DIR,
  DOCS_DIR,
  customersInfoPath,
  customerRootPath,
  invoiceRootPath,
  inboundRootPath,
  readJsonFile,
} from './paths'
import { WorkspaceService, countFiles, formatTime, ProductSetInfo } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, FileEntry } from './files'
import type { SearchResult, CustomerInfo, CustomerExtraInfo } from '../../shared/types'

export type { SearchResult } from '../../shared/types'

export class SearchService {
  constructor(
    private workspace: WorkspaceService,
    private files: FilesService,
    private metadata: MetadataService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  async search(query: string): Promise<SearchResult> {
    const ws = this.requireWS()
    const q = query.toLowerCase().trim()
    const result: SearchResult = { files: [], product_sets: [] }
    if (!q) return result
    // v2.4.7：非空查询才初始化 customers（空查询保持既有返回形状，渲染端以 ?? [] 兜底）
    result.customers = []
    const seenSet = new Set<string>()

    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const entries = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])

    // v2.4.4（T1）：一次性读元数据缓存与产品集标签，构建 文件路径 → tags 索引（内存命中，不重建文件索引）
    const [store, extra] = await Promise.all([this.metadata.loadMetadataStore(), this.workspace.loadProductSetsInfo()])
    const tagsByKey = new Map<string, string[]>()
    for (const [key, meta] of Object.entries(store.files)) {
      if (meta.tags && meta.tags.length > 0) tagsByKey.set(key, meta.tags)
    }

    const setTags = (name: string): string[] => extra[name]?.tags ?? []
    const tagHit = (tags: string[]): boolean => tags.some((t) => t.toLowerCase().includes(q))

    for (const set of entries) {
      if (!set.isDirectory()) continue
      const setName = set.name
      const setMatched = setName.toLowerCase().includes(q) || tagHit(setTags(setName))

      const buildSetInfo = async (): Promise<ProductSetInfo> => {
        const [info, imgCount, certCount, docCount] = await Promise.all([
          fsp.stat(path.join(setsDir, setName)),
          countFiles(path.join(setsDir, setName, IMAGES_DIR)),
          countFiles(path.join(setsDir, setName, CERTS_DIR)),
          // v2.5.1（F1）：文档文件数（与 productSetList 统计同法）
          countFiles(path.join(setsDir, setName, DOCS_DIR)),
        ])
        return {
          name: setName,
          image_count: imgCount,
          cert_count: certCount,
          doc_count: docCount,
          created_at: formatTime(info.mtime),
          tags: setTags(setName),
          notes: extra[setName]?.notes ?? '',
        }
      }

      if (setMatched) {
        result.product_sets.push(await buildSetInfo())
        seenSet.add(setName)
      }

      const [imgFiles, certFiles, docFiles] = await Promise.all([
        // v2.5.3（P1-4）：搜索结果缩略图由渲染层按 file.path 按需取（FileThumbnail），thumbnail_path 零消费 → resolveThumb:false
        this.files.listDirFilesRecursive(path.join(setsDir, setName, IMAGES_DIR), { resolveThumb: false }),
        this.files.listDirFilesRecursive(path.join(setsDir, setName, CERTS_DIR), { resolveThumb: false }),
        // v2.5.2（D7）：产品集「文档」目录纳入全局搜索（v2.5.1 文档域新增后遗漏，动作-2026-08-15-删除崩溃与登录事件再定位）
        this.files.listDirFilesRecursive(path.join(setsDir, setName, DOCS_DIR), { resolveThumb: false }),
      ])
      for (const f of [...imgFiles, ...certFiles, ...docFiles]) {
        const tags = this.fileTags(f, tagsByKey)
        if (f.name.toLowerCase().includes(q) || tagHit(tags)) {
          if (tags.length > 0) f.tags = tags
          result.files.push(f)
          if (!seenSet.has(setName)) {
            result.product_sets.push(await buildSetInfo())
            seenSet.add(setName)
          }
        }
      }
    }

    // —— v2.4.7（§4.2）：客户实体 + 客户/发票/入库 三区文件 ——
    // 客户实体命中 = 客户名/别名/标签含关键词（对齐产品集结果形态：文件命中时客户也一并返回，供分组展示）
    const customersDir = path.join(ws, CUSTOMERS_DIR)
    const customerDirs = await fsp.readdir(customersDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    const customerStore = (await readJsonFile<Record<string, CustomerExtraInfo>>(customersInfoPath(ws))) ?? {}
    const seenCustomer = new Set<string>()

    for (const c of customerDirs) {
      if (!c.isDirectory()) continue
      const name = c.name
      const ex = customerStore[name] ?? {}
      const alias = (ex.alias ?? '').toLowerCase()
      const entityMatched = name.toLowerCase().includes(q) || alias.includes(q) || tagHit(ex.tags ?? [])

      if (entityMatched) {
        result.customers.push(await this.buildCustomerInfo(ws, name, ex))
        seenCustomer.add(name)
      }

      const custFiles = await this.files.listDirFilesRecursive(customerRootPath(ws, name), { resolveThumb: false })
      for (const f of custFiles) {
        const tags = this.fileTags(f, tagsByKey)
        if (f.name.toLowerCase().includes(q) || tagHit(tags)) {
          if (tags.length > 0) f.tags = tags
          result.files.push(f)
          if (!seenCustomer.has(name)) {
            result.customers.push(await this.buildCustomerInfo(ws, name, ex))
            seenCustomer.add(name)
          }
        }
      }
    }

    // 发票/入库区：直接递归扫描（台账记录不进全局搜索，文件本体纳入）
    // v2.4.9（§6.2）：供应商/报价区同法纳入（供应商/<名>/<子文件夹> 与 报价/<YYYY>/ 原件）
    for (const root of [invoiceRootPath(ws), inboundRootPath(ws), path.join(ws, SUPPLIERS_DIR), path.join(ws, QUOTES_DIR)]) {
      const regionFiles = await this.files.listDirFilesRecursive(root, { resolveThumb: false })
      for (const f of regionFiles) {
        const tags = this.fileTags(f, tagsByKey)
        if (f.name.toLowerCase().includes(q) || tagHit(tags)) {
          if (tags.length > 0) f.tags = tags
          result.files.push(f)
        }
      }
    }
    return result
  }

  /** v2.4.7：客户实体信息（目录扫描 × customers.json 合并，文件数递归计数，对齐产品集结果形态） */
  private async buildCustomerInfo(ws: string, name: string, ex: CustomerExtraInfo): Promise<CustomerInfo> {
    const dir = customerRootPath(ws, name)
    const [info, fileCount] = await Promise.all([fsp.stat(dir), countFiles(dir)])
    const c: CustomerInfo = {
      name,
      file_count: fileCount,
      tags: ex.tags ?? [],
      notes: ex.notes ?? '',
      created_at: ex.created_at ?? formatTime(info.mtime),
      updated_at: ex.updated_at ?? formatTime(info.mtime),
    }
    // 可选档案字段仅在存在时附加（对齐 shared/types CustomerInfo「其余可选」口径）
    if (ex.alias) c.alias = ex.alias
    if (ex.country) c.country = ex.country
    if (ex.contact) c.contact = ex.contact
    if (ex.source) c.source = ex.source
    if (ex.related_product_sets && ex.related_product_sets.length > 0) c.related_product_sets = ex.related_product_sets
    if (ex.erp_ext) c.erp_ext = ex.erp_ext
    return c
  }

  /** v2.4.7：文件标签按元数据 key 查询（metadata key 泛化后客户/发票/入库区文件与产品集同法 join） */
  private fileTags(f: FileEntry, tagsByKey: Map<string, string[]>): string[] {
    const key = this.metadata.fileMetadataKey(f.path)
    return key ? tagsByKey.get(key) ?? [] : []
  }
}
