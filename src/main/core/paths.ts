/**
 * 路径常量与工具（对照原 Go workspace.go / files.go）
 * 本模块为纯 TS 业务层：不 import electron，可在 node 环境直接测试。
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

// —— 目录/文件常量（与原 Go 完全一致，保证旧工作区兼容）——
export const APP_DATA_DIR = '.qihefilemanager'
export const CONFIG_FILE = 'config.json'
export const METADATA_FILE = 'metadata.json'
export const PRODUCT_SETS_INFO_FILE = 'product_sets.json'
export const PRODUCT_SETS_DIR = '产品集'
export const IMAGES_DIR = '图包'
export const CERTS_DIR = '证书'
export const EXPORTS_DIR = '导出'
export const RECENT_FILE = '.qihefilemanager_recent.json'
export const TAGS_FILE = 'tags.json'
export const THUMBNAIL_DIR = '.thumbnails'

export interface NamingTemplate {
  product_set_prefix: string
  product_set_suffix: string
  sku_separator: string
  sku_fields: string[]
  conflict_suffix: string
}

export interface WorkspaceConfig {
  name: string
  naming_template: NamingTemplate
  image_subfolders: string[]
  cert_subfolders: string[]
}

export function defaultNamingTemplate(): NamingTemplate {
  return {
    product_set_prefix: '',
    product_set_suffix: '',
    sku_separator: '_',
    sku_fields: ['product_set', 'sub_folder', 'original_name'],
    conflict_suffix: '_{n}',
  }
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    name: 'Workspace',
    naming_template: defaultNamingTemplate(),
    image_subfolders: ['主图', '详情页', '白底图', '素材'],
    cert_subfolders: ['3C', '质检', '专利'],
  }
}

// —— 路径构造（与原 Go 函数一一对应）——
export function cmDir(workspace: string): string {
  return path.join(workspace, APP_DATA_DIR)
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

/** 确保工作区标准目录结构存在（.qihefilemanager/ 产品集/ 图包/ 证书/ 导出/） */
export function ensureWorkspaceDirs(workspace: string): void {
  const dirs = [
    cmDir(workspace),
    path.join(workspace, PRODUCT_SETS_DIR),
    path.join(workspace, IMAGES_DIR),
    path.join(workspace, CERTS_DIR),
    path.join(workspace, EXPORTS_DIR),
  ]
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true })
  }
}

// —— 原子 JSON 写（tmp + rename，防崩溃损坏原文件）——
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const content = JSON.stringify(data, null, 2)
  await fsp.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o644 })
  await fsp.rename(tmpPath, filePath)
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// —— 路径安全校验（对照原 files.go 各 HasPrefix 调用点）——
/** 判断 filePath 是否位于 workspace 内部（原实现：filepath.Clean 后 HasPrefix） */
export function isPathInsideWorkspace(workspace: string, filePath: string): boolean {
  const ws = path.resolve(workspace)
  const p = path.resolve(filePath)
  if (p === ws) return true
  return p.startsWith(ws + path.sep)
}

// —— 缩略图路径（对照 files.go thumbnailPath：sha256 前 16 字节 hex 前 2 位分桶）——
// v2.0.1 起 hash 输入改为「相对工作区路径」，跨平台（Win/Linux）一致，
// 避免旧版绝对路径 hash 在平台切换后缩略图失效（工作区经坚果云双机共享时也能复用）
export function thumbnailPath(workspace: string, filePath: string): string {
  const rel = path.relative(path.resolve(workspace), path.resolve(filePath))
  const sum = createHash('sha256').update(rel).digest('hex')
  const key = sum.slice(0, 32) // sha256[:16] 字节 = 32 hex 字符
  const ext = path.extname(filePath).toLowerCase()
  return path.join(cmDir(workspace), THUMBNAIL_DIR, key.slice(0, 2), `${key}${ext}.thumb.jpg`)
}

// —— 文件类型分类（对照 files.go classifyFileType）——
export function classifyFileType(name: string): 'image' | 'pdf' | 'video' | 'other' {
  const ext = path.extname(name).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'].includes(ext)) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].includes(ext)) return 'video'
  return 'other'
}

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
