/**
 * 压缩分享 / 解压单测（v2.4.4）：
 * - 往返：目录结构 + 内容逐字节一致；解压 here / folder 两种模式
 * - 安全：zip-slip（.. 逃逸 / 绝对路径）条目被跳过、产物不落盘
 * - 编码：非 UTF-8（GBK）条目名正确解码
 * - 冲突：重复解压自动加 _1 序号
 * - 取消：压缩取消 → ArchiveService 清理半成品包
 * - 校验：数据字节被篡改 → CRC 失败且不残留目标文件
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { compressToZip, extractZip, suggestZipName } from '../../src/main/core/archive'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-archive-'))
}

const SAMPLE = Buffer.from('你好，启禾文件管理 v2.4.4 compressed sample content\n')

/** CRC32（与 core/archive.ts 同算法，测试用） */
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** 手工构造 store 法 zip（条目名可传原始字节，用于 GBK/zip-slip 场景） */
function buildStoreZip(entries: { name: Buffer; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const u16 = (v: number) => {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v)
    return b
  }
  const u32 = (v: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    return b
  }
  for (const e of entries) {
    const isDir = e.name[e.name.length - 1] === 0x2f
    const size = isDir ? 0 : e.data.length
    const crc = isDir ? 0 : crc32(e.data)
    chunks.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        u16(20),
        u16(0), // 无 UTF-8 标记（GBK 场景）
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(e.name.length),
        u16(0),
        e.name,
      ]),
    )
    if (!isDir) chunks.push(e.data)
    central.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(e.name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        e.name,
      ]),
    )
    offset += 30 + e.name.length + size
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...chunks, cd, eocd])
}

describe('压缩分享 / 解压（v2.4.4）', () => {
  it('往返：目录结构 + 内容逐字节一致（含空子目录与嵌套）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const root = path.join(ws, '产品集', '系列A', '图包', '主图')
    await fsp.mkdir(path.join(root, '子目录', '深层'), { recursive: true })
    await fsp.mkdir(path.join(root, '空目录'), { recursive: true })
    await fsp.writeFile(path.join(root, 'a.txt'), SAMPLE)
    await fsp.writeFile(path.join(root, '子目录', 'b.bin'), Buffer.from([0, 1, 2, 3, 255]))
    await fsp.writeFile(path.join(root, '子目录', '深层', 'c.md'), Buffer.from('nested'))

    // 压缩「主图」目录（单目录源 → 主图/ 结构）
    const zipPath = path.join(ws, '导出', 'test.zip')
    await compressToZip([root], zipPath)
    expect((await fsp.stat(zipPath)).size).toBeGreaterThan(0)

    // 解压到全新目录
    const outDir = path.join(ws, '导出', 'out')
    await extractZip(zipPath, outDir)
    for (const [rel, expectData] of [
      ['主图/a.txt', SAMPLE],
      ['主图/子目录/b.bin', Buffer.from([0, 1, 2, 3, 255])],
      ['主图/子目录/深层/c.md', Buffer.from('nested')],
    ] as [string, Buffer][]) {
      expect(await fsp.readFile(path.join(outDir, rel))).toEqual(expectData)
    }
    expect((await fsp.stat(path.join(outDir, '主图', '空目录'))).isDirectory()).toBe(true)
  })

  it('解压模式：here → 当前文件夹；folder → <zip 名>/ 子文件夹', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const src = path.join(ws, '产品集', '系列A', '图包', '主图', 'x.txt')
    await fsp.writeFile(src, SAMPLE)
    const zipPath = path.join(ws, '导出', 'mode.zip')
    await compressToZip([src], zipPath)

    await box.archive.extract({ zipPath, mode: 'here' })
    expect(await fsp.readFile(path.join(ws, '导出', 'x.txt'))).toEqual(SAMPLE)

    await box.archive.extract({ zipPath, mode: 'folder' })
    expect(await fsp.readFile(path.join(ws, '导出', 'mode', 'x.txt'))).toEqual(SAMPLE)
  })

  it('zip-slip：.. 逃逸与绝对路径条目被跳过，不落盘', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const evil = buildStoreZip([
      { name: Buffer.from('../evil.txt'), data: Buffer.from('escape') },
      { name: Buffer.from('/abs.txt'), data: Buffer.from('absolute') },
      { name: Buffer.from('ok.txt'), data: SAMPLE },
    ])
    const zipPath = path.join(ws, '导出', 'evil.zip')
    await fsp.writeFile(zipPath, evil)

    const outDir = path.join(ws, '导出', 'out')
    const { count } = await extractZip(zipPath, outDir)
    expect(count).toBe(1) // 只处理合法条目
    expect(await fsp.readFile(path.join(outDir, 'ok.txt'))).toEqual(SAMPLE)
    // 逃逸目标与工作区外不产生文件
    expect(await fsp.stat(path.join(ws, 'evil.txt')).catch(() => null)).toBeNull()
    expect(await fsp.stat(path.join(ws, '..', 'evil.txt')).catch(() => null)).toBeNull()
    expect(await fsp.stat(path.join(outDir, '..', 'evil.txt')).catch(() => null)).toBeNull()
  })

  it('GBK 文件名（Windows 压缩包）：非 UTF-8 标记按 GBK 解码', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // '测试' 的 GBK 字节（无 UTF-8 标记）
    const gbkBytes = Buffer.from([0xb2, 0xe2, 0xca, 0xd4])
    // 先确认环境 TextDecoder 按 GBK 解出「测试」（若表记忆错误，此断言先暴露）
    expect(new TextDecoder('gbk').decode(gbkBytes)).toBe('测试')

    const zipPath = path.join(ws, '导出', 'gbk.zip')
    await fsp.writeFile(zipPath, buildStoreZip([{ name: gbkBytes, data: SAMPLE }]))
    const outDir = path.join(ws, '导出', 'out')
    await extractZip(zipPath, outDir)
    expect(await fsp.readFile(path.join(outDir, '测试'))).toEqual(SAMPLE)
  })

  it('冲突：重复解压同名文件自动加 _1 序号，不覆盖', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const src = path.join(ws, '产品集', '系列A', '图包', '主图', 'x.txt')
    await fsp.writeFile(src, SAMPLE)
    const zipPath = path.join(ws, '导出', 'c.zip')
    await compressToZip([src], zipPath)

    const outDir = path.join(ws, '导出', 'out')
    await extractZip(zipPath, outDir)
    await extractZip(zipPath, outDir)
    expect(await fsp.readFile(path.join(outDir, 'x.txt'))).toEqual(SAMPLE)
    expect(await fsp.readFile(path.join(outDir, 'x_1.txt'))).toEqual(SAMPLE)
  })

  it('取消：压缩中途取消 → 抛错且 ArchiveService 清理半成品包', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const dir = path.join(ws, '产品集', '系列A', '图包', '主图')
    await fsp.mkdir(dir, { recursive: true })
    for (let i = 0; i < 20; i++) await fsp.writeFile(path.join(dir, `f${i}.bin`), Buffer.alloc(1024, i))

    // 不取消 → 正常完成
    let cancelled = false
    const done = await box.archive.compress({ paths: [dir], name: 'cancel' }, { isCancelled: () => cancelled })
    expect(done.path.endsWith('cancel.zip')).toBe(true)
    expect(await fsp.stat(done.path).catch(() => null)).not.toBeNull()

    // 处理到第 5 个条目后置取消标记 → 中断且清理半成品
    await expect(
      box.archive.compress(
        { paths: [dir], name: 'cancel2' },
        {
          onProgress: (doneCount) => {
            if (doneCount >= 5) cancelled = true
          },
          isCancelled: () => cancelled,
        },
      ),
    ).rejects.toThrow('操作已取消')
    const exportDir = path.join(ws, '导出')
    const files = await fsp.readdir(exportDir)
    expect(files.filter((f) => f.endsWith('.zip'))).toEqual(['cancel.zip']) // 只有第一个成功产物
  })

  it('校验失败：篡改压缩包数据字节 → 报错且不残留目标文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const zipPath = path.join(ws, '导出', 'corrupt.zip')
    const zip = buildStoreZip([{ name: Buffer.from('a.txt'), data: SAMPLE }])
    zip[30 + 'a.txt'.length] = zip[30 + 'a.txt'.length] ^ 0xff // 数据区首字节翻转（30 字节头 + 5 字节名）
    await fsp.writeFile(zipPath, zip)

    const outDir = path.join(ws, '导出', 'out')
    await expect(extractZip(zipPath, outDir)).rejects.toThrow('校验失败')
    expect(await fsp.stat(path.join(outDir, 'a.txt')).catch(() => null)).toBeNull()
  })

  it('自动命名：全部源同属一个产品集 → <产品集名>_分享；多源 → 分享_时间戳', () => {
    const ws = '/ws'
    expect(suggestZipName([`${ws}/产品集/系列A/图包/主图/a.jpg`], ws)).toBe('系列A_分享')
    expect(
      suggestZipName([`${ws}/产品集/系列A/图包/主图/a.jpg`, `${ws}/产品集/系列B/证书/3C/b.pdf`], ws),
    ).toMatch(/^分享_\d{8}-\d{6}$/)
  })

  it('单任务守卫：归档任务进行中，第二个任务直接拒绝（压缩/解压共享一把锁）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const dir = path.join(ws, '产品集', '系列A', '图包', '主图')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'a.txt'), SAMPLE)

    // 第一个任务启动（beginTask 在首个 await 前同步置锁，必然在飞行中）
    const first = box.archive.compress({ paths: [dir], name: 'guard' })
    await expect(box.archive.compress({ paths: [dir], name: 'guard2' })).rejects.toThrow('进行中')
    await first // 第一个任务正常完成、锁释放

    // 锁已释放：后续任务可正常执行（解压同锁也验证一次）
    const zipPath = path.join(ws, '导出', 'guard.zip')
    await expect(box.archive.extract({ zipPath, mode: 'folder' })).resolves.toBeTruthy()
  })
})

describe('导出区列表 listExports（v2.4.8）', () => {
  it('空导出目录 → 返回空数组', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    expect(await box.archive.listExports()).toEqual([])
  })

  it('按修改时间倒序列出 zip，字段完整', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const exportDir = path.join(ws, '导出')
    const aPath = path.join(exportDir, 'a.zip')
    const bPath = path.join(exportDir, 'b.zip')
    await fsp.writeFile(aPath, SAMPLE)
    await fsp.writeFile(bPath, Buffer.from('b'))
    // 拉开 mtime：b.zip 较新（默认写入序通常已满足，但显式设置保证确定性）
    const old = new Date('2026-01-01T00:00:00Z')
    const fresh = new Date('2026-08-01T00:00:00Z')
    await fsp.utimes(aPath, old, old)
    await fsp.utimes(bPath, fresh, fresh)

    const list = await box.archive.listExports()
    expect(list.map((e) => e.name)).toEqual(['b.zip', 'a.zip'])
    expect(list[0]).toMatchObject({
      name: 'b.zip',
      path: bPath,
      size: 1,
      mtime: fresh.toISOString(),
    })
    expect(list[1].mtime).toBe(old.toISOString())
  })

  it('导出目录中的子目录被过滤，仅文件入列', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const exportDir = path.join(ws, '导出')
    await fsp.writeFile(path.join(exportDir, 'c.zip'), SAMPLE)
    await fsp.mkdir(path.join(exportDir, '子目录'), { recursive: true })

    const list = await box.archive.listExports()
    expect(list.map((e) => e.name)).toEqual(['c.zip'])
  })

  it('导出目录不存在（异常工作区）→ 返回空数组而非抛错', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 手工移除导出目录，模拟目录缺失场景
    await fsp.rm(path.join(ws, '导出'), { recursive: true, force: true })
    expect(await box.archive.listExports()).toEqual([])
  })
})
