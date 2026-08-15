import { describe, it, expect } from 'vitest'
import { getPreviewKind, isMarkdownName } from '../../src/shared/fileKind'

describe('getPreviewKind（v2.5.1 F3：双击/预览分流判定）', () => {
  it('image/video/pdf 按 file_type 直接映射', () => {
    expect(getPreviewKind({ name: 'a.jpg', file_type: 'image' })).toBe('image')
    expect(getPreviewKind({ name: 'b.mp4', file_type: 'video' })).toBe('video')
    expect(getPreviewKind({ name: 'c.pdf', file_type: 'pdf' })).toBe('pdf')
  })

  it('md 扩展名（file_type=other）→ md；其余 other → other（默认应用打开）', () => {
    expect(getPreviewKind({ name: '说明.md', file_type: 'other' })).toBe('md')
    expect(getPreviewKind({ name: 'readme.MARKDOWN', file_type: 'other' })).toBe('md')
    expect(getPreviewKind({ name: '规格表.xlsx', file_type: 'other' })).toBe('other')
    expect(getPreviewKind({ name: '文档.docx', file_type: 'other' })).toBe('other')
    expect(getPreviewKind({ name: '包.zip', file_type: 'other' })).toBe('other')
    expect(getPreviewKind({ name: '.md', file_type: 'other' })).toBe('other') // 隐藏文件
  })

  it('未知 file_type 兜底 other', () => {
    expect(getPreviewKind({ name: 'x.bin', file_type: 'unknown' })).toBe('other')
  })
})

describe('isMarkdownName（shared 双端共用实现，F1 re-export 一致性）', () => {
  it('识别 .md/.markdown（含大写），拒绝其他', () => {
    expect(isMarkdownName('说明.md')).toBe(true)
    expect(isMarkdownName('说明.MD')).toBe(true)
    expect(isMarkdownName('readme.markdown')).toBe(true)
    expect(isMarkdownName('README.MARKDOWN')).toBe(true)
    expect(isMarkdownName('规格表.xlsx')).toBe(false)
    expect(isMarkdownName('README')).toBe(false)
    expect(isMarkdownName('.md')).toBe(false)
    expect(isMarkdownName('file.')).toBe(false)
  })
})
