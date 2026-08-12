/**
 * 命名模板引擎（v2.4.9 S5：自 src/main/core/naming.ts 迁入 shared，双端共享）
 * 纯 TS：无 node / electron 依赖，main（core/naming.ts 透传）与 renderer（批量重命名）均可用。
 * 对照原 Go files.go importOneFile 的命名逻辑。
 */
import type { NamingTemplate } from './types'

/** 非法字符替换（对照 sanitizeName） */
export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

export interface ImportContext {
  targetProductSet: string
  subFolder: string
  /** v2.4.9 S5：预格式化补零字符串（如 '01'）；缺省/空 → 槽位跳过（发票/报价/交换区归档等无编号场景行为不变） */
  sequence?: string
}

/** 按命名模板组合目标文件名（含扩展名）。对照原 Go compose 逻辑。 */
export function composeTargetName(template: NamingTemplate, base: string, ext: string, ctx: ImportContext): string {
  const t = template
  const sep = t.sku_separator || '_'
  const fieldMap: Record<string, string> = {
    product_set: ctx.targetProductSet,
    sub_folder: ctx.subFolder,
    original_name: base,
    sequence: ctx.sequence || '',
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
