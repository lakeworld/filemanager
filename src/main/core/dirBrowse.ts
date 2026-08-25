/**
 * 目录浏览（发票批量识别选任意系统文件夹，v2.5.5 打磨 2）：
 * - 不依赖工作区/产品集结构——用户自选任意文件夹，列出其中的发票候选文件（PDF / 图片）与子文件夹
 * - 纯函数 isInvoiceCandidate 可 node 直测；listInvoiceDir 封装 readdir + stat
 * - 只读语义：不落盘、不改动任何文件；隐藏文件（以 . 开头）排除
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 发票批量识别候选扩展名（识别插件支持：图片多模态 + 文字层 PDF） */
const INVOICE_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp'])

/** 是否为发票批量识别的候选文件（按扩展名，大小写不敏感） */
export function isInvoiceCandidate(name: string): boolean {
  return INVOICE_EXT.has(path.extname(name).toLowerCase())
}

/** 扩展名 → 预览/识别 file_type（pdf → pdf，其余图片类 → image） */
export function invoiceFileTypeOf(name: string): string {
  return path.extname(name).toLowerCase() === '.pdf' ? 'pdf' : 'image'
}

export interface DirBrowseEntry {
  name: string
  path: string
  size: number
  modified: string
  file_type: string
  thumbnail_path: string | null
}

export interface DirBrowseResult {
  dir: string
  /** 子文件夹名（相对当前目录，点击可进入） */
  dirs: string[]
  /** 发票候选文件（绝对路径） */
  files: DirBrowseEntry[]
}

/** 列出目录内：子文件夹 + 发票候选文件（一层，不递归；隐藏排除；目录在前、文件按名排序） */
export async function listInvoiceDir(dirPath: string): Promise<DirBrowseResult> {
  if (!dirPath) return { dir: '', dirs: [], files: [] }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch {
    // 目录不存在/无权限：返回空（面板提示「无法读取该文件夹」由 dir 字段判定）
    return { dir: dirPath, dirs: [], files: [] }
  }
  const dirs: string[] = []
  const files: DirBrowseEntry[] = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dirPath, ent.name)
    if (ent.isDirectory()) {
      dirs.push(ent.name)
    } else if (ent.isFile() && isInvoiceCandidate(ent.name)) {
      let size = 0
      let modified = ''
      try {
        const st = await fsp.stat(full)
        size = st.size
        modified = st.mtime.toISOString()
      } catch {
        /* stat 失败保持缺省（预览/识别按路径读，不影响列表） */
      }
      files.push({ name: ent.name, path: full, size, modified, file_type: invoiceFileTypeOf(ent.name), thumbnail_path: null })
    }
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, 'zh-CN')
  dirs.sort(cmp)
  files.sort((a, b) => cmp(a.name, b.name))
  return { dir: dirPath, dirs, files }
}
