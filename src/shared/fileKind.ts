/**
 * 文件类型判定（v2.5.1 F3/F4，双端共用纯函数）：
 * - isMarkdownName：Markdown 扩展名判定（.md/.markdown，隐藏文件除外）
 * - getPreviewKind：预览分流——可内嵌预览（image/video/pdf/md）vs 需默认应用打开（other）
 * 说明：md 文件的 classifyFileType 仍为 'other'（shared types 枚举零改动，D21），
 * 预览分流在渲染层按扩展名判断，此处为唯一判定源。
 */

/** Markdown 扩展名判定（core classifyFileType 之外的文件名级判断） */
export function isMarkdownName(name: string): boolean {
  if (name.startsWith('.')) return false
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}

export type PreviewKind = 'image' | 'video' | 'pdf' | 'md' | 'other'

/** 双击/预览分流判定（F3）：可内嵌预览 → 对应 kind；其余 → 'other'（默认应用打开） */
export function getPreviewKind(file: { name: string; file_type: string }): PreviewKind {
  const t = file.file_type
  if (t === 'image') return 'image'
  if (t === 'video') return 'video'
  if (t === 'pdf') return 'pdf'
  if (t === 'other' && isMarkdownName(file.name)) return 'md'
  return 'other'
}
