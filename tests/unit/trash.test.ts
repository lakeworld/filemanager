import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-trash-'))
}

/** 最小 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 导入一张 PNG 到 系列A/图包/主图，返回 FileEntry */
async function importOne(box: ReturnType<typeof buildTestBox>, ws: string, name: string) {
  const src = path.join(ws, '..', name)
  await fsp.writeFile(src, PNG_1PX)
  const result = await box.files.importFiles({
    source_paths: [src],
    target_product_set: '系列A',
    target_folder: '主图',
    target_type: 'image',
    sub_folder: '主图',
  })
  return result.imported[0]
}

describe('回收站（v2.3.1）', () => {
  it('删除文件 → 进回收站：原文件消失、条目可见、元数据保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'a.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'], notes: 'n' })

    await box.files.fileDelete([file.path])

    // 原文件已移走
    await expect(fsp.stat(file.path)).rejects.toThrow()
    // 回收站有 1 条
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('file')
    expect(entries[0].originalPath).toBe(file.path)
    // 元数据保留（恢复后可还原）
    const meta = await box.metadata.get(file.path)
    expect(meta.tags).toEqual(['重点'])
    expect(meta.notes).toBe('n')
  })

  it('恢复文件 → 回原路径，元数据与标签原样', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'b.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'] })

    await box.files.fileDelete([file.path])
    const entries = await box.trash.list()

    await box.trash.restore(entries[0].id)

    // 文件回原位
    await expect(fsp.stat(file.path)).resolves.toBeTruthy()
    // 回收站清空
    expect(await box.trash.list()).toHaveLength(0)
    // 元数据完好
    const meta = await box.metadata.get(file.path)
    expect(meta.tags).toEqual(['重点'])
  })

  it('恢复冲突 → 自动加「-恢复N」后缀', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'c.jpg')
    await box.files.fileDelete([file.path])
    // 原位置放一个同名文件 → 恢复时冲突
    await fsp.writeFile(file.path, PNG_1PX)

    const entries = await box.trash.list()
    await box.trash.restore(entries[0].id)

    const dir = path.dirname(file.path)
    const files = await fsp.readdir(dir)
    expect(files).toContain(file.name)
    expect(files.some((f) => f.includes('-恢复1'))).toBe(true)
  })

  it('彻底删除文件 → 元数据清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'd.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'] })
    await box.files.fileDelete([file.path])

    const entries = await box.trash.list()
    await box.trash.purge(entries[0].id)

    expect(await box.trash.list()).toHaveLength(0)
    // 元数据已清理（get 对不存在 key 返回空对象，直接查 store）
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain(`系列A/图包/主图/${file.name}`)
  })

  it('删除/恢复子文件夹：config 移除后恢复加回', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    await box.files.createSubfolder({ product_set: '系列A', file_type: 'image', name: '场景图' })
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders).toContain('场景图')

    await box.files.deleteSubfolder({ product_set: '系列A', file_type: 'image', name: '场景图' })
    const cfg2 = await box.workspace.loadConfig(ws)
    expect(cfg2.image_subfolders).not.toContain('场景图')
    // 目录已移走
    const dir = path.join(ws, '产品集', '系列A', '图包', '场景图')
    await expect(fsp.stat(dir)).rejects.toThrow()

    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('subfolder')

    await box.trash.restore(entries[0].id)
    await expect(fsp.stat(dir)).resolves.toBeTruthy()
    const cfg3 = await box.workspace.loadConfig(ws)
    expect(cfg3.image_subfolders).toContain('场景图')
  })

  it('删除/恢复产品集：目录移走即消失，恢复后 tags/notes 保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重点'], notes: '备注' })

    await box.deleteProductSet('系列A')
    let list = await box.workspace.productSetList()
    expect(list.map((p) => p.name)).not.toContain('系列A')

    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('productSet')

    await box.trash.restore(entries[0].id)
    list = await box.workspace.productSetList()
    const restored = list.find((p) => p.name === '系列A')
    expect(restored).toBeTruthy()
    expect(restored?.tags).toEqual(['重点'])
    expect(restored?.notes).toBe('备注')
  })

  it('清空回收站：全部彻底删除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'e.jpg')
    await box.files.fileDelete([file.path])
    await box.trash.empty()

    expect(await box.trash.list()).toHaveLength(0)
    // 回收站目录内无条目残留
    const trashRoot = path.join(ws, '.qihefilemanager', 'trash')
    const left = await fsp.readdir(trashRoot).catch(() => [])
    expect(left).toHaveLength(0)
  })

  it('cleanupExpired：超期条目被清理（含元数据），近期条目保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 导入两个文件并删除 → 两条回收站条目（先删 im1 后删 im2）
    const im1 = await importOne(box, ws, 'exp1.jpg')
    await box.metadata.update({ file_path: im1.path, tags: ['超期'] })
    await box.files.fileDelete([im1.path])
    const im2 = await importOne(box, ws, 'exp2.jpg')
    await box.files.fileDelete([im2.path])

    const entries = await box.trash.list()
    expect(entries).toHaveLength(2)
    // entries[0] 是最新删除的（im2）；把它的 deletedAt 改到 40 天前 → 超期
    const metaPath = path.join(ws, '.qihefilemanager', 'trash', entries[0].id, 'meta.json')
    const m = JSON.parse(await fsp.readFile(metaPath, 'utf-8'))
    m.deletedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await fsp.writeFile(metaPath, JSON.stringify(m, null, 2))

    const removed = await box.trash.cleanupExpired(30)
    expect(removed).toBe(1)

    // 剩余 1 条是近期的
    const left = await box.trash.list()
    expect(left).toHaveLength(1)
    expect(new Date(left[0].deletedAt).getTime()).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000)

    // 被清理条目的元数据同步删除，近期条目元数据保留
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain(`系列A/图包/主图/${im2.name}`)
    expect(Object.keys(store.files)).toContain(`系列A/图包/主图/${im1.name}`)
  })
})
