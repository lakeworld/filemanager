/**
 * 命名模板引擎（对照原 Go files.go importOneFile 的命名逻辑）
 * v2.4.9 S5：sanitizeName / ImportContext / composeTargetName 迁入 src/shared/naming.ts（双端共享），
 * 此处透传（现有 import 方零改动——符号从本模块仍可拿到）；resolveConflictName 留原文件。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'

export { sanitizeName, composeTargetName } from '../../shared/naming'
export type { ImportContext } from '../../shared/naming'

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
