/**
 * 拖拽拖出：从应用内拖文件到桌面/文件管理器/微信（Electron startDrag 原生文件拖拽）
 * - 单选：拖当前文件；多选：该文件在选中列表时拖全部选中项
 */
export function handleDragOut(e: DragEvent, filePath: string, selectedPaths: string[]): void {
  const paths = selectedPaths.includes(filePath) && selectedPaths.length > 0 ? selectedPaths : [filePath]
  // 设置数据防止浏览器默认行为（打开文件），并给拖拽会话提供提示
  e.dataTransfer?.setData('text/uri-list', paths.join('\n'))
  e.dataTransfer?.setData('text/plain', paths.join('\n'))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  // 主进程 webContents.startDrag 发起原生拖拽（files 支持多文件）
  void window.qihebox.files.startDrag(paths)
}
