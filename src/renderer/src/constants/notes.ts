/**
 * 渲染层共享常量（v2.5.7 A2 笔记）：内建「笔记」子文件夹。
 * core 侧权威常量在 src/main/core/paths.ts BUILTIN_NOTES_SUBFOLDER；渲染层镜像用（不进 core）。
 * 适用挂载面 = 产品集文档区 + 客户 + 供应商文件区。
 */
export const BUILTIN_NOTES_FOLDER = "笔记";

/** 把 config 子文件夹列表与内建「笔记」取并集（去重）：渲染层子文件夹栏/删除按钮统一的唯一真相源 */
export function withBuiltinNotes(folders: string[] | undefined, fallback: string[]): string[] {
  const list = [...(folders && folders.length > 0 ? folders : fallback)].filter((f) => f !== BUILTIN_NOTES_FOLDER);
  // 用户拍板（2026-08-30）：笔记文件夹排最左（分类第一位）
  list.unshift(BUILTIN_NOTES_FOLDER);
  return list;
}

/** 默认落点（进入文件区、点入口卡、删除子文件夹后跳转时选中的那一个）。
 *  显示顺序上「笔记」在最左（用户拍板），但它**不该**当默认落点：默认落点决定客户/供应商文件区
 *  打开时看到哪个文件夹、以及「选择文件并添加」的默认导入目标，还有产品集文档卡的去向——
 *  沿用 [0] 会让普通文件默认落进「笔记」（语义错误）、文档卡从「说明书」改道（v2.5.1 F2 既有流）。
 *  故取第一个非内建笔记的子文件夹；只剩笔记时回落笔记；空列表返回空串。 */
export function defaultSubFolder(folders: string[]): string {
  if (folders.length === 0) return "";
  return folders.find((f) => f !== BUILTIN_NOTES_FOLDER) ?? BUILTIN_NOTES_FOLDER;
}
