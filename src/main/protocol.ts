/**
 * 文件服务协议 qihebox://（对照原 Go workspace_file_handler.go AssetServer Handler）
 * - 格式：qihebox://file/<base64url(绝对路径)>
 * - 仅 GET；base64 解码后强制工作区前缀校验
 * - v2.4.2（P1-P2）：Range/206 手写实现（旧实现 net.fetch(file://) 透传 Range 只回部分字节
 *   但 status=200、无 Content-Range/Accept-Ranges，<video> 依赖 206 才能 seek）
 * - v2.4.7（F7）：Range 一律流式完整返回请求区间，移除 1MB 截断——
 *   Chromium 媒体加载器把开放区间 bytes=N- 的截断 206 视为「读到流尾」，
 *   大视频（moov 在文件尾部）只拿到 1MB 数据即放弃，报 MEDIA_ERR_SRC_NOT_SUPPORTED。
 *   修复后 bytes=N- 流式返回 N..EOF，与 http 服务器语义一致。
 * 注册时机：主进程 app.whenReady 后调用 registerQiheboxProtocol(box)
 */
import { protocol, net } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { BoxService } from './core'
import { mimeTypeForPath } from './core/paths'
import { log } from './log'

export function workspaceFileUrl(filePath: string): string {
  const encoded = Buffer.from(filePath, 'utf-8').toString('base64url')
  return `qihebox://file/${encoded}`
}

/** 缩略图 URL（v2.1.0）：缩略图缓存位于 userData，不走工作区前缀校验，独立 thumb host */
export function thumbnailFileUrl(thumbPath: string): string {
  const encoded = Buffer.from(thumbPath, 'utf-8').toString('base64url')
  return `qihebox://thumb/${encoded}`
}

/** v2.4.2（P1-P2）：服务本地文件，支持单区间 Range → 206。无 Range → 整文件流式（net.fetch） */
async function serveFile(resolved: string, request: Request, extraHeaders?: Record<string, string>): Promise<Response> {
  const stat = await fsp.stat(resolved)
  const size = stat.size
  const mime = mimeTypeForPath(resolved)
  const rangeHeader = request.headers.get('range')
  const baseHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    ...extraHeaders,
  }

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (m) {
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      if (start === null) {
        // 后缀区间 bytes=-N：取最后 N 字节
        start = Math.max(0, size - (end ?? 0))
        end = size - 1
      } else {
        // 开放区间 bytes=N-：完整返回 N..EOF（Chromium 媒体加载器依赖读到流尾；
        // 截断 206 会被当作「数据源结束」，moov 尾部的视频直接加载失败）
        if (end === null) end = size - 1
        end = Math.min(end, size - 1)
      }
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } })
      }
      // v2.4.7：流式完整返回请求区间（createReadStream 自动分块，避免大 Buffer 一次性分配）
      const rangeStream = fs.createReadStream(resolved, { start, end })
      rangeStream.on('error', (e) => {
        // 客户端中途断开（seek 后 Chromium 可能取消旧流）或 IO 错——记录后吞掉，防止 unhandled 'error'
        void log('warn', `[protocol] range 流错误: ${String(e)}`)
      })
      return new Response(Readable.toWeb(rangeStream) as unknown as BodyInit, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }
  }

  // 无 Range → 整文件流式（net.fetch 流式响应，天然背压）
  const resp = await net.fetch(pathToFileURL(resolved).toString())
  const headers = new Headers(resp.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
  for (const [k, v] of Object.entries(extraHeaders ?? {})) headers.set(k, v)
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}

export function registerQiheboxProtocol(
  box: BoxService,
  getThumbsRoot?: () => string,
): void {
  protocol.handle('qihebox', async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 })
      }
      if (url.hostname !== 'file' && url.hostname !== 'thumb') {
        void log('error', `[protocol] bad host: ${url.hostname} ${request.url}`)
        return new Response('bad request', { status: 400 })
      }
      const encoded = decodeURIComponent(url.pathname.slice(1))
      let filePath: string
      try {
        filePath = Buffer.from(encoded, 'base64url').toString('utf-8')
      } catch {
        void log('error', `[protocol] bad base64: ${encoded}`)
        return new Response('invalid file parameter', { status: 400 })
      }
      filePath = filePath.trim()
      if (!filePath) return new Response('missing file parameter', { status: 400 })

      const ws = box.workspace.currentWorkspacePath()
      if (!ws) return new Response('no workspace open', { status: 503 })

      // v2.4.2（D7）：realpath 解析后再做前缀比对（防符号链接/junction 逃逸到工作区外）；
      // 文件不存在 realpath 返回 null → 404。file → 工作区；thumb → 缩略图缓存根（userData）
      const resolved = path.resolve(filePath)
      const boundary = url.hostname === 'file' ? ws : (getThumbsRoot?.() ?? '')
      if (!boundary) return new Response('no thumb cache root', { status: 503 })
      const [boundaryReal, targetReal] = await Promise.all([
        fsp.realpath(boundary).catch(() => null),
        fsp.realpath(resolved).catch(() => null),
      ])
      if (!targetReal) return new Response('file not found', { status: 404 })
      if (!boundaryReal || (targetReal !== boundaryReal && !targetReal.startsWith(boundaryReal + path.sep))) {
        void log('error', `[protocol] outside workspace: ${resolved}`)
        return new Response('file outside workspace', { status: 403 })
      }

      // v2.4.2（修复 4）：缩略图路径稳定、新鲜度由主进程按源图 mtime 管理 → 长缓存，回切秒显
      const extra = url.hostname === 'thumb' ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : undefined
      return serveFile(targetReal, request, extra)
    } catch (err) {
      void log('error', `[protocol] handler error: ${request.url} ${String(err)}`)
      return new Response('internal error', { status: 500 })
    }
  })
}
