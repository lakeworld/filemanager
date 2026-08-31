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
 * - v2.5（PLAN §4.3）：qihebox://plugin/<id>/<relpath>——从 userData/plugins/<id>/pkg/ 流式提供
 *   插件渲染层产物（渲染层经 import() 动态加载页面模块，组件 = 模块默认导出）；
 *   与工作区无关（userData 级），同款防护：id 域名倒序 + relPath 拒绝 '..'/空段 + realpath 前缀比对
 * 注册时机：主进程 app.whenReady 后调用 registerQiheboxProtocol(box, getThumbsRoot?, getPluginsRoot?)
 */
import { protocol, net, app } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import { BoxService } from './core'
import { mimeTypeForPath } from './core/paths'
import { log } from './log'
import { getPluginKey, decryptEnc } from './plugins/encryption'
import type { KeyDeps, SecretStore } from './plugins/encryption'
import type { PluginManifest } from '../plugins/types'

export function workspaceFileUrl(filePath: string): string {
  const encoded = Buffer.from(filePath, 'utf-8').toString('base64url')
  return `qihebox://file/${encoded}`
}

/** 缩略图 URL（v2.1.0）：缩略图缓存位于 userData，不走工作区前缀校验，独立 thumb host */
export function thumbnailFileUrl(thumbPath: string): string {
  const encoded = Buffer.from(thumbPath, 'utf-8').toString('base64url')
  return `qihebox://thumb/${encoded}`
}

/** 外部文件 URL（v2.5.5 打磨 2）：批量识别选任意系统文件夹时预览——
 *  qihebox://ext/<base64url(绝对路径)>，与工作区无关：realpath 存在即放行（用户主动选择预览的文件） */
export function externalFileUrl(filePath: string): string {
  const encoded = Buffer.from(filePath, 'utf-8').toString('base64url')
  return `qihebox://ext/${encoded}`
}

// —— v2.5（PLAN §4.3）：插件包内资源 URL（qihebox://plugin/<id>/<relpath>）——

/** 插件 id 格式：域名倒序（与 src/plugins/types.ts ID_RE 同源，不跨模块引用保持 protocol 自治） */
const PLUGIN_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/

/** decodeURIComponent 的安全包装：非法百分号编码 → 空串（由调用方判定拒绝） */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return ''
  }
}

/**
 * 插件包内资源 URL：qihebox://plugin/<id>/<relpath>（渲染层 routes 动态 import 用）。
 * relPath 逐段 encodeURIComponent（含空格/中文的产物文件名安全）；id 为域名倒序，直接拼入。
 */
export function pluginFileUrl(id: string, relPath: string): string {
  const safe = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
  return `qihebox://plugin/${id}/${safe}`
}

/**
 * 解析插件 URL pathname（形如 /<id>/<relpath> 的原始编码段）：
 * - id 须为域名倒序（拒绝 '..'/'/'/大小写等一切逃逸形态）
 * - relPath 逐段解码后拒绝空段 / '.' / '..'（防 %2e%2e 编码逃逸；URL 层折叠的 '..' 亦在此被拒）
 * 非法 → null（handler 返回 400）。注意：反斜杠不在段校验范围——Windows 分隔符语义的逃逸
 * 由 resolvePluginAsset 的 realpath 前缀比对兜底（与 file/thumb 同款 D7 防护）。
 */
export function parsePluginUrl(rawPathname: string): { id: string; relPath: string } | null {
  if (!rawPathname.startsWith('/')) return null
  const segments = rawPathname.slice(1).split('/')
  const id = safeDecode(segments[0] ?? '')
  if (!PLUGIN_ID_RE.test(id)) return null
  const relParts: string[] = []
  for (let i = 1; i < segments.length; i++) {
    const seg = safeDecode(segments[i])
    if (seg === '' || seg === '.' || seg === '..') return null
    relParts.push(seg)
  }
  if (relParts.length === 0) return null
  return { id, relPath: relParts.join('/') }
}

/**
 * 解析插件包内资源到磁盘绝对路径（防符号链接逃逸，与 file/thumb 同款 realpath 前缀比对）：
 * pkg 根与目标均 realpath 解析，目标必须在 pkg 根之内；文件/目录不存在 → null。
 * 纯 node 实现（不依赖 electron），可直接单测。
 */
export async function resolvePluginAsset(pkgRoot: string, relPath: string): Promise<string | null> {
  const target = path.resolve(pkgRoot, relPath)
  const [rootReal, targetReal] = await Promise.all([
    fsp.realpath(pkgRoot).catch(() => null),
    fsp.realpath(target).catch(() => null),
  ])
  if (!rootReal || !targetReal) return null
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) return null
  return targetReal
}

/** 插件安装根（缺省）：userData/plugins（与 installer 落盘位置一致，见 PLAN §4.2） */
function pluginsRootFallback(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

/**
 * v2.5 协议承诺（PLUGIN.md §六 规则 5）：插件页面模块纳入 CSP 管辖。
 * 仅 qihebox://plugin/<id>/... 响应附加此头；file/thumb（本体文件预览/缩略图）不加，保持现状。
 * - script-src 'self'：插件脚本/模块仅允许来自插件包自身，禁内联脚本与外部域（有意义的限制）
 * - style-src 'self' 'unsafe-inline'：hello 示例经 h() 用内联 style 属性，须放行内联样式
 * - img-src 'self' data:：插件包内图片 + data: URI（图标/内联图）
 * - connect-src 'self'：fetch/XHR 默认仅同源（IPC 走 contextBridge 不经 connect-src，不受影响）
 */
const PLUGIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ')

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

/** 取钥防调包：本地密文文件 sha256（hex）。读取失败 → 空串。 */
async function sha256Hex(file: string): Promise<string> {
  try {
    const b = await fsp.readFile(file)
    return crypto.createHash('sha256').update(b).digest('hex')
  } catch {
    return ''
  }
}

export function registerQiheboxProtocol(
  box: BoxService,
  getThumbsRoot?: () => string,
  getPluginsRoot?: () => string,
  // v2.5.7（F5b）：官方加密插件渲染层解密。装配层注入取钥依赖 + 插件 manifest 读取。
  encryptionDeps?: Omit<KeyDeps, 'log'> & {
    readManifest: (pluginId: string) => PluginManifest | null
  },
): void {
  protocol.handle('qihebox', async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 })
      }
      if (url.hostname !== 'file' && url.hostname !== 'thumb' && url.hostname !== 'plugin' && url.hostname !== 'ext') {
        void log('error', `[protocol] bad host: ${url.hostname} ${request.url}`)
        return new Response('bad request', { status: 400 })
      }

      // v2.5（PLAN §4.3）：插件包内资源——qihebox://plugin/<id>/<relpath>，从 userData/plugins/<id>/pkg/ 提供。
      // 与工作区无关（userData 级，PLAN §六.3），复用流式 + Range 体系（v2.4.7 F7 流式语义，不带回旧 1MB 截断）；
      // no-store：插件重装/更新后立即生效，不命中浏览器旧缓存（模块小、本地磁盘，缓存收益低）
      if (url.hostname === 'plugin') {
        const parsed = parsePluginUrl(url.pathname)
        if (!parsed) {
          void log('error', `[protocol] bad plugin url: ${request.url}`)
          return new Response('invalid plugin url', { status: 400 })
        }
        const pkgRoot = path.join(getPluginsRoot?.() ?? pluginsRootFallback(), parsed.id, 'pkg')
        // v2.5.7（F5b）：加密官方插件渲染层——manifest.encryption 存在时对 JS 模块走内存解密
        // （明文不落盘）；CSS/JSON/HTML 等 assets 保持明文（第三方运行时 assets 不在加密范围，PLAN F5 §72）。
        if (encryptionDeps && /\.js$/i.test(parsed.relPath)) {
          const manifest = encryptionDeps.readManifest(parsed.id)
          if (manifest?.encryption) {
            const encAsset = await resolvePluginAsset(pkgRoot, parsed.relPath + '.enc')
            if (encAsset) {
              const keyHex = await getPluginKey(
                {
                  baseUrl: encryptionDeps.baseUrl,
                  getToken: encryptionDeps.getToken,
                  cacheDir: encryptionDeps.cacheDir,
                  secretStore: encryptionDeps.secretStore,
                  log: (lv, m) => void log(lv, m),
                },
                manifest,
                await sha256Hex(encAsset),
              )
              if (keyHex) {
                const encBuf = await fsp.readFile(encAsset).catch(() => null)
                const dec = encBuf ? decryptEnc(encBuf, keyHex) : null
                if (dec) {
                  const headers: Record<string, string> = {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store',
                    'Content-Security-Policy': PLUGIN_CSP,
                    'Content-Type': 'text/javascript; charset=utf-8',
                    'Content-Length': String(dec.length),
                  }
                  return new Response(new Uint8Array(dec), { status: 200, headers })
                }
              }
            }
            // 取钥失败/解密失败：不静默回退明文（明文不存在会 404）——fail-closed
            void log('error', `[protocol] 加密插件渲染层解密失败或密钥不可用（${parsed.id}）`)
          }
        }
        const resolved = await resolvePluginAsset(pkgRoot, parsed.relPath)
        if (!resolved) {
          void log('error', `[protocol] plugin asset not found or outside package: ${request.url}`)
          // 统一 404（不区分「不存在」与「逃逸被拒」，不泄露包外存在性）
          return new Response('plugin asset not found', { status: 404 })
        }
        return serveFile(resolved, request, { 'Cache-Control': 'no-store', 'Content-Security-Policy': PLUGIN_CSP })
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

      // v2.5.5（打磨 2）：外部文件 host——realpath 存在即放行（批量识别任意系统文件夹预览；
      // 与工作区无关，base64url 编码 + realpath 校验仍防逃逸形态，仅服务用户主动选择的路径）
      const resolved = path.resolve(filePath)
      const targetReal = await fsp.realpath(resolved).catch(() => null)
      if (!targetReal) return new Response('file not found', { status: 404 })
      if (url.hostname === 'ext') {
        return serveFile(targetReal, request, undefined)
      }

      const ws = box.workspace.currentWorkspacePath()
      if (!ws) return new Response('no workspace open', { status: 503 })

      // v2.4.2（D7）：realpath 解析后再做前缀比对（防符号链接/junction 逃逸到工作区外）；
      // 文件不存在 realpath 返回 null → 404。file → 工作区；thumb → 缩略图缓存根（userData）
      const boundary = url.hostname === 'file' ? ws : (getThumbsRoot?.() ?? '')
      if (!boundary) return new Response('no thumb cache root', { status: 503 })
      const boundaryReal = await fsp.realpath(boundary).catch(() => null)
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
