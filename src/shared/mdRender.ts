/**
 * MD 渲染安全配置（v2.5.1 F4，D21：禁原生 HTML，免 DOMPurify；双端共用纯函数）
 * - configureMarked：marked.use 禁 HTML（renderer.html 转义输出）——组件动态 import('marked') 后调用，
 *   本模块仅 type-only import marked 类型，不触发运行时加载（保懒加载）
 * - escapeHtml / sanitizeLinkHref：渲染后 DOM 处理的转义与链接白名单
 */
import type { marked, Tokens } from 'marked'
/** HTML 转义（& < > " '），用于禁 HTML 后的原文显示与属性安全 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 链接 href 白名单（D21 安全面）：http/https/qihebox 协议与相对路径放行；其余（javascript: 等）返回空（移除链接）。
 * 相对路径保留原样（由调用方按需解析为 qihebox://）。
 */
export function sanitizeLinkHref(href: string): string {
  if (!href) return ''
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('qihebox://')) return href
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return '' // javascript:/ftp:/data: 等一律拒绝
  if (href.startsWith('/')) return href
  return href // 相对路径
}

/** 禁原生 HTML：marked.use 配置（组件在动态 import('marked') 后调用；测试直测本函数锁定行为）
 *  marked 18 renderer.html 签名：(token: Tokens.HTML | Tokens.Tag) => string | false */
export function configureMarked(markedInstance: typeof marked): void {
  markedInstance.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string | false {
        // 原文转义显示（不渲染、不丢弃——用户可见 HTML 源码文本）
        return escapeHtml(token.text ?? '')
      },
    },
  })
}
