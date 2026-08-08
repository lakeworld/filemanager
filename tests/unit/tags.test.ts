import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-'))
}

describe('标签体系（v2.0.1）', () => {
  it('setColor + list 聚合（文件 + 产品集计数）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重要'], notes: '' })

    // 文件标签（直接写 metadata）
    await box.metadata.update({ product_set: '系列A', file_name: 'a.jpg', tags: ['重要', '待更新'] })

    await box.tags.setColor('重要', '#ef4444')
    await box.tags.setColor('待更新', '#f59e0b')

    const tags = await box.tags.list()
    const important = tags.find((t) => t.name === '重要')
    expect(important?.color).toBe('#ef4444')
    expect(important?.count).toBe(2) // 1 文件 + 1 产品集
    const pending = tags.find((t) => t.name === '待更新')
    expect(pending?.count).toBe(1)
  })

  it('rename 同步所有引用（文件 + 产品集）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['旧名'], notes: '' })
    await box.metadata.update({ product_set: '系列A', file_name: 'a.jpg', tags: ['旧名'] })

    await box.tags.rename('旧名', '新名')

    // 产品集引用已改
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual(['新名'])
    // 文件引用已改
    const meta = await box.metadata.get('系列A', 'a.jpg')
    expect(meta.tags).toEqual(['新名'])
    // 定义迁移
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '新名')).toBeTruthy()
    expect(tags.find((t) => t.name === '旧名')).toBeFalsy()
  })

  it('delete 移除定义与所有引用', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['删我'], notes: '' })
    await box.metadata.update({ product_set: '系列A', file_name: 'a.jpg', tags: ['删我', '保留'] })

    await box.tags.delete('删我')

    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual([])
    const meta = await box.metadata.get('系列A', 'a.jpg')
    expect(meta.tags).toEqual(['保留'])
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '删我')).toBeFalsy()
  })

  it('迁移旧版 tags_state.json.colors → tags.json', async () => {
    const home = await tmp()
    const ws = await tmp()
    // 预置旧版 tags_state.json
    await fsp.mkdir(path.join(ws, '.qihefilemanager'), { recursive: true })
    await fsp.writeFile(
      path.join(ws, '.qihefilemanager', 'tags_state.json'),
      JSON.stringify({ colors: { e6: '#123456', 旧标: '#abcdef' } }),
    )
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '旧标')?.color).toBe('#abcdef')
    // tags.json 已生成
    const defs = JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'tags.json'), 'utf-8'))
    expect(defs['旧标'].color).toBe('#abcdef')
  })
})
