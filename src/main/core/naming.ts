/**
 * 命名模板引擎（对照原 Go files.go importOneFile 的命名逻辑）
 * 纯 TS：可在 node 环境直接测试（原实现此逻辑无直接单测，本次补上）。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { WorkspaceConfig } from './paths'

/** 非法字符替换（对照 sanitizeName） */
export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

export interface ImportContext {
  targetProductSet: string
  subFolder: string
}

/** 按命名模板组合目标文件名（含扩展名）。对照原 Go compose 逻辑。 */
export function composeTargetName(cfg: WorkspaceConfig, base: string, ext: string, ctx: ImportContext): string {
  const t = cfg.naming_template
  const sep = t.sku_separator || '_'
  const fieldMap: Record<string, string> = {
    product_set: ctx.targetProductSet,
    sub_folder: ctx.subFolder,
    original_name: base,
  }
  const parts: string[] = []
  if (t.product_set_prefix) parts.push(t.product_set_prefix)
  for (const f of t.sku_fields) {
    const v = fieldMap[f]
    if (v) parts.push(v)
  }
  if (t.product_set_suffix) parts.push(t.product_set_suffix)
  if (parts.length === 0) parts.push(base)
  return parts.join(sep) + ext
}

/**
 * 冲突后缀解析：在扩展名前插入 `_{n}` 递增序号（对照原 Go 循环）。
 * 注意：原实现每次在"当前 candidate"基础上追加，多次冲突会累积序号（base_1_2），
 * 此处保持行为一致。原名不存在时直接返回原名。
 */
export async function resolveConflictName(
  targetDir: string,
  candidate: string,
  conflictSuffix: string,
  ext: string,
): Promise<string> {
  const suffix = conflictSuffix || '_{n}'
  const exists = async (p: string): Promise<boolean> =>
    fsp.stat(p).then(() => true).catch(() => false)
  // 原名可用则直接用
  if (!(await exists(path.join(targetDir, candidate)))) return candidate
  let name = candidate
  for (let i = 1; ; i++) {
    const part = suffix.replaceAll('{n}', String(i))
    // v2.4.2（D1）：无扩展名文件（ext === ''）时 slice(0, -0) 会清空整个文件名，必须原样保留
    name = (ext ? name.slice(0, -ext.length) : name) + part + ext
    if (!(await exists(path.join(targetDir, name)))) return name
  }
}
