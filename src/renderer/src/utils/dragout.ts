/**
 * 拖拽拖出：从应用内拖文件到桌面/文件管理器/微信（Electron startDrag 原生文件拖拽）
 *
 * 关键：必须 preventDefault 阻止浏览器默认 HTML5 拖拽，
 * 否则 dataTransfer 里的文本（路径）会作为拖拽内容被目标应用接收——即"拖到微信变成路径文本"。
 * preventDefault 后由主进程 webContents.startDrag 发起原生文件拖拽（files 支持多文件）。
 *
 * v2.3.0 ghost 图：主进程 startDrag 时读取首文件缩略图磁盘缓存（userData/thumbs）作为拖拽图标，
 * 拖图看到图、拖多文件由系统显示叠影；非图片/无缓存时兜底 build/logo.png。渲染层零合成延迟。
 */
export function handleDragOut(e: DragEvent, filePath: string, selectedPaths: string[]): void {
  const paths = selectedPaths.includes(filePath) && selectedPaths.length > 0 ? selectedPaths : [filePath]

  // 阻止 HTML5 默认拖拽：防止文本数据被当作拖拽内容（微信收到路径文本的根因）
  e.preventDefault()
  // 仍提供 URI 提示（部分平台/目标需要），实际文件传输由 startDrag 接管
  e.dataTransfer?.setData('text/uri-list', paths.join('\n'))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'

  // 主进程 webContents.startDrag 发起原生文件拖拽（ghost 图标由主进程取缩略图缓存）
  void window.qihebox.files.startDrag(paths)
}
