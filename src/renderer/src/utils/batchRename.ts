import type { FileEntry, NamingTemplate } from "../types";
import { composeTargetName } from "../../../shared/naming";

/**
 * 批量重命名目标名生成（v2.3.3 P2 引入，v2.4.9 S5 复用命名模板）。
 * 规则：逐文件套用命名模板（composeTargetName，shared 纯函数）——product_set / sub_folder / original_name
 * 槽位来自 ctx，sequence 槽位 = 「起始序号 + 偏移」补零，位数按「起始序号 + 数量」自适应；
 * 目标名与批内其它目标名 / 磁盘已有文件名冲突时（自身原名除外），
 * 参照后端 resolveConflictName 语义在扩展名前追加 `_1`、`_2` 递增（无扩展名文件原样追加），保证每个目标名唯一。
 * 应用阶段由前端逐个调用 api.files.rename，后端仅做最终兜底校验。
 */
export function batchRenameTargets(
  files: FileEntry[],
  template: NamingTemplate,
  ctx: { targetProductSet: string; subFolder: string },
  start: number,
): string[] {
  const len = files.length;
  const digits = Math.max(1, String(start + len - 1).length);
  // 磁盘上现有文件名（含其它选中文件的原名）：目标名与其冲突时需绕行
  const existing = new Set(files.map((f) => f.name));
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const ext = extOf(files[i].name);
    const candidate = composeTargetName(template, baseOf(files[i].name), ext, {
      ...ctx,
      sequence: String(start + i).padStart(digits, "0"),
    });
    // 冲突（批内已用，或磁盘已有且非自身原名）→ 扩展名前插 _1/_2 递增（无扩展名原样追加）
    let final = candidate;
    let k = 1;
    while (used.has(final) || (existing.has(final) && final !== files[i].name)) {
      final = (ext ? candidate.slice(0, -ext.length) : candidate) + `_${k}` + ext;
      k++;
    }
    used.add(final);
    out.push(final);
  }
  return out;
}

/** 提取扩展名（含点）；无扩展名返回空串（与 path.extname 语义一致） */
export function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx) : "";
}

/** 提取主名（去掉扩展名）；无扩展名返回原名 */
export function baseOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}
