/**
 * 文件服务协议 qihebox://（对照原 Go workspace_file_handler.go AssetServer Handler）
 * - 格式：qihebox://file/<base64url(绝对路径)>
 * - 仅 GET；base64 解码后强制工作区前缀校验；流式响应，视频/PDF 支持 Range
 * 注册时机：主进程 app.whenReady 后调用 registerQiheboxProtocol(box)
 */
import { protocol, net } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { BoxService } from './core'

export function workspaceFileUrl(filePath: string): string {
  const encoded = Buffer.from(filePath, 'utf-8').toString('base64url')
  return `qihebox://file/${encoded}`
}

export function registerQiheboxProtocol(box: BoxService): void {
  protocol.handle('qihebox', async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 })
    }
    if (url.hostname !== 'file') {
      return new Response('bad request', { status: 400 })
    }
    const encoded = decodeURIComponent(url.pathname.slice(1))
    let filePath: string
    try {
      filePath = Buffer.from(encoded, 'base64url').toString('utf-8')
    } catch {
      return new Response('invalid file parameter', { status: 400 })
    }
    filePath = filePath.trim()
    if (!filePath) return new Response('missing file parameter', { status: 400 })

    const ws = box.workspace.currentWorkspacePath()
    if (!ws) return new Response('no workspace open', { status: 503 })

    // 工作区前缀校验（对照原 HasPrefix 逻辑）
    const resolved = path.resolve(filePath)
    const wsResolved = path.resolve(ws)
    if (resolved !== wsResolved && !resolved.startsWith(wsResolved + path.sep)) {
      return new Response('file outside workspace', { status: 403 })
    }

    // 校验文件存在
    try {
      await fsp.stat(resolved)
    } catch {
      return new Response('file not found', { status: 404 })
    }

    // 流式返回（net.fetch 对 file:// 保留 Range 支持）
    try {
      return await net.fetch(pathToFileURL(resolved).toString(), {
        headers: request.headers,
      })
    } catch {
      return new Response('read failed', { status: 500 })
    }
  })
}
