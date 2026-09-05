import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dedup-'))
}

/** 最小 1x1 PNG（真实字节，导入时当图片处理） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 证书域测试内容（任意固定字节） */
const CERT_A = Buffer.from('qihe-dedup-cert-A-' + 'x'.repeat(512))
const CERT_B = Buffer.from('qihe-dedup-cert-B-' + 'y'.repeat(512))

/** 证书导入请求（默认命名模板下候选名形如 <PS>_<sub>_<base>_1.pdf） */
function certReq(source_paths: string[], ps: string) {
  return {
    source_paths,
    target_product_set: ps,
    target_folder: '证书',
    target_type: 'cert',
    sub_folder: '子目录',
  }
}

const afterEachCleanup: (() => void)[] = []
afterEach(() => {
  while (afterEachCleanup.length) afterEachCleanup.pop()!()
})

describe('v2.5.8 D3 硬链接去重（证书/文档域）', () => {
  it('同内容二次导入另一产品集 → 建硬链接（ino 相同 / nlink ≥ 2）计入 linked', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const src = path.join(home, 'cert.pdf')
    await fsp.writeFile(src, CERT_A)

    const r1 = await box.files.importFiles(certReq([src], 'PS-A'))
    expect(r1.imported).toHaveLength(1)
    expect(r1.linked).toHaveLength(0)

    const r2 = await box.files.importFiles(certReq([src], 'PS-B'))
    expect(r2.imported).toHaveLength(1)
    expect(r2.linked).toHaveLength(1)
    expect(r2.linked[0].path).toBe(src)
    expect(r2.linked[0].existing).toBe(r1.imported[0].path)

    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).toBe(a.ino)
    expect(b.nlink).toBeGreaterThanOrEqual(2)
    expect(r2.failed).toHaveLength(0)
  })

  it('同文件同位置重复导入 → skipped、无 _1 文件、元数据不被重置', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    const src = path.join(home, 'cert.pdf')
    await fsp.writeFile(src, CERT_A)

    const r1 = await box.files.importFiles(certReq([src], 'PS-A'))
    expect(r1.imported).toHaveLength(1)
    const dest = r1.imported[0].path
    await box.metadata.update({ file_path: dest, tags: ['旧标签'], notes: '保留我' })
    const metaBefore = await box.metadata.get(dest)

    const r2 = await box.files.importFiles(certReq([src], 'PS-A'))
    expect(r2.skipped).toHaveLength(1)
    expect(r2.skipped[0].existing).toBe(dest)
    expect(r2.imported).toHaveLength(0)
    expect(r2.linked).toHaveLength(0)

    // 目录内仍只有原文件，无 _1 副本
    const dir = path.dirname(dest)
    const names = (await fsp.readdir(dir)).filter((n) => !n.startsWith('.'))
    expect(names).toEqual([path.basename(dest)])

    // 元数据不被重置（skip 路径不写元数据）
    const metaAfter = await box.metadata.get(dest)
    expect(metaAfter.added_at).toBe(metaBefore.added_at)
    expect(metaAfter.tags).toEqual(['旧标签'])
    expect(metaAfter.notes).toBe('保留我')
  })

  it('同内容不同文件名同目录 → 硬链接共存（ino 相同）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    const s1 = path.join(home, 'first.pdf')
    const s2 = path.join(home, 'second.pdf')
    await fsp.writeFile(s1, CERT_A)
    await fsp.writeFile(s2, CERT_A)

    const r1 = await box.files.importFiles(certReq([s1], 'PS-A'))
    const r2 = await box.files.importFiles(certReq([s2], 'PS-A'))
    expect(r2.linked).toHaveLength(1)
    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).toBe(a.ino)
    expect(b.nlink).toBeGreaterThanOrEqual(2)
  })

  it('同名不同内容 → 仍 _1 复制（回归守卫）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    // 同名不同内容：两个不同目录下的 dup.pdf
    const d1 = path.join(home, 'd1')
    const d2 = path.join(home, 'd2')
    await fsp.mkdir(d1)
    await fsp.mkdir(d2)
    await fsp.writeFile(path.join(d1, 'dup.pdf'), CERT_A)
    await fsp.writeFile(path.join(d2, 'dup.pdf'), CERT_B)

    const r1 = await box.files.importFiles(certReq([path.join(d1, 'dup.pdf')], 'PS-A'))
    const r2 = await box.files.importFiles(certReq([path.join(d2, 'dup.pdf')], 'PS-A'))
    expect(r1.imported).toHaveLength(1)
    expect(r2.imported).toHaveLength(1)
    expect(r2.linked).toHaveLength(0)
    expect(r2.skipped).toHaveLength(0)
    // 冲突解析照旧 → _1 副本，内容独立
    expect(r2.imported[0].name).not.toBe(r1.imported[0].name)
    expect(r2.imported[0].name).toContain('_1')
    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).not.toBe(a.ino)
  })

  it('同批次内同内容两文件 → 第二个建链到第一个', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    const s1 = path.join(home, 'batch-a.pdf')
    const s2 = path.join(home, 'batch-b.pdf')
    await fsp.writeFile(s1, CERT_A)
    await fsp.writeFile(s2, CERT_A)

    const r = await box.files.importFiles(certReq([s1, s2], 'PS-A'))
    expect(r.imported).toHaveLength(2)
    expect(r.linked).toHaveLength(1)
    expect(r.linked[0].existing).toBe(r.imported[0].path)
    const a = await fsp.stat(r.imported[0].path)
    const b = await fsp.stat(r.imported[1].path)
    expect(b.ino).toBe(a.ino)
  })

  it('文档域（target_type=doc）同样生效', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const src = path.join(home, 'doc.pdf')
    await fsp.writeFile(src, CERT_A)

    const docReq = (ps: string) => ({
      source_paths: [src],
      target_product_set: ps,
      target_folder: '文档',
      target_type: 'doc',
      sub_folder: '子目录',
    })
    const r1 = await box.files.importFiles(docReq('PS-A'))
    const r2 = await box.files.importFiles(docReq('PS-B'))
    expect(r2.linked).toHaveLength(1)
    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).toBe(a.ino)
  })

  it('图包（image）不触发去重——各存一份', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const src = path.join(home, 'img.png')
    await fsp.writeFile(src, PNG_1PX)

    const imgReq = (ps: string) => ({
      source_paths: [src],
      target_product_set: ps,
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    const r1 = await box.files.importFiles(imgReq('PS-A'))
    const r2 = await box.files.importFiles(imgReq('PS-B'))
    expect(r1.imported).toHaveLength(1)
    expect(r2.imported).toHaveLength(1)
    expect(r2.linked).toHaveLength(0)
    expect(r2.skipped).toHaveLength(0)
    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).not.toBe(a.ino)
  })

  it('link 抛 EXDEV → 回退普通复制计 imported（不丢文件）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const src = path.join(home, 'cert.pdf')
    await fsp.writeFile(src, CERT_A)

    const r1 = await box.files.importFiles(certReq([src], 'PS-A'))
    const spy = vi.spyOn(fsp, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    )
    afterEachCleanup.push(() => spy.mockRestore())
    const r2 = await box.files.importFiles(certReq([src], 'PS-B'))
    spy.mockRestore()

    expect(r2.imported).toHaveLength(1)
    expect(r2.linked).toHaveLength(0)
    expect(r2.failed).toHaveLength(0)
    const dest = path.join(ws, '产品集', 'PS-B', '证书', '子目录', r2.imported[0].name)
    const a = await fsp.stat(r1.imported[0].path)
    const b = await fsp.stat(dest)
    expect(b.ino).not.toBe(a.ino)
  })

  it('索引纳入符号链接文件（形态照 listDirFilesRecursive），建链落在真实文件且不逃逸', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'PS-A' })
    await box.workspace.productSetCreate({ name: 'PS-B' })
    const src = path.join(home, 'cert.pdf')
    await fsp.writeFile(src, CERT_A)

    const r1 = await box.files.importFiles(certReq([src], 'PS-A'))
    // 证书域内放一个指向已导入文件的符号链接（别名）
    const alias = path.join(ws, '产品集', 'PS-A', '证书', '子目录', '别名.pdf')
    await fsp.symlink(r1.imported[0].path, alias)

    // 指向工作区外的 symlink 候选不得入索引（此处仅验证内链场景可命中）
    const r2 = await box.files.importFiles(certReq([src], 'PS-B'))
    expect(r2.linked).toHaveLength(1)
    // link 源是解析后的真实文件（非 symlink 本身）
    expect(r2.linked[0].existing).toBe(r1.imported[0].path)
    const b = await fsp.stat(r2.imported[0].path)
    expect(b.ino).toBe((await fsp.stat(r1.imported[0].path)).ino)
    expect(b.nlink).toBeGreaterThanOrEqual(2)
  })
})
