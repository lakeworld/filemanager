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
 * 冲突后缀解析：在扩展名前插入 `_{n}` 递增序号，返回第一个未被占用的名字。
 *
 * **基数永远是原始 `candidate`**（v2.5.x 修）：旧实现把上一轮的产物当累加器继续追加，
 * 第 3 次同名会产出 `X_1_2`（原 Go `files.go` 平移时一起带过来的缺陷，测试曾注明
 * 「与原 Go 累积行为一致」把它合法化）。危害不止观感：
 *  - 文件名里 `_` 是 SKU 分隔符（`产品集_子文件夹_原名_编号`），`_1_2` 会被误读成编号槽位出了两次；
 *  - 字典序错乱：`X_1_10` 排在 `X_1_2` 之前，按名排序的列表与导出会跳序。
 * 本函数**不再**保持该累积行为；渲染层 `utils/batchRename.ts` 一直是对的（它每次从 candidate 重拼），
 * 其注释「参照后端 resolveConflictName 语义」自此以本实现为准。
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
  // 基数只算一次。扩展名按大小写不敏感匹配，但**保留候选名自己的尾部原样**——
  // 调用方传入的 ext 未必已小写化（files.ts:832 / archive.ts:394 用 path.extname 原样传），
  // 若无脑 slice 会把 `A.JPG` 截成 `A` + `.jpg` → `A_1.jpg`，改掉用户文件的扩展名大小写。
  const extLen = ext.length
  const hasExt = extLen > 0 && candidate.toLowerCase().endsWith(ext.toLowerCase())
  const stem = hasExt ? candidate.slice(0, -extLen) : candidate
  const tail = hasExt ? candidate.slice(-extLen) : ''
  for (let i = 1; ; i++) {
    const part = suffix.replaceAll('{n}', String(i))
    // v2.4.2（D1）：无扩展名文件（ext === ''）时 slice(0, -0) 会清空整个文件名，必须原样保留
    const name = stem + part + tail
    if (!(await exists(path.join(targetDir, name)))) return name
  }
}
