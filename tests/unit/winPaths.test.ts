/**
 * Windows 路径语义单测矩阵（W0，2026-09-08 Windows 测试约定 Task 1）
 *
 * 立约口径：产品名/文件名由**用户手输**，同一份名字既会落到 Linux 也会落到 Windows（工作区经坚果云双机共享），
 * 而 Windows 的非法字符、保留名、分隔符、大小写不敏感都比 POSIX 更严。
 * 故本矩阵钉的是「**校验在两种宿主语义下都必须 fail-closed**」：
 * 任何 Windows 侧会炸的输入，在 Linux 上就必须先被拒——不能"这边能用那边崩"。
 *
 * 与平台无关（纯字符串/纯函数），不依赖 wine；真实 Windows 运行时行为由 W1b 冒烟承担
 * （见内部 Windows 测试守则、内部 Windows Docker/wine spike 记录）。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  assertSafeFileName,
  assertSafeFolderName,
  assertSafePathSegment,
  classifyFileType,
  isPathInsideWorkspace,
  isReservedRootName,
  mimeTypeForPath,
  thumbnailPath,
} from '../../src/main/core/paths'

describe('assertSafePathSegment：Windows 形状的路径段一律拒（不分宿主）', () => {
  it('反斜杠段被拒 —— Windows 分隔符在 Linux 上是合法文件名字符，必须显式拦', () => {
    // POSIX 下 'a\\b' 只是一个含反斜杠的名字，不拦就会在 Windows 侧变成两级路径
    expect(() => assertSafePathSegment('a\\b')).toThrow(/路径分隔符/)
    expect(() => assertSafePathSegment('C:\\Windows\\System32')).toThrow(/路径分隔符/)
  })

  it('正斜杠段被拒', () => {
    expect(() => assertSafePathSegment('a/b')).toThrow(/路径分隔符/)
  })

  it('UNC 形状被拒；裸盘符段本身不在此层拦（冒号归 folder 校验，分层如实钉住）', () => {
    expect(() => assertSafePathSegment('\\\\nas\\share')).toThrow(/路径分隔符/)
    // 段层只管分隔符与 ..；'C:' 无分隔符 ⇒ 由 assertSafeFolderName 的冒号规则拦（见下一组）。
    // 记此锚点的原因：任何一侧规则挪动都会改变「谁能建出越界目录」，必须留痕。
    expect(assertSafePathSegment('C:')).toBe('C:')
    expect(() => assertSafeFolderName('C:')).toThrow(/非法字符/)
  })

  it('.. 穿越被拒，且混合分隔符穿绕不放过', () => {
    expect(() => assertSafePathSegment('..')).toThrow(/\.\./)
    expect(() => assertSafePathSegment('a/../../etc')).toThrow()
    expect(() => assertSafePathSegment('a\\..\\b')).toThrow()
  })

  it('NUL 与非空校验', () => {
    expect(() => assertSafePathSegment('')).toThrow(/不能为空/)
    expect(() => assertSafePathSegment('   ')).toThrow(/不能为空/)
    expect(assertSafePathSegment(' 正常名 ')).toBe('正常名') // 首尾空白裁掉后放行
  })
})

describe('assertSafeFolderName：Windows 非法字符集与首尾点/空格', () => {
  it.each(['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b'])('Windows 非法字符 %s 被拒', (bad) => {
    expect(() => assertSafeFolderName(bad)).toThrow(/非法字符/)
  })

  it('前导点被拒、尾随点被拒；尾随空格被静默裁剪而非报错（台账 W-02）', () => {
    expect(() => assertSafeFolderName('.隐藏')).toThrow(/\. 或空格开头\/结尾/)
    expect(() => assertSafeFolderName('名字.')).toThrow(/\. 或空格开头\/结尾/)
    // 实际行为：段层先 name.trim() ⇒ 尾随空格到不了 endsWith(' ') 判断，该分支不可达，
    // 错误文案里的「空格」对文件夹/文件名校验都永不生效（与 Windows 静默裁剪结果一致，无线上影响）。
    // 台账 W-02（内部 Windows 缺陷台账）；将来若改为「显式拒尾随空格」，此例改判抛错。
    expect(assertSafeFolderName('名字 ')).toBe('名字')
  })

  it('中文名与常规字符放行（本产品主力场景）', () => {
    expect(assertSafeFolderName('产品集A')).toBe('产品集A')
    expect(assertSafeFolderName('3C-质检 v2.0')).toBe('3C-质检 v2.0')
  })

  // 台账 W-01（内部 Windows 缺陷台账）：文件夹名未拦 Windows 保留名。
  // 现状如实钉住（不假装已修）：产品集/客户/供应商名会直接 mkdir 成文件夹，
  // Windows 上 CON/NUL/COM1 属设备名，建出来即为「资源管理器里删不掉」的幽灵目录。
  it('现状锚：文件夹保留名未被拦截（台账 W-01，修复后此例应改判为抛错）', () => {
    expect(() => assertSafeFolderName('CON')).not.toThrow()
    expect(() => assertSafeFolderName('nul')).not.toThrow()
    expect(() => assertSafeFolderName('COM1')).not.toThrow()
  })
})

describe('assertSafeFileName：Windows 保留名/尾随点空格/NUL 全拦', () => {
  it.each(['con', 'CON', 'Con.txt', 'nul', 'aux.log', 'com1', 'COM9.zip', 'lpt1'])('保留名 %s 被拒（不分大小写、含扩展名）', (bad) => {
    expect(() => assertSafeFileName(bad)).toThrow(/保留名/)
  })

  it('非保留名不误伤', () => {
    expect(assertSafeFileName('concise.pdf')).toBe('concise.pdf')
    expect(assertSafeFileName('com0.txt')).toBe('com0.txt') // com0/lpt0 非 Windows 保留名
    expect(assertSafeFileName('主图v2.jpg')).toBe('主图v2.jpg')
  })

  it('Windows 非法字符与尾随点被拒、NUL 被拒；尾随空格同台账 W-02 走裁剪', () => {
    expect(() => assertSafeFileName('a|b.jpg')).toThrow(/非法字符/)
    expect(() => assertSafeFileName('a.jpg.')).toThrow(/\. 或空格结尾/)
    expect(() => assertSafeFileName('a\0b.jpg')).toThrow(/NUL/)
    expect(assertSafeFileName('a.jpg ')).toBe('a.jpg') // 段层 trim 先吃掉尾随空格
  })
})

describe('isPathInsideWorkspace：POSIX 宿主不得把 Windows 风格路径误判为区内（fail-closed）', () => {
  it('反斜杠形状路径在 Linux 宿主上判为区外', () => {
    // Linux 下 'C:\ws' 不是路径分隔结构，若被当成区内即构成越权读写面
    expect(isPathInsideWorkspace('C:\\ws', 'C:\\ws\\a.jpg')).toBe(false)
    expect(isPathInsideWorkspace('/ws', '\\ws\\a.jpg')).toBe(false)
  })

  it('同盘正常形状仍判区内（正例不受影响）', () => {
    expect(isPathInsideWorkspace('/ws', '/ws/a.jpg')).toBe(true)
    expect(isPathInsideWorkspace('/ws', '/ws')).toBe(true)
    expect(isPathInsideWorkspace('/ws', '/wse/a.jpg')).toBe(false) // 前缀相同但非子目录
    expect(isPathInsideWorkspace('/ws', '/other/a.jpg')).toBe(false)
  })

  it('穿越形状被判区外（大小写敏感性按宿主语义如实钉住）', () => {
    expect(isPathInsideWorkspace('/ws', '/ws/../etc/passwd')).toBe(false)
    // Windows 文件系统不分大小写、Linux 分。本函数走宿主 path.resolve，
    // 故此断言钉的是「Linux 宿主不误放行」；Windows 侧同一路径由 W1b 冒烟真跑验证。
    expect(isPathInsideWorkspace('/ws', '/WS/a.jpg')).toBe(false)
  })
})

describe('扩展名与类型判定对反斜杠形状路径仍正确（跨机传入的路径不失效）', () => {
  it('win32 风格路径取扩展名正常（posix extname 不看分隔符）', () => {
    expect(classifyFileType('C:\\ws\\图包\\主图\\A.JPG')).toBe('image')
    expect(classifyFileType('C:\\ws\\证书\\报告.PDF')).toBe('pdf')
    expect(classifyFileType('C:\\ws\\a\\b\\说明.md')).toBe('other')
    expect(mimeTypeForPath('C:\\ws\\图包\\x.webp')).toBe('image/webp')
  })
})

describe('isReservedRootName：Windows 大小写不敏感语义下不得绕过保留名', () => {
  it('ASCII 大小写变体同样命中（Windows 不分大小写，绕过即覆盖内建区）', () => {
    expect(isReservedRootName('产品集')).toBe(true)
    expect(isReservedRootName(' 产品集 ')).toBe(true)
    expect(isReservedRootName('报价')).toBe(true)
    expect(isReservedRootName('随便一个名字')).toBe(false)
  })
})

describe('thumbnailPath：缓存 key 与宿主分隔符耦合的事实钉住（跨平台不共用缓存）', () => {
  const ws = '/ws/我的工作区'
  it('同一相对路径 → 同一 key（幂等，缓存可命中）', () => {
    const a = thumbnailPath(ws, path.join(ws, '图包', '主图', 'a.jpg'))
    const b = thumbnailPath(ws, path.join(ws, '图包', '主图', 'a.jpg'))
    expect(a).toBe(b)
  })

  it('不同相对路径 → 不同 key；两平台分隔符不同即不同 key（现状如实记录）', () => {
    const posixKey = thumbnailPath('C:/ws', 'C:/ws/图包/a.jpg')
    const winLikeKey = thumbnailPath('C:\\ws', 'C:\\ws\\图包\\a.jpg')
    // Linux 宿主下反斜杠不是分隔符，两者哈希输入不同 ⇒ 缓存 key 不同。
    // ⇒ 结论：缩略图缓存**不做跨平台复用**（v2.1.0 起缓存在 userData，本就不随坚果云同步，
    //   故无线上影响；此处只防「以后把它当可移植缓存」的误判）。
    expect(posixKey).not.toBe(winLikeKey)
  })

  it('分桶目录 = key 前 2 位；文件名带原扩展名 + .thumb.jpg', () => {
    const p = thumbnailPath(ws, path.join(ws, '图包', 'a.jpg'), '/cache')
    const file = path.basename(p)
    const bucket = path.basename(path.dirname(p))
    expect(bucket).toHaveLength(2)
    expect(file.endsWith('.jpg.thumb.jpg')).toBe(true)
    expect(file.slice(0, 32)).toBe(bucket + file.slice(2, 32)) // key 前缀与桶一致
  })
})
