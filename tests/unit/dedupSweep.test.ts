import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildTestBox } from './helpers'
import { buildContentIndex, findContentGroups } from '../../src/main/core/dedup'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-sweep-'))
}

const CONTENT_X = Buffer.from('qihe-sweep-X-' + 'x'.repeat(1024))
const CONTENT_Y = Buffer.from('qihe-sweep-Y-' + 'y'.repeat(1024))

/** 直接在证书域落盘（模拟同步物化/手动拷贝来的独立副本，不经导入管线） */
async function seedCert(ws: string, ps: string, name: string, content: Buffer): Promise<string> {
  const dir = path.join(ws, '产品集', ps, '证书', '子目录')
  await fsp.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fsp.writeFile(p, content)
  return p
}

const afterEachCleanup: (() => void)[] = []
afterEach(() => {
  while (afterEachCleanup.length) afterEachCleanup.pop()!()
})

describe('v2.5.8 D3.5 去重巡检——findContentGroups 三级漏斗', () => {
  it('同内容成组；同大小异内容被部分/全量哈希拦下；大小唯一不参与', async () => {
    const ws = await tmp()
    const a1 = await seedCert(ws, 'PS-A', 'a1.pdf', CONTENT_X)
    const a2 = await seedCert(ws, 'PS-A', 'a2.pdf', CONTENT_X)
    const b1 = await seedCert(ws, 'PS-B', 'b1.pdf', CONTENT_Y) // 同大小异内容
    await seedCert(ws, 'PS-B', 'c1.pdf', CONTENT_X.slice(0, 512)) // 大小唯一

    const groups = await findContentGroups(await buildContentIndex(ws))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual([a1, a2].sort())
    expect(groups[0]).not.toContain(b1)
  })

  it('前 64KB 相同但尾部不同（同大小）→ 全量哈希把关不成组', async () => {
    const ws = await tmp()
    const head = Buffer.from('h'.repeat(65536))
    const f1 = await seedCert(ws, 'PS-A', 'big1.pdf', Buffer.concat([head, Buffer.from('tail-1')]))
    const f2 = await seedCert(ws, 'PS-B', 'big2.pdf', Buffer.concat([head, Buffer.from('tail-2')]))

    const groups = await findContentGroups(await buildContentIndex(ws))
    expect(groups).toHaveLength(0)
    expect(f1).toBeTruthy()
    expect(f2).toBeTruthy()
  })
})

describe('v2.5.8 D3.5 去重巡检——FilesService.dedupSweep', () => {
  it('同内容独立副本 → 重建硬链接：ino 相同、两路径都在、nlink≥2、bytesSaved 正确', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const p1 = await seedCert(ws, 'PS-A', 'cert.pdf', CONTENT_X)
    const p2 = await seedCert(ws, 'PS-B', 'cert.pdf', CONTENT_X)
    expect((await fsp.stat(p1)).ino).not.toBe((await fsp.stat(p2)).ino)

    const r = await box.files.dedupSweep()
    expect(r.groups).toBe(1)
    expect(r.relinked).toBe(1)
    expect(r.bytesSaved).toBe(CONTENT_X.length)
    expect(r.failed).toHaveLength(0)
    // 两路径都还在（不删文件）
    await expect(fsp.stat(p1)).resolves.toBeTruthy()
    await expect(fsp.stat(p2)).resolves.toBeTruthy()
    expect((await fsp.stat(p2)).ino).toBe((await fsp.stat(p1)).ino)
    expect((await fsp.stat(p2)).nlink).toBeGreaterThanOrEqual(2)
  })

  it('副本路径的元数据不被巡检破坏', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const p1 = await seedCert(ws, 'PS-A', 'cert.pdf', CONTENT_X)
    const p2 = await seedCert(ws, 'PS-B', 'cert.pdf', CONTENT_X)
    await box.metadata.update({ file_path: p2, tags: ['巡检前'], notes: '保留' })

    await box.files.dedupSweep()
    const meta = await box.metadata.get(p2)
    expect(meta.tags).toEqual(['巡检前'])
    expect(meta.notes).toBe('保留')
    expect(p1).toBeTruthy()
  })

  it('已链接（nlink≥2）成员跳过——二次巡检零重建', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    await seedCert(ws, 'PS-A', 'cert.pdf', CONTENT_X)
    await seedCert(ws, 'PS-B', 'cert.pdf', CONTENT_X)

    const r1 = await box.files.dedupSweep()
    expect(r1.relinked).toBe(1)
    const r2 = await box.files.dedupSweep()
    expect(r2.groups).toBe(1) // 仍能发现组
    expect(r2.relinked).toBe(0)
    expect(r2.bytesSaved).toBe(0)
  })

  it('无重复 → 零写操作（groups 0 / relinked 0）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await seedCert(ws, 'PS-A', 'x.pdf', CONTENT_X)
    await seedCert(ws, 'PS-A', 'y.pdf', CONTENT_Y)

    const r = await box.files.dedupSweep()
    expect(r.groups).toBe(0)
    expect(r.relinked).toBe(0)
    expect(r.failed).toHaveLength(0)
  })

  it('rename 打桩抛 EXDEV → 单文件跳过计 failed，不中断不丢文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const p1 = await seedCert(ws, 'PS-A', 'cert.pdf', CONTENT_X)
    const p2 = await seedCert(ws, 'PS-B', 'cert.pdf', CONTENT_X)

    const spy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValue(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }))
    afterEachCleanup.push(() => spy.mockRestore())
    const r = await box.files.dedupSweep()
    spy.mockRestore()

    expect(r.groups).toBe(1)
    expect(r.relinked).toBe(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].path).toBe(p2)
    // 文件原样在位
    await expect(fsp.readFile(p2)).resolves.toEqual(CONTENT_X)
    expect((await fsp.stat(p1)).ino).toBeTruthy()
  })

  it('巡检进行中重入 → 报错不排队', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    await seedCert(ws, 'PS-A', 'cert.pdf', CONTENT_X)
    await seedCert(ws, 'PS-B', 'cert.pdf', CONTENT_X)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realRename = fsp.rename.bind(fsp) // 先捕获原实现——mock 内再调 fsp.rename 会无限递归（OOM 教训）
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
      await gate
      return realRename(args[0] as string, args[1] as string)
    })
    afterEachCleanup.push(() => spy.mockRestore())
    const p = box.files.dedupSweep()
    await new Promise((r) => setTimeout(r, 50)) // 等 sweep 进入 rename 门
    await expect(box.files.dedupSweep()).rejects.toThrow('去重巡检进行中')
    release()
    const r = await p
    spy.mockRestore()
    expect(r.relinked).toBe(1)
  })
})
