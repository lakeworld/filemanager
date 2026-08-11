/**
 * 文件元数据单测（v2.4.0）：读写回读、损坏 JSON 自动备份降级、key 组合、清理。
 * v2.4.2（D3+D4）：key 改为按文件路径推导（产品集/图包|证书/子文件夹/文件名，固定 / 分隔符）——
 * 子文件夹同名文件隔离、旧格式 key 读取回退 + 写入懒迁移。
 * v2.4.7（§4.1）：key 泛化——工作区内任意文件可打标（key = 产品集相对路径或工作区相对路径）；
 * 工作区外文件进入失败清单（文案「不在工作区」）。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { metadataPath } from '../../src/main/core/paths'
import { normalizeExpiryDate } from '../../src/main/core/metadata'
import type { FileMetadata } from '../../src/main/core/metadata'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-meta-'))
}

function meta(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: '', ...overrides }
}

/** 建一个产品集并写入一个文件，返回其绝对路径（产品集创建幂等，可多次调用） */
async function ensureSet(box: ReturnType<typeof buildTestBox>, name: string): Promise<void> {
  const sets = await box.workspace.productSetList()
  if (!sets.some((s) => s.name === name)) await box.workspace.productSetCreate({ name })
}

async function setupFile(box: ReturnType<typeof buildTestBox>, ws: string, sub = '主图', name = 'b.jpg'): Promise<string> {
  await ensureSet(box, '系列A')
  const filePath = path.join(ws, '产品集', '系列A', '图包', sub, name)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, 'x')
  return filePath
}

describe('文件元数据（MetadataService）', () => {
  it('读写：update → get 回读一致，落盘 JSON 可查', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const filePath = await setupFile(box, ws)

    await box.metadata.update({
      file_path: filePath,
      cert_type: '3C',
      expiry_date: '2027-01-01',
      tags: ['重点'],
      notes: '备注',
    })

    const m = await box.metadata.get(filePath)
    expect(m.cert_type).toBe('3C')
    expect(m.expiry_date).toBe('2027-01-01')
    expect(m.tags).toEqual(['重点'])
    expect(m.notes).toBe('备注')
    expect(m.added_at).toBeTruthy()

    const raw = JSON.parse(await fsp.readFile(metadataPath(ws), 'utf-8'))
    expect(raw.files['系列A/图包/主图/b.jpg']).toBeTruthy()
  })

  it('v2.4.2（C1）：expiry_date 写入时归一化为 YYYY-MM-DD（提取/导入的 YYYY/M/D / ISO 带时间）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const filePath = await setupFile(box, ws)

    await box.metadata.update({ file_path: filePath, expiry_date: '2027/3/5' })
    expect((await box.metadata.get(filePath)).expiry_date).toBe('2027-03-05')
    await box.metadata.update({ file_path: filePath, expiry_date: '2028-06-01T12:00:00Z' })
    expect((await box.metadata.get(filePath)).expiry_date).toBe('2028-06-01')
    // 非法日期：保留原文（读取侧宽松解析会跳过并告警）
    await box.metadata.update({ file_path: filePath, expiry_date: '2023-02-30' })
    expect((await box.metadata.get(filePath)).expiry_date).toBe('2023-02-30')
  })

  it('normalizeExpiryDate：解析失败的日期返回 null', () => {
    expect(normalizeExpiryDate('2027-03-05')).toBe('2027-03-05')
    expect(normalizeExpiryDate('2027/3/5')).toBe('2027-03-05')
    expect(normalizeExpiryDate('2023-02-30')).toBeNull()
    expect(normalizeExpiryDate('不是日期')).toBeNull()
  })

  it('损坏 JSON：自动备份 .corrupt-* 并降级为空库（不抛错、不丢数据）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const corrupt = '{坏掉的json!!'
    await fsp.writeFile(metadataPath(ws), corrupt, 'utf-8')

    const store = await box.metadata.loadMetadataStore()
    expect(store.files).toEqual({})

    // 原文件被备份为 metadata.json.corrupt-<时间戳>
    const files = await fsp.readdir(path.join(ws, '.qihefilemanager'))
    const backup = files.find((f) => f.startsWith('metadata.json.corrupt-'))
    expect(backup).toBeTruthy()
    expect(await fsp.readFile(path.join(ws, '.qihefilemanager', backup!), 'utf-8')).toBe(corrupt)
  })

  it('损坏降级后仍可正常写入', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await fsp.writeFile(metadataPath(ws), 'not-json', 'utf-8')

    const filePath = await setupFile(box, ws)
    await box.metadata.setFileMetadata(filePath, meta({ tags: ['T'], notes: '恢复' }))
    const m = await box.metadata.get(filePath)
    expect(m.tags).toEqual(['T'])
    expect(m.notes).toBe('恢复')
  })

  it('fileMetadataKey：按文件路径推导 产品集/图包|证书/子文件夹/文件名', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const filePath = await setupFile(box, ws, '白底图', 'a.jpg')
    expect(box.metadata.fileMetadataKey(filePath)).toBe('系列A/图包/白底图/a.jpg')
    // 工作区外返回空串
    expect(box.metadata.fileMetadataKey(path.join(os.tmpdir(), 'x.jpg'))).toBe('')
  })

  it('v2.4.2（D3）：同产品集不同子文件夹的同名文件元数据互不影响', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const f1 = await setupFile(box, ws, '主图', 'a.jpg')
    const f2 = await setupFile(box, ws, '白底图', 'a.jpg')

    await box.metadata.update({ file_path: f1, tags: ['主图标签'], notes: '主图备注' })
    await box.metadata.update({ file_path: f2, tags: ['白底图标签'] })

    expect((await box.metadata.get(f1)).tags).toEqual(['主图标签'])
    expect((await box.metadata.get(f2)).tags).toEqual(['白底图标签'])

    // 删除一个不影响另一个（旧实现 key 不含子文件夹会误删）
    await box.metadata.removeFileMetadata(f1)
    expect((await box.metadata.get(f2)).tags).toEqual(['白底图标签'])
    const store = await box.metadata.loadMetadataStore()
    expect(store.files['系列A/图包/主图/a.jpg']).toBeUndefined()
    expect(store.files['系列A/图包/白底图/a.jpg']).toBeTruthy()
  })

  it('v2.4.2（D4）：旧格式 key（产品集/文件名）读取回退 + 写入懒迁移到新 key', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const filePath = await setupFile(box, ws, '主图', 'legacy.jpg')

    // 手工写入旧格式 key（模拟 v2.4.1 及更早版本数据；Windows 旧数据可能是反斜杠 key）
    const store = await box.metadata.loadMetadataStore()
    store.files['系列A/legacy.jpg'] = { cert_type: '3C', expiry_date: '', tags: ['旧'], notes: 'legacy', added_at: '2024-01-01T00:00:00Z' }
    store.files['系列B\\legacy2.jpg'] = { cert_type: '', expiry_date: '', tags: ['反斜杠'], notes: '', added_at: '' }
    await box.metadata.saveMetadataStore(store)

    // 旧 key（/ 与 \ 两种）均可按新路径读回
    expect((await box.metadata.get(filePath)).tags).toEqual(['旧'])
    expect((await box.metadata.get(path.join(ws, '产品集', '系列B', '图包', '主图', 'legacy2.jpg'))).tags).toEqual(['反斜杠'])

    // 写入 → 懒迁移到新 key，旧 key 删除
    await box.metadata.update({ file_path: filePath, cert_type: '3C', tags: ['旧', '新'], notes: 'updated' })
    const after = await box.metadata.loadMetadataStore()
    expect(after.files['系列A/图包/主图/legacy.jpg'].tags).toEqual(['旧', '新'])
    expect(after.files['系列A/legacy.jpg']).toBeUndefined()
  })

  it('removeFileMetadata：删除单条后 store 不含该 key', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const filePath = await setupFile(box, ws)

    await box.metadata.setFileMetadata(filePath, meta({ tags: ['T'] }))
    await box.metadata.removeFileMetadata(filePath)

    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain('系列A/图包/主图/b.jpg')
  })

  it('removeFileMetadataForProductSet：只清理该产品集，其余保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })
    const f1 = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    const f2 = path.join(ws, '产品集', '系列A', '图包', '主图', 'b.jpg')
    const f3 = path.join(ws, '产品集', '系列B', '图包', '主图', 'c.jpg')
    await fsp.mkdir(path.dirname(f1), { recursive: true })
    await Promise.all([fsp.writeFile(f1, 'x'), fsp.writeFile(f2, 'x'), fsp.writeFile(f3, 'x')])

    await box.metadata.setFileMetadata(f1, meta({ tags: ['T'] }))
    await box.metadata.setFileMetadata(f2, meta({ tags: ['T'] }))
    await box.metadata.setFileMetadata(f3, meta({ tags: ['T'] }))

    await box.metadata.removeFileMetadataForProductSet('系列A')

    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files).sort()).toEqual(['系列B/图包/主图/c.jpg'])
  })

  it('setFileMetadataBatch：一次落盘多条；已存在 key 保留原内容（删除后重导入不丢标签）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const f1 = await setupFile(box, ws, '主图', 'a.jpg')
    const f2 = await setupFile(box, ws, '主图', 'b.jpg')

    await box.metadata.setFileMetadata(f1, meta({ tags: ['原标签'], added_at: '2024-01-01T00:00:00Z' }))
    await box.metadata.setFileMetadataBatch([
      { filePath: f1, meta: meta({ added_at: '2025-01-01T00:00:00Z' }) },
      { filePath: f2, meta: meta({ added_at: '2025-01-01T00:00:00Z' }) },
    ])

    const store = await box.metadata.loadMetadataStore()
    // f1 已有标签被保留（只补 added_at）；f2 新建
    expect(store.files['系列A/图包/主图/a.jpg'].tags).toEqual(['原标签'])
    expect(store.files['系列A/图包/主图/b.jpg'].added_at).toBe('2025-01-01T00:00:00Z')
  })
})

describe('批量打标（v2.4.4 T4）', () => {
  it('setTagsBatch：add 去重合并、remove 移除、单次落盘', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-meta-'))
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-meta-'))
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    const p1 = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    const p2 = path.join(ws, '产品集', '系列A', '图包', '主图', 'b.jpg')
    const p3 = path.join(ws, '产品集', '系列A', '证书', '3C', 'c.pdf')

    // 预置：p1 已有标签
    await box.metadata.update({ file_path: p1, tags: ['已有'], notes: '' })

    // 添加
    let r = await box.metadata.setTagsBatch({ paths: [p1, p2, p3], add: ['重点', '已有'] })
    expect(r.updated).toBe(3)
    expect(r.failed).toHaveLength(0)
    expect((await box.metadata.get(p1)).tags).toEqual(['已有', '重点'])
    expect((await box.metadata.get(p2)).tags).toEqual(['重点', '已有'])
    expect((await box.metadata.get(p3)).tags).toEqual(['重点', '已有'])

    // 移除
    r = await box.metadata.setTagsBatch({ paths: [p1], remove: ['已有'] })
    expect(r.updated).toBe(1)
    expect((await box.metadata.get(p1)).tags).toEqual(['重点'])

    // 工作区外文件 → 失败清单，不中断整体（v2.4.7 §4.1：key 泛化后工作区内任意文件可打标）
    const outside = path.join(os.tmpdir(), 'outside.txt')
    await fsp.writeFile(outside, 'x')
    r = await box.metadata.setTagsBatch({ paths: [p2, outside], add: ['新'] })
    expect(r.updated).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toContain('不在工作区')
  })
})
