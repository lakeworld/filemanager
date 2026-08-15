import { describe, it, expect } from 'vitest'
import { escapeHtml, sanitizeLinkHref, configureMarked } from '../../src/shared/mdRender'

describe('md 渲染安全（v2.5.1 F4，D21：禁原生 HTML）', () => {
  it('escapeHtml 转义五字符', () => {
    expect(escapeHtml(`<script>alert("x")&'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;',
    )
  })

  it('configureMarked 后：HTML 注入被转义为文本，不产生可执行节点', async () => {
    const { marked } = await import('marked')
    configureMarked(marked)
    const out = await marked.parse('# 标题\n\n<script>alert(1)</script>\n\n正文')
    // 输出中不得出现真实 <script> 标签（转义后为 &lt;script&gt;）
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    // 正常 markdown 结构不受影响
    expect(out).toContain('<h1>标题</h1>')
    expect(out).toContain('<p>正文</p>')
  })

  it('sanitizeLinkHref：http/https/qihebox/相对放行；javascript:/data:/ftp: 拒绝', () => {
    expect(sanitizeLinkHref('https://a.com/x')).toBe('https://a.com/x')
    expect(sanitizeLinkHref('http://a.com/x')).toBe('http://a.com/x')
    expect(sanitizeLinkHref('qihebox://file/abc')).toBe('qihebox://file/abc')
    expect(sanitizeLinkHref('../a.md')).toBe('../a.md')
    expect(sanitizeLinkHref('/abs/a.md')).toBe('/abs/a.md')
    expect(sanitizeLinkHref('javascript:alert(1)')).toBe('')
    expect(sanitizeLinkHref('data:text/html,x')).toBe('')
    expect(sanitizeLinkHref('ftp://x')).toBe('')
    expect(sanitizeLinkHref('')).toBe('')
  })
})
