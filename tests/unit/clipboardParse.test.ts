/**
 * 系统剪贴板文件列表解析的单测（v2.5.8 D19 / 体验批 B3）。
 *
 * B3 的链路是「读剪贴板 → 解析 → 交给既有导入管道」，中间只有这一步会吃到**外部程序**写的东西
 * （资源管理器 / Chrome / 微信 / 各桌面环境的 uri-list 写法都不完全一样），
 * 所以外部格式在这里钉死，剩下的都是自家管道。零依赖纯函数，不需要 mock electron。
 */
import { describe, expect, it } from 'vitest'
import { dedupePaths, parseFileDropList, parseUriList } from '../../src/main/clipboardParse'

describe('parseUriList（Linux：xclip / xsel / wl-paste / Electron 回退共读这一种）', () => {
  it('多行 file:// → 按原顺序出路径', () => {
    expect(parseUriList('file:///ws/a.png\nfile:///ws/b.png\n')).toEqual(['/ws/a.png', '/ws/b.png'])
  })

  it('CRLF 与行首尾空白都不影响（Windows 侧写进来的 uri-list 常带 CR）', () => {
    expect(parseUriList('file:///ws/a.png\r\n  file:///ws/b.png  \r\n')).toEqual(['/ws/a.png', '/ws/b.png'])
  })

  it('# 开头是 RFC 2483 的注释行，不是文件', () => {
    expect(parseUriList('# comment\nfile:///ws/a.png\n# 又一个注释\n')).toEqual(['/ws/a.png'])
  })

  it('中文与空格按百分号解码还原——不解码就会去导入一个叫 %E4%B8%BB 的文件', () => {
    expect(parseUriList('file:///ws/%E4%B8%BB%E5%9B%BE/a%20b.png\n')).toEqual(['/ws/主图/a b.png'])
  })

  it('非 file: 协议逐条丢弃而不是整批失败（浏览器常同时写 http 与 file）', () => {
    expect(parseUriList('https://example.com/x\nfile:///ws/a.png\nsftp://host/x\n')).toEqual(['/ws/a.png'])
  })

  it('残缺 / 非法 URI 丢弃，不抛异常', () => {
    expect(parseUriList('file://\nnot a uri\nfile://%zz\n')).toEqual([])
  })

  it('空剪贴板与全空行 → 空数组（调用方据此静默不动作）', () => {
    expect(parseUriList('')).toEqual([])
    expect(parseUriList('\n  \n\t\n')).toEqual([])
  })

  it('Windows 盘符 URI 去掉 URI 语法多出来的前导斜杠', () => {
    expect(parseUriList('file:///C:/ws/a.png\n')).toEqual(['C:/ws/a.png'])
  })
})

describe('parseFileDropList（Windows：Get-Clipboard -Format FileDropList）', () => {
  it('一行一个明文绝对路径，尾随换行不影响', () => {
    expect(parseFileDropList('C:\\ws\\a.png\nC:\\ws\\b.png\n')).toEqual(['C:\\ws\\a.png', 'C:\\ws\\b.png'])
  })

  it('UNC 路径保留', () => {
    expect(parseFileDropList('\\\\server\\share\\a.png\n')).toEqual(['\\\\server\\share\\a.png'])
  })

  it('相对路径丢弃：拼目标位置要靠猜，宁可不粘', () => {
    expect(parseFileDropList('a.png\n./b.png\nC:\\ws\\ok.png\n')).toEqual(['C:\\ws\\ok.png'])
  })

  it('个别程序写成 file: 的也顺手解码，不会把 URI 原样带进移动参数', () => {
    expect(parseFileDropList('file:///C:/ws/a.png\nC:\\ws\\b.png\n')).toEqual(['C:/ws/a.png', 'C:\\ws\\b.png'])
  })
})

describe('dedupePaths（同一文件列两遍不该导两遍）', () => {
  it('保序去重', () => {
    expect(dedupePaths(['/a', '/b', '/a', '/c', '/b'])).toEqual(['/a', '/b', '/c'])
  })
  it('空数组进空数组出', () => {
    expect(dedupePaths([])).toEqual([])
  })
})
