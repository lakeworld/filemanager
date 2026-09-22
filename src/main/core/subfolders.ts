import fsp from 'node:fs/promises'
import path from 'node:path'
import type fs from 'node:fs'
import type { SubfolderEntry } from '../../shared/types'

/**
 * 列出一个目录下**实际存在**的子文件夹（以盘为准），按名称排序并带空/非空标记。
 *
 * v2.5.9（A9 刀1c）从 `FilesService.listSubfolders` 抽出来当**唯一实现**：
 * 「产品集卡片上那排文件夹」和「文件区那一排 tab」必须给同一个答案，
 * 两处各写一遍 readdir+判空+排序就是双源（本仓最贵的错误类型，见 `AGENTS.md` §一 与 A9 设计 §十三）。
 *
 * 口径三条（出处 `内部 A9 设计（不进公开仓）`）：
 *  - 空目录**照样返回**（`has_files=false`），由调用方决定淡显还是别的处理（§三.2 用户拍板）；
 *  - **排序在这里做**（§八 实测 readdir 原序稳定但非名称序、跨平台不保证 ⇒ 顺序只留一个权威）；
 *  - 隐藏条目与符号链接目录不列（外链不算 tab；要支持得另拍）。
 *
 * 目录不存在返回 `[]` 不抛错：调用方多是"顺手展示"，不该因为某集还没建这个域就整页红。
 */
export async function listActualSubfolders(parentDir: string): Promise<SubfolderEntry[]> {
  const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
  const out: SubfolderEntry[] = []
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    // 判空只扫到第一个非隐藏条目即停；`.DS_Store` 这类隐藏文件不算"有内容"
    const kids = await fsp.readdir(path.join(parentDir, ent.name)).catch(() => [] as string[])
    out.push({ name: ent.name, has_files: kids.some((k) => !k.startsWith('.')) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return out
}
