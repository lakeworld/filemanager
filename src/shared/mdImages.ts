/**
 * MD 内嵌图片地址解析（v2.5.1 F4，D22；双端共用纯函数）：
 * - http(s):// 直链原样返回（CSP img-src 若拦截，实现时验证记偏差）
 * - 相对路径（./x、x、../x）→ 基于 md 文件所在目录 POSIX 规范化 → 工作区绝对路径 → qihebox://file/<base64url>
 * - 异常（越界 ../、空、data:）→ ''（渲染忽略该图片）
 * 说明：协议层（main/protocol.ts）负责工作区白名单校验，渲染层只做 URL 构造；
 * base64url 用全局 btoa + TextEncoder（Node 18+/浏览器均可用，避免引入依赖）。
 */

/** POSIX 目录名（md 内路径用 / 分隔；Windows 绝对路径先转 / 再处理） */
export function dirnamePosix(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '/' : normalized.slice(0, idx)
}

/** POSIX 路径规范化（处理 ./ 与 ../；越界返回 null；绝对路径保留前导 /） */
export function normalizePosix(p: string): string | null {
  const isAbsolute = p.startsWith('/')
  const parts = p.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null // 越界（逃出 md 所在目录链）
      out.pop()
      continue
    }
    out.push(part)
  }
  if (out.length === 0) return null
  return (isAbsolute ? '/' : '') + out.join('/')
}

/** 工作区文件协议 URL：qihebox://file/<base64url(绝对路径)>（对齐 main/protocol.ts workspaceFileUrl） */
export function qiheboxFileUrl(absPath: string): string {
  const bytes = new TextEncoder().encode(absPath)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `qihebox://file/${b64}`
}

/** MD 内嵌图片地址解析（见文件头注释） */
export function resolveMdImageUrl(mdFilePath: string, href: string): string {
  if (!href || href.startsWith('data:')) return ''
  if (/^https?:\/\//i.test(href)) return href
  // 绝对路径（/ 开头或 Windows 盘符）优先于协议正则（盘符形如 C:\ 会被误判为协议）
  const abs = href.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(href)
  if (!abs && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return '' // 其他协议（ftp: 等）忽略
  const resolved = abs ? href.replace(/\\/g, '/') : normalizePosix(`${dirnamePosix(mdFilePath)}/${href}`)
  if (!resolved) return ''
  return qiheboxFileUrl(resolved)
}
