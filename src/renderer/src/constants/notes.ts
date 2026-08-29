/**
 * 渲染层共享常量（v2.5.7 A2 笔记）：内建「笔记」子文件夹。
 * core 侧权威常量在 src/main/core/paths.ts BUILTIN_NOTES_SUBFOLDER；渲染层镜像用（不进 core）。
 * 适用挂载面 = 产品集文档区 + 客户 + 供应商文件区。
 */
export const BUILTIN_NOTES_FOLDER = "笔记";

/** 把 config 子文件夹列表与内建「笔记」取并集（去重）：渲染层子文件夹栏/删除按钮统一的唯一真相源 */
export function withBuiltinNotes(folders: string[] | undefined, fallback: string[]): string[] {
  const list = [...(folders && folders.length > 0 ? folders : fallback)];
  if (!list.includes(BUILTIN_NOTES_FOLDER)) list.push(BUILTIN_NOTES_FOLDER);
  return list;
}
