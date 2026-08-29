/**
 * 笔记工作台聚合（v2.5.7 A2，PLAN §三-B）。
 *
 * 「文档就是笔记」：笔记 = 文件区内建「笔记」子文件夹里的 .md。无独立存储、无 index.json——
 * 本模块只做**只读聚合**（扫三域笔记文件夹，按 mtime 倒序出最近笔记），供：
 * - /notes 工作台列表；
 * - 整包压缩「随包附带笔记」勾选检测（带 entity 参数计数，无独立检测 IPC）。
 *
 * 纯 fs：不 import electron / 任何模块（node 可直测）。三域 = 产品集文档区 + 客户 + 供应商。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import {
  PRODUCT_SETS_DIR,
  CUSTOMERS_DIR,
  SUPPLIERS_DIR,
  DOCS_DIR,
  BUILTIN_NOTES_SUBFOLDER,
} from './paths'

/** 笔记实体过滤（整包勾选检测用；缺省 = 全三域聚合） */
export type NoteEntityFilter =
  | { kind: 'product_set'; name: string }
  | { kind: 'customer'; name: string }
  | { kind: 'supplier'; name: string }

export interface NoteEntry {
  /** 工作区相对路径（/ 分隔）——深链与详情定位用 */
  relPath: string
  /** 归属实体名（产品集/客户/供应商名） */
  entity: string
  /** 实体类型（产品集文档区 / 客户文件区 / 供应商文件区） */
  kind: 'product_set' | 'customer' | 'supplier'
  /** 标题 = .md 文件名去扩展名 */
  title: string
  /** 文件修改时间（ISO；列表排序键） */
  mtime: string
  /** 文件大小（字节） */
  size: number
}

/** 扫单目录下 *.md（仅非隐藏文件，一层即笔记根深度；.md 后缀大小写敏感接受小写） */
async function scanDir(dir: string, prefix: string, kind: NoteEntry['kind'], entity: string, out: NoteEntry[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在/无权限 → 无
  }
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    if (!e.name.toLowerCase().endsWith('.md')) continue
    const abs = path.join(dir, e.name)
    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    out.push({
      relPath: `${prefix}/${e.name}`,
      entity,
      kind,
      title: e.name.replace(/\.md$/i, ''),
      mtime: st.mtime.toISOString(),
      size: st.size,
    })
  }
}

/** 聚合三域最近笔记：产品集/<名>/文档/笔记、客户/<名>/笔记、供应商/<名>/笔记。
 *  entity 过滤：单实体（整包勾选检测用——listRecentNotes({kind,name},1) 即可计数非空）。
 *  limit 截断（默认 100）；返回按 mtime 倒序。 */
export async function listRecentNotes(
  workspace: string,
  entity?: NoteEntityFilter,
  limit = 100,
): Promise<NoteEntry[]> {
  const out: NoteEntry[] = []
  if (entity) {
    // 单实体
    if (entity.kind === 'product_set') {
      await scanDir(
        path.join(workspace, PRODUCT_SETS_DIR, entity.name, DOCS_DIR, BUILTIN_NOTES_SUBFOLDER),
        `${PRODUCT_SETS_DIR}/${entity.name}/${DOCS_DIR}/${BUILTIN_NOTES_SUBFOLDER}`,
        'product_set',
        entity.name,
        out,
      )
      return out.sort(byMtimeDesc).slice(0, limit)
    }
    if (entity.kind === 'customer') {
      await scanDir(
        path.join(workspace, CUSTOMERS_DIR, entity.name, BUILTIN_NOTES_SUBFOLDER),
        `${CUSTOMERS_DIR}/${entity.name}/${BUILTIN_NOTES_SUBFOLDER}`,
        'customer',
        entity.name,
        out,
      )
      return out.sort(byMtimeDesc).slice(0, limit)
    }
    await scanDir(
      path.join(workspace, SUPPLIERS_DIR, entity.name, BUILTIN_NOTES_SUBFOLDER),
      `${SUPPLIERS_DIR}/${entity.name}/${BUILTIN_NOTES_SUBFOLDER}`,
      'supplier',
      entity.name,
      out,
    )
    return out.sort(byMtimeDesc).slice(0, limit)
  }
  // 全三域
  const psRoot = path.join(workspace, PRODUCT_SETS_DIR)
  try {
    const psDirs = await fsp.readdir(psRoot, { withFileTypes: true })
    for (const d of psDirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      await scanDir(
        path.join(psRoot, d.name, DOCS_DIR, BUILTIN_NOTES_SUBFOLDER),
        `${PRODUCT_SETS_DIR}/${d.name}/${DOCS_DIR}/${BUILTIN_NOTES_SUBFOLDER}`,
        'product_set',
        d.name,
        out,
      )
    }
  } catch {
    /* 产品集目录缺失/无权限 → 跳过 */
  }
  const domains: { root: string; label: string; kind: NoteEntry['kind'] }[] = [
    { root: CUSTOMERS_DIR, label: CUSTOMERS_DIR, kind: 'customer' },
    { root: SUPPLIERS_DIR, label: SUPPLIERS_DIR, kind: 'supplier' },
  ]
  for (const { root, label, kind } of domains) {
    const r = path.join(workspace, root)
    try {
      const dirs = await fsp.readdir(r, { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue
        await scanDir(
          path.join(r, d.name, BUILTIN_NOTES_SUBFOLDER),
          `${label}/${d.name}/${BUILTIN_NOTES_SUBFOLDER}`,
          kind,
          d.name,
          out,
        )
      }
    } catch {
      /* 客户/供应商目录缺失 → 跳过 */
    }
  }
  return out.sort(byMtimeDesc).slice(0, limit)
}

function byMtimeDesc(a: NoteEntry, b: NoteEntry): number {
  return a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.relPath.localeCompare(b.relPath)
}
