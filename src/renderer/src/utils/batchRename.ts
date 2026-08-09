import type { FileEntry } from "../types";

/**
 * 批量重命名目标名生成（v2.3.3 P2，纯函数便于单测）。
 * 规则：`{前缀}_{序号}{扩展名}`，序号补零位数按「起始序号 + 数量」自适应；
 * 目标名与批内其它目标名 / 磁盘已有文件名冲突时（自身原名除外），
 * 参照后端 resolveConflictName 语义追加 `_1`、`_2` 递增，保证每个目标名唯一。
 * 应用阶段由前端逐个调用 api.files.rename，后端仅做最终兜底校验。
 */
export function batchRenameTargets(files: FileEntry[], prefix: string, start: number): string[] {
  const pfx = prefix.trim() || "未命名";
  const digits = Math.max(1, String(start + files.length - 1).length);
  // 磁盘上现有文件名（含其它选中文件的原名）：目标名与其冲突时需绕行
  const existing = new Set(files.map((f) => f.name));
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const ext = extOf(files[i].name);
    const bare = `${pfx}_${String(start + i).padStart(digits, "0")}`;
    let candidate = bare + ext;
    // 冲突（批内已用，或磁盘已有且非自身原名）→ 追加 _1/_2 递增
    let k = 1;
    while (used.has(candidate) || (existing.has(candidate) && candidate !== files[i].name)) {
      candidate = `${bare}_${k}${ext}`;
      k++;
    }
    used.add(candidate);
    out.push(candidate);
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
