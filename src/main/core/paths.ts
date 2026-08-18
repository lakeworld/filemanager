/**
 * 路径常量与工具（对照原 Go workspace.go / files.go）
 * 本模块为纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { readJsonDetailed } from './jsonStore'
import type { NamingTemplate, WorkspaceConfig } from '../../shared/types'

export type { NamingTemplate, WorkspaceConfig } from '../../shared/types'

// —— 目录/文件常量（与原 Go 完全一致，保证旧工作区兼容）——
export const APP_DATA_DIR = '.qihefilemanager'
export const CONFIG_FILE = 'config.json'
export const METADATA_FILE = 'metadata.json'
export const PRODUCT_SETS_INFO_FILE = 'product_sets.json'
export const PRODUCT_SETS_DIR = '产品集'
export const IMAGES_DIR = '图包'
export const CERTS_DIR = '证书'
// v2.5.1（F1）：产品集文档目录（与图包/证书并列；说明书/参数表/质检报告等文档类文件）
export const DOCS_DIR = '文档'
export const EXPORTS_DIR = '导出'
// v2.4.7：客户 / 发票 / 入库 / 交换区 根目录与台账/状态数据文件
export const CUSTOMERS_DIR = '客户'
export const INVOICES_DIR = '发票'
export const INBOUND_DIR = '入库'
export const EXCHANGE_DIR = '交换区'
// v2.4.9 S2：供应商 根目录与档案文件（与 customers.json 同区）
export const SUPPLIERS_DIR = '供应商'
// v2.4.9 S3：报价 根目录与台账文件（报价单原件统一落 报价/<YYYY>/，与 供应商/<名>/ 物理归属不重叠）
export const QUOTES_DIR = '报价'
export const EXCHANGE_DONE_DIR = '已处理'
export const CUSTOMERS_INFO_FILE = 'customers.json'
export const INVOICES_FILE = 'invoices.json'
export const INBOUND_FILE = 'inbound.json'
export const EXCHANGE_STATE_FILE = 'exchange_state.json'
export const SUPPLIERS_INFO_FILE = 'suppliers.json'
export const QUOTES_FILE = '报价.json'
export const RECENT_FILE = '.qihefilemanager_recent.json'
export const TAGS_FILE = 'tags.json'
export const THUMBNAIL_DIR = '.thumbnails'

// —— v2.4.9 S2：供应商固定子文件夹集（决策 1：r3 拍板不做 config 键，create/restore 建齐）——
export const SUPPLIER_SUBFOLDERS = ['合同', '对账单', '往来文件']

// —— v2.4.7：工作区根目录保留名（metadata key 泛化后首段承担区域判别，§3.7；产品集新建/重命名禁止使用）——
export const RESERVED_ROOT_NAMES = ['产品集', '图包', '证书', '导出', '客户', '发票', '入库', '交换区', '供应商', '报价']

/** 名称是否命中工作区根目录保留名（不区分大小写比对，Windows 兼容） */
export function isReservedRootName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return RESERVED_ROOT_NAMES.some((r) => r.toLowerCase() === n)
}

// —— v2.4.9 S3：报价单状态枚举（对齐 keji draft/confirmed/revising；与发票自由流转分叉，转移矩阵见 quotes.ts）——
export const QUOTE_STATUSES = ['草稿', '已确认', '修订中'] as const

export function defaultNamingTemplate(): NamingTemplate {
  return {
    product_set_prefix: '',
    product_set_suffix: '',
    sku_separator: '_',
    // v2.4.9 S5：默认模板 4 字段（sequence 编号槽位；旧工作区显式 3 字段 config 原样保留不迁移）
    sku_fields: ['product_set', 'sub_folder', 'original_name', 'sequence'],
    conflict_suffix: '_{n}',
  }
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    name: 'Workspace',
    naming_template: defaultNamingTemplate(),
    image_subfolders: ['主图', '详情页', '白底图', '素材'],
    cert_subfolders: ['3C', '质检', '专利'],
    customer_subfolders: ['报价', '合同', '沟通', '其他'],
    // v2.5.1（F1，D30）：文档子文件夹默认集（旧 config 缺省由 loadConfig 合并）
    doc_subfolders: ['说明书', '参数表', '质检报告'],
  }
}

// —— 路径构造（与原 Go 函数一一对应）——
export function cmDir(workspace: string): string {
  return path.join(workspace, APP_DATA_DIR)
}

/**
 * 工作区内部受保护路径：`.qihefilemanager/` 下的配置/台账 JSON（config/metadata/customers/...）。
 * 这些文件只允许经事务化写路径（jsonStore）变更；禁止文件直写旁路（如 saveTextFile）绕过损坏守卫（v2.5.3 T2）。
 */
export function isProtectedConfigPath(workspace: string, filePath: string): boolean {
  const cm = path.resolve(cmDir(workspace))
  const p = path.resolve(filePath)
  return p === cm || p.startsWith(cm + path.sep)
}

export function configPath(workspace: string): string {
  return path.join(cmDir(workspace), CONFIG_FILE)
}

export function metadataPath(workspace: string): string {
  return path.join(cmDir(workspace), METADATA_FILE)
}

export function productSetsInfoPath(workspace: string): string {
  return path.join(cmDir(workspace), PRODUCT_SETS_INFO_FILE)
}

export function recentPath(homeDir: string): string {
  return path.join(homeDir, RECENT_FILE)
}

export function productSetRootPath(workspace: string, productSet: string): string {
  return path.join(workspace, PRODUCT_SETS_DIR, productSet)
}

// —— v2.4.7：客户 / 发票 / 入库 / 交换区 路径 ——
export function customersInfoPath(workspace: string): string {
  return path.join(cmDir(workspace), CUSTOMERS_INFO_FILE)
}

export function invoicesPath(workspace: string): string {
  return path.join(cmDir(workspace), INVOICES_FILE)
}

export function inboundPath(workspace: string): string {
  return path.join(cmDir(workspace), INBOUND_FILE)
}

export function exchangeStatePath(workspace: string): string {
  return path.join(cmDir(workspace), EXCHANGE_STATE_FILE)
}

export function customerRootPath(workspace: string, name: string): string {
  return path.join(workspace, CUSTOMERS_DIR, name)
}

// —— v2.4.9 S2：供应商路径 ——
export function suppliersInfoPath(workspace: string): string {
  return path.join(cmDir(workspace), SUPPLIERS_INFO_FILE)
}

export function supplierRootPath(workspace: string, name: string): string {
  return path.join(workspace, SUPPLIERS_DIR, name)
}

// —— v2.4.9 S3：报价路径 ——
export function quotesPath(workspace: string): string {
  return path.join(cmDir(workspace), QUOTES_FILE)
}

export function quoteRootPath(workspace: string): string {
  return path.join(workspace, QUOTES_DIR)
}

export function invoiceRootPath(workspace: string): string {
  return path.join(workspace, INVOICES_DIR)
}

export function inboundRootPath(workspace: string): string {
  return path.join(workspace, INBOUND_DIR)
}

export function exchangeDir(workspace: string): string {
  return path.join(workspace, EXCHANGE_DIR)
}

/** 确保工作区标准目录结构存在（.qihefilemanager/ 产品集/ 图包/ 证书/ 导出/ 客户/ 发票/ 入库/ 交换区/ 供应商/ 报价/） */
export function ensureWorkspaceDirs(workspace: string): void {
  const dirs = [
    cmDir(workspace),
    path.join(workspace, PRODUCT_SETS_DIR),
    path.join(workspace, IMAGES_DIR),
    path.join(workspace, CERTS_DIR),
    path.join(workspace, EXPORTS_DIR),
    // v2.4.7：客户/发票/入库/交换区（mkdirSync recursive 幂等，旧工作区打开即自动补齐）
    path.join(workspace, CUSTOMERS_DIR),
    path.join(workspace, INVOICES_DIR),
    path.join(workspace, INBOUND_DIR),
    path.join(workspace, EXCHANGE_DIR),
    // v2.4.9 S2：供应商 根（同 客户/ 处理，旧工作区打开自动补齐）
    path.join(workspace, SUPPLIERS_DIR),
    // v2.4.9 S3：报价 根（报价/<YYYY>/ 归档年份目录按需建）
    path.join(workspace, QUOTES_DIR),
  ]
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true })
  }
}

// —— JSON 兼容薄壳（事务/耐久化语义集中于 jsonStore.ts）——
export { writeJsonAtomic, overwriteJson } from './jsonStore'

/**
 * 保持旧调用面的 null 降级语义；新的 mutation 调用应直接使用 jsonStore。
 * v2.5.3（T2）：只读路径不移动文件（backupOnCorrupt:false）——损坏照常返回 null 由调用方降级，
 * 损坏文件原位保留，写路径的损坏守卫（readJsonForMutation 隔离备份 + 拒绝覆盖）仍能留证。
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const result = await readJsonDetailed<T>(filePath, { backupOnCorrupt: false })
  return result.ok ? result.value : null
}

// —— 路径安全校验（对照原 files.go 各 HasPrefix 调用点）——
/** 判断 filePath 是否位于 workspace 内部（原实现：filepath.Clean 后 HasPrefix） */
export function isPathInsideWorkspace(workspace: string, filePath: string): boolean {
  const ws = path.resolve(workspace)
  const p = path.resolve(filePath)
  if (p === ws) return true
  return p.startsWith(ws + path.sep)
}

/**
 * v2.4.2（D7）：realpath 版校验——解析符号链接/junction 后再做前缀比对，
 * 堵住「工作区内 symlink 指向外部 → 越界读写」的逃逸。不存在的路径（如待新建文件）
 * realpath 失败时回退词法校验，行为与旧版一致。安全边界一律用此版。
 */
export async function isPathInsideWorkspaceReal(workspace: string, filePath: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => {
    try {
      return await fsp.realpath(p)
    } catch {
      return path.resolve(p)
    }
  }
  const wsR = await real(workspace)
  const pR = await real(filePath)
  if (pR === wsR) return true
  return pR.startsWith(wsR + path.sep)
}

// —— v2.4.2（S1）：名称入参校验（防路径穿越，写操作与拼路径入口统一收口）——

/** 目录/文件名段基础校验：非空、不含分隔符、不含 `..`（fileList 等只读拼路径入口用） */
export function assertSafePathSegment(name: string, label = '名称'): string {
  const n = name.trim()
  if (!n) throw new Error(`${label}不能为空`)
  if (n.includes('/') || n.includes('\\')) throw new Error(`${label}不能包含路径分隔符`)
  if (n.split('/').concat(n.split('\\')).some((s) => s === '..')) {
    throw new Error(`${label}不能包含 ..`)
  }
  return n
}

/** 文件夹/产品集名完整校验（新建/重命名入口用）：在段校验之上追加 Windows 非法字符与首尾点/空格 */
export function assertSafeFolderName(name: string, label = '名称'): string {
  const n = assertSafePathSegment(name, label)
  if (n.startsWith('.') || n.endsWith('.') || n.endsWith(' ')) {
    throw new Error(`${label}不能以 . 或空格开头/结尾`)
  }
  if (/[:*?"<>|]/.test(n)) throw new Error(`${label}包含非法字符（: * ? " < > |）`)
  return n
}

/** 文件名校验（重命名入口用）：段校验 + Windows 非法字符/保留名/尾随点与空格 */
export function assertSafeFileName(name: string): string {
  const n = assertSafePathSegment(name, '文件名')
  if (n.includes('\0')) throw new Error('文件名不能包含 NUL 字符')
  if (n.endsWith('.') || n.endsWith(' ')) throw new Error('文件名不能以 . 或空格结尾')
  if (/[:*?"<>|]/.test(n)) throw new Error('文件名包含非法字符（: * ? " < > |）')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n.split('.')[0])) {
    throw new Error('文件名与系统保留名冲突')
  }
  return n
}

// —— 缩略图路径（对照 files.go thumbnailPath：sha256 前 16 字节 hex 前 2 位分桶）——
// v2.0.1 起 hash 输入改为「相对工作区路径」，跨平台（Win/Linux）一致，
// 避免旧版绝对路径 hash 在平台切换后缩略图失效（工作区经坚果云双机共享时也能复用）
// v2.1.0 起支持注入 root：主进程把缓存根迁移到 userData（thumbs/<workspaceHash>），
// 工作区不再被缩略图污染（不进坚果云同步）；不传 root 时保持旧行为（工作区 .thumbnails）
export function thumbnailPath(workspace: string, filePath: string, root?: string): string {
  const rel = path.relative(path.resolve(workspace), path.resolve(filePath))
  const sum = createHash('sha256').update(rel).digest('hex')
  const key = sum.slice(0, 32) // sha256[:16] 字节 = 32 hex 字符
  const ext = path.extname(filePath).toLowerCase()
  const base = root ?? path.join(cmDir(workspace), THUMBNAIL_DIR)
  return path.join(base, key.slice(0, 2), `${key}${ext}.thumb.jpg`)
}

// —— 文件类型分类（对照 files.go classifyFileType）——
export function classifyFileType(name: string): 'image' | 'pdf' | 'video' | 'other' {
  const ext = path.extname(name).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'].includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].includes(ext)) return 'video'
  return 'other'
}

/** v2.5.1（F1/F3）：Markdown 文件判定——实现移 src/shared/fileKind.ts（双端共用，D21），此处 re-export 保既有 import 稳定 */
export { isMarkdownName } from '../../shared/fileKind'

/** MIME 类型（对照 workspace_file_handler.go mimeTypeForPath） */
export function mimeTypeForPath(name: string): string {
  const ext = path.extname(name).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.tiff':
    case '.tif':
      return 'image/tiff'
    case '.pdf':
      return 'application/pdf'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.avi':
      return 'video/x-msvideo'
    default:
      return 'application/octet-stream'
  }
}

/** 从文件路径提取所属产品集名（对照 files.go productSetFromFilePath） */
export function productSetFromFilePath(workspace: string, filePath: string): string {
  const base = path.join(path.resolve(workspace), PRODUCT_SETS_DIR)
  const rel = path.relative(base, path.resolve(filePath))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  const parts = rel.split(path.sep)
  if (parts.length > 0 && parts[0] !== '.') return parts[0]
  return ''
}

/** 过滤列表项（对照 files.go filterSlice） */
export function filterSlice<T>(list: T[], item: T): T[] {
  return list.filter((v) => v !== item)
}
