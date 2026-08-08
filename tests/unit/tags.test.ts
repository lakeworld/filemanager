import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-'))
}

describe('标签体系（v2.0.2）', () => {
  it('固定色预设初始化：新工作区自动补全 5 个 builtin 标签', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const tags = await box.tags.list()
    const builtins = tags.filter((t) => t.builtin)
    expect(builtins.map((t) => t.name).sort()).toEqual(['待更新', '已更新', '归档', '问题', '重要'].sort())
    // builtin 颜色不可改
    await expect(box.tags.setColor('重要', '#000000')).rejects.toThrow('颜色不可修改')
  })

  it('create + setColor + list 聚合（文件 + 产品集计数）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重点'], notes: '' })
    await box.metadata.update({ product_set: '系列A', file_name: 'a.jpg', tags: ['重点', '跟进中'] })

    await box.tags.create('重点', '#ef4444')
    await box.tags.create('跟进中', '#f59e0b')

    const tags = await box.tags.list()
    const important = tags.find((t) => t.name === '重点')
    expect(important?.color).toBe('#ef4444')
    expect(important?.count).toBe(2) // 1 文件 + 1 产品集
    const pending = tags.find((t) => t.name === '跟进中')
    expect(pending?.count).toBe(1)
  })

  it('父/子标签：create 子标签 + list 树形 + setParent 提升', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.tags.create('证书类', '#0ea5e9')
    await box.tags.create('3C', '#0ea5e9', '证书类')
    await box.tags.create('质检', '#0ea5e9', '证书类')

    const tags = await box.tags.list()
    const parent = tags.find((t) => t.name === '证书类')
    expect(parent?.children).toEqual(['3C', '质检'])
    const child = tags.find((t) => t.name === '3C')
    expect(child?.parent).toBe('证书类')

    // 子标签提升为顶层
    await box.tags.setParent('3C', null)
    const after = await box.tags.list()
    expect(after.find((t) => t.name === '3C')?.parent).toBeNull()
    expect(after.find((t) => t.name === '证书类')?.children).toEqual(['质检'])
  })

  it('父标签重命名同步子标签 parent 引用', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('证书类', '#0ea5e9')
    await box.tags.create('3C', '#0ea5e9', '证书类')

    await box.tags.rename('证书类', '资质类')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '3C')?.parent).toBe('资质类')
  })

  it('删除父标签：子标签提升为顶层，引用清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['删我'], notes: '' })
    await box.metadata.update({ product_set: '系列A', file_name: 'a.jpg', tags: ['删我', '保留'] })

    await box.tags.create('删我', '#111111')
    await box.tags.create('子删', '#222222', '删我')

    await box.tags.delete('删我')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '删我')).toBeFalsy()
    // 子标签提升为顶层
    expect(tags.find((t) => t.name === '子删')?.parent).toBeNull()
    // 引用清理
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual([])
    const meta = await box.metadata.get('系列A', 'a.jpg')
    expect(meta.tags).toEqual(['保留'])
  })

  it('rename 同步引用 + 迁移旧版 tags_state', async () => {
    const home = await tmp()
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '.qihefilemanager'), { recursive: true })
    await fsp.writeFile(
      path.join(ws, '.qihefilemanager', 'tags_state.json'),
      JSON.stringify({ colors: { 旧标: '#abcdef' } }),
    )
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['旧标'], notes: '' })

    await box.tags.rename('旧标', '新标')
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual(['新标'])
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '新标')?.color).toBe('#abcdef')
  })
})
