/**
 * 拖拽拖出：从应用内拖文件到桌面/文件管理器/微信（Electron startDrag 原生文件拖拽）
 *
 * 关键：必须 preventDefault 阻止浏览器默认 HTML5 拖拽，
 * 否则 dataTransfer 里的文本（路径）会作为拖拽内容被目标应用接收——即"拖到微信变成路径文本"。
 * preventDefault 后由主进程 webContents.startDrag 发起原生文件拖拽（files 支持多文件）。
 *
 * v2.3.0 ghost 图：主进程 startDrag 时读取首文件缩略图磁盘缓存（userData/thumbs）作为拖拽图标，
 * 拖图看到图、拖多文件由系统显示叠影；非图片/无缓存时兜底 build/logo.png。渲染层零合成延迟。
 *
 * v2.3.2 内部拖拽标记：startDrag 发起的原生拖拽回落窗口内时 dataTransfer 仍携带 Files 类型，
 * 会被 GlobalDropOverlay 误判为外部文件拖入。这里用模块级标记记录拖出路径（8s 有效期），
 * 拖回窗口且 drop 路径集合与拖出路径一致时视为「取消拖出」，不触发导入、不弹遮罩。
 */
let internalDrag: { paths: string[]; ts: number } | null = null

/** 清除内部拖拽标记（系统 dragend / 拖回窗口命中 / 外部导入流程结束时调用） */
export function clearInternalDrag(): void {
  internalDrag = null
}

/** 内部拖拽是否仍在活跃期（8s 内，覆盖拖出后未立即回落窗口的情况） */
export function isInternalDragActive(): boolean {
  return internalDrag !== null && Date.now() - internalDrag.ts < 8000
}

/** 活跃期内的拖出路径集合（拷贝，避免外部改动内部状态）；非活跃返回空数组 */
export function getInternalDragPaths(): string[] {
  return internalDrag !== null && Date.now() - internalDrag.ts < 8000 ? [...internalDrag.paths] : []
}

export function handleDragOut(e: DragEvent, filePath: string, selectedPaths: string[]): void {
  const paths = selectedPaths.includes(filePath) && selectedPaths.length > 0 ? selectedPaths : [filePath]

  // 模块级标记：记录本次拖出路径，供 GlobalDropOverlay 判定「拖回窗口」场景
  internalDrag = { paths, ts: Date.now() }
  // 系统拖拽结束（拖到外部目标成功）若派发 dragend 即清除标记
  window.addEventListener('dragend', clearInternalDrag, { once: true })

  // 阻止 HTML5 默认拖拽：防止文本数据被当作拖拽内容（微信收到路径文本的根因）
  e.preventDefault()
  // 仍提供 URI 提示（部分平台/目标需要），实际文件传输由 startDrag 接管
  e.dataTransfer?.setData('text/uri-list', paths.join('\n'))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'

  // 主进程 webContents.startDrag 发起原生文件拖拽（ghost 图标由主进程取缩略图缓存）
  void window.qihebox.files.startDrag(paths)
}
