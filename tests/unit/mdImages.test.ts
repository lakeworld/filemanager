import { describe, it, expect } from 'vitest'
import { resolveMdImageUrl, dirnamePosix, normalizePosix, qiheboxFileUrl } from '../../src/shared/mdImages'

describe('MD 图片路径解析（v2.5.1 F4，D22）', () => {
  const MD = '/ws/产品集/系列A/文档/说明书/说明.md'

  it('http(s) 直链原样返回', () => {
    expect(resolveMdImageUrl(MD, 'https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(resolveMdImageUrl(MD, 'http://img.local/b.jpg')).toBe('http://img.local/b.jpg')
  })

  it('相对路径 → qihebox://file/<base64url 绝对路径>', () => {
    const url = resolveMdImageUrl(MD, './img/a.png')
    expect(url).toMatch(/^qihebox:\/\/file\//)
    // 解码还原绝对路径
    const encoded = url.slice('qihebox://file/'.length)
    const bin = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe('/ws/产品集/系列A/文档/说明书/img/a.png')
  })

  it('上级相对路径 ../ 正常解析；越界返回空串', () => {
    expect(resolveMdImageUrl(MD, '../图包/主图/x.png')).toBe(
      qiheboxFileUrl('/ws/产品集/系列A/文档/图包/主图/x.png'),
    )
    // md 目录深度 5（/ws/产品集/系列A/文档/说明书）→ 6 个 .. 才越出根（5 个弹净后第 6 个遇空）
    expect(resolveMdImageUrl(MD, '../../../../../../逃出.png')).toBe('')
    expect(resolveMdImageUrl(MD, '../../../../../逃出.png')).toBe(qiheboxFileUrl('/逃出.png'))
  })

  it('绝对路径（/ 或 Windows 盘符）直接编码；其他协议忽略', () => {
    expect(resolveMdImageUrl(MD, '/ws/产品集/系列A/文档/说明书/x.png')).toBe(
      qiheboxFileUrl('/ws/产品集/系列A/文档/说明书/x.png'),
    )
    expect(resolveMdImageUrl(MD, 'C:\\ws\\a.png')).toBe(qiheboxFileUrl('C:/ws/a.png'))
    expect(resolveMdImageUrl(MD, 'ftp://x/a.png')).toBe('')
    expect(resolveMdImageUrl(MD, 'data:image/png;base64,xx')).toBe('')
    expect(resolveMdImageUrl(MD, '')).toBe('')
  })

  it('dirnamePosix / normalizePosix 边界', () => {
    expect(dirnamePosix('/a/b/c.md')).toBe('/a/b')
    expect(dirnamePosix('C:\\ws\\doc\\a.md')).toBe('C:/ws/doc')
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c')
    expect(normalizePosix('/a/../../..')).toBeNull()
  })
})
