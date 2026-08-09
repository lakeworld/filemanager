/**
 * 文件元数据单测（v2.4.0）：读写回读、损坏 JSON 自动备份降级、key 组合、清理。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { metadataPath } from '../../src/main/core/paths'
import type { FileMetadata } from '../../src/main/core/metadata'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-meta-'))
}

function meta(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: '', ...overrides }
}

describe('文件元数据（MetadataService）', () => {
  it('读写：update → get 回读一致，落盘 JSON 可查', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.metadata.update({
      product_set: '系列A',
      file_name: 'b.jpg',
      cert_type: '3C',
      expiry_date: '2027-01-01',
      tags: ['重点'],
      notes: '备注',
    })

    const m = await box.metadata.get('系列A', 'b.jpg')
    expect(m.cert_type).toBe('3C')
    expect(m.expiry_date).toBe('2027-01-01')
    expect(m.tags).toEqual(['重点'])
    expect(m.notes).toBe('备注')
    expect(m.added_at).toBeTruthy()

    const raw = JSON.parse(await fsp.readFile(metadataPath(ws), 'utf-8'))
    expect(raw.files['系列A/b.jpg']).toBeTruthy()
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

    await box.metadata.setFileMetadata('系列A', 'a.jpg', meta({ tags: ['T'], notes: '恢复' }))
    const m = await box.metadata.get('系列A', 'a.jpg')
    expect(m.tags).toEqual(['T'])
    expect(m.notes).toBe('恢复')
  })

  it('fileMetadataKey：产品集/文件名 组合 key', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    expect(box.metadata.fileMetadataKey('系列A', 'a.jpg')).toBe(path.join('系列A', 'a.jpg'))
  })

  it('removeFileMetadata：删除单条后 store 不含该 key', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.metadata.setFileMetadata('系列A', 'a.jpg', meta({ tags: ['T'] }))
    await box.metadata.removeFileMetadata('系列A', 'a.jpg')

    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain('系列A/a.jpg')
  })

  it('removeFileMetadataForProductSet：只清理该产品集，其余保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.metadata.setFileMetadata('系列A', 'a.jpg', meta({ tags: ['T'] }))
    await box.metadata.setFileMetadata('系列A', 'b.jpg', meta({ tags: ['T'] }))
    await box.metadata.setFileMetadata('系列B', 'c.jpg', meta({ tags: ['T'] }))

    await box.metadata.removeFileMetadataForProductSet('系列A')

    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files).sort()).toEqual(['系列B/c.jpg'])
  })
})
