/**
 * v2.5.9（A9 刀4）：老工作区体检——「全局模板表 vs 盘上实际」的差额清单
 *
 * 为什么需要它：A9 把子文件夹名单改成**以盘为准**后，界面上会**突然多出**一批以前看不见的
 * 目录（盘上有、`config.*_subfolders` 里没登记过的）。在把聚合页也改成以盘为准（刀1d）之前，
 * 得先让用户看清自己工作区的存量长什么样，否则"改完突然多出一堆"没法解释、也没法决定要不要动。
 *
 * 口径与 `listActualSubfolders` **完全一致**（同一函数扫盘）：隐藏目录/非目录/符号链接都不算，
 * 目录里有非隐藏文件才算 `has_files`。这样体检说的"盘上有什么"和界面 tab 显示的永远是同一份。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { listActualSubfolders } from './subfolders'
import type { EmptyFolderEntry, SubfolderDriftReport, UnregisteredFolder } from '../../shared/types'
import { CUSTOMERS_DIR, DOCS_DIR, IMAGES_DIR, PRODUCT_SETS_DIR, SUPPLIERS_DIR, CERTS_DIR } from './paths'

/** 表字段名与盘上目录的对应关系（一张表管一个域） */
const TABLE_FOR_KIND: Record<string, keyof Pick<
  WorkspaceConfigLike,
  'image_subfolders' | 'cert_subfolders' | 'doc_subfolders' | 'customer_subfolders' | 'supplier_subfolders'
>> = {
  image: 'image_subfolders',
  cert: 'cert_subfolders',
  doc: 'doc_subfolders',
  customer: 'customer_subfolders',
  supplier: 'supplier_subfolders',
}

/** 只取本函数要用的五个字段（避免把整个 WorkspaceConfig 拖进这个纯模块） */
export interface WorkspaceConfigLike {
  image_subfolders?: string[]
  cert_subfolders?: string[]
  doc_subfolders?: string[]
  customer_subfolders?: string[]
  supplier_subfolders?: string[]
}

/** 列出某类实体的目录名（不存在/读失败 ⇒ 空集） */
async function listEntityDirs(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [] as { name: string; isDirectory(): boolean }[])
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'zh'))
}

/**
 * 体检一个工作区。**只读**：不建目录、不删目录、不改配置。
 * 任何一层读失败都按"那一层没有"处理（体检不该因为一处坏了就整份报不出来）。
 */
export async function auditSubfolderDrift(
  ws: string,
  cfg: WorkspaceConfigLike,
): Promise<SubfolderDriftReport> {
  const unregistered: UnregisteredFolder[] = []
  const emptyFolders: EmptyFolderEntry[] = []
  const seenOnDisk = new Map<string, number>() // 模板名 → 在多少个实体里真的存在
  let scannedEntities = 0

  const tableOf = (kind: string): string[] => {
    const key = TABLE_FOR_KIND[kind]
    // cfg 按宽松 Record 读：本函数只碰这五个字段，缺字段按"没登记"处理
    return (key ? (cfg as Record<string, string[] | undefined>)[key] : undefined) ?? []
  }

  /** 扫一个实体的一类目录；kind 同时用于选表与选盘上子目录 */
  const scanKind = async (
    scope: UnregisteredFolder['scope'],
    entity: string,
    kind: string,
    baseDir: string,
  ): Promise<void> => {
    const table = new Set(tableOf(kind))
    const entries = await listActualSubfolders(baseDir)
    for (const entry of entries) {
      if (!table.has(entry.name)) {
        unregistered.push({ scope, entity, kind, name: entry.name })
      }
      if (table.has(entry.name)) seenOnDisk.set(entry.name, (seenOnDisk.get(entry.name) ?? 0) + 1)
      if (!entry.has_files) emptyFolders.push({ scope, entity, kind, name: entry.name })
    }
  }

  // ① 产品集：图包 / 证书 / 文档 三类各自对自己的表
  for (const ps of await listEntityDirs(path.join(ws, PRODUCT_SETS_DIR))) {
    scannedEntities += 1
    await scanKind('productSet', ps, 'image', path.join(ws, PRODUCT_SETS_DIR, ps, IMAGES_DIR))
    await scanKind('productSet', ps, 'cert', path.join(ws, PRODUCT_SETS_DIR, ps, CERTS_DIR))
    await scanKind('productSet', ps, 'doc', path.join(ws, PRODUCT_SETS_DIR, ps, DOCS_DIR))
  }
  // ② 客户 / 供应商：子文件夹直接挂在实体目录下
  for (const c of await listEntityDirs(path.join(ws, CUSTOMERS_DIR))) {
    scannedEntities += 1
    await scanKind('customer', c, 'customer', path.join(ws, CUSTOMERS_DIR, c))
  }
  for (const s of await listEntityDirs(path.join(ws, SUPPLIERS_DIR))) {
    scannedEntities += 1
    await scanKind('supplier', s, 'supplier', path.join(ws, SUPPLIERS_DIR, s))
  }

  // ③ 模板死条目：五张表里登记过、但盘上任何实体都没有的名字
  const templateOnly: string[] = []
  for (const kind of Object.keys(TABLE_FOR_KIND)) {
    for (const name of tableOf(kind)) {
      if (!seenOnDisk.has(name) && !templateOnly.includes(name)) templateOnly.push(name)
    }
  }

  // 稳定顺序：先按 scope/entity/kind，同实体内按名称——报告要能直接念
  const order = { productSet: 0, customer: 1, supplier: 2 }
  unregistered.sort(
    (a, b) => order[a.scope] - order[b.scope] || a.entity.localeCompare(b.entity, 'zh') || a.name.localeCompare(b.name, 'zh'),
  )
  emptyFolders.sort(
    (a, b) => order[a.scope] - order[b.scope] || a.entity.localeCompare(b.entity, 'zh') || a.name.localeCompare(b.name, 'zh'),
  )
  templateOnly.sort((a, b) => a.localeCompare(b, 'zh'))

  return { scannedEntities, unregistered, templateOnly, emptyFolders }
}
