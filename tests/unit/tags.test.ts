import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-'))
}

/** 内置固定色标签名（与 core/tags.ts BUILTIN_TAGS 保持一致） */
const BUILTIN_NAMES = ['重要', '待更新', '已更新', '问题', '归档']

/** 系列A/图包/主图/a.jpg 的绝对路径（元数据按路径推导 key；文件无需真实存在） */
const metaPath = (ws: string, name = 'a.jpg'): string =>
  path.join(ws, '产品集', '系列A', '图包', '主图', name)

describe('标签体系（v2.0.2 / v2.3.2 迁移）', () => {
  it('首次 list() 一次性迁移：清除内置固定色标签定义与引用，写入迁移标记', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 构造含 builtin 定义的 tags.json + 引用内置名的 metadata / product_sets
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重要', '自定义'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重要', '待更新', '野生标'] })
    await fsp.writeFile(
      path.join(ws, '.qihefilemanager', 'tags.json'),
      JSON.stringify({
        重要: { color: '#ef4444', builtin: true },
        待更新: { color: '#f97316', builtin: true },
        已更新: { color: '#22c55e', builtin: true },
        问题: { color: '#eab308', builtin: true },
        归档: { color: '#64748b', builtin: true },
        自定义: { color: '#123456' },
      }),
    )

    const tags = await box.tags.list()
    // 内置 5 色不再出现（定义已删、引用已清）
    for (const n of BUILTIN_NAMES) {
      expect(tags.find((t) => t.name === n)).toBeFalsy()
    }
    // 非内置自定义标签保留
    expect(tags.find((t) => t.name === '自定义')?.defined).toBe(true)
    // 引用清理：文件与产品集的 tags 不再含内置名
    const meta = await box.metadata.get(metaPath(ws))
    expect(meta.tags).toEqual(['野生标'])
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual(['自定义'])
    // 迁移标记写入且不暴露为真实标签
    const defs = JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'tags.json'), 'utf-8'))
    expect(defs._migrated_builtin).toEqual({ color: '' })
    expect(tags.find((t) => t.name === '_migrated_builtin')).toBeFalsy()
  })

  it('第二次 list() 不再补全任何标签（新建标签不会被覆盖/补回）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list() // 首次触发迁移（写入标记）

    await box.tags.create('用户标签', '#123456')
    const tags = await box.tags.list() // 第二次：不应再补全内置标签
    expect(tags.find((t) => t.name === '用户标签')?.defined).toBe(true)
    for (const n of BUILTIN_NAMES) {
      expect(tags.find((t) => t.name === n)).toBeFalsy()
    }
  })

  it('迁移标记键：不暴露为真实标签，create 拒绝同名', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list()
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '_migrated_builtin')).toBeFalsy()
    await expect(box.tags.create('_migrated_builtin', '#000000')).rejects.toThrow('系统保留')
  })

  it('删除标签后不再复活（含用户自建的同名内置色标签）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list() // 迁移完成，无内置标签
    await box.tags.create('重要', '#ef4444') // 用户可自由重建同名标签
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重要'] })

    await box.tags.delete('重要')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '重要')).toBeFalsy()
    // 再次 list 仍不出现（不复活）
    const again = await box.tags.list()
    expect(again.find((t) => t.name === '重要')).toBeFalsy()
  })

  it('颜色均可改（不再有固定色不可改限制）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list()
    await box.tags.create('重要', '#ef4444')
    await box.tags.setColor('重要', '#000000')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '重要')?.color).toBe('#000000')
  })

  it('create + setColor + list 聚合（文件 + 产品集计数）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重点'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重点', '跟进中'] })

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
    await box.metadata.update({ file_path: metaPath(ws), tags: ['删我', '保留'] })

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
    const meta = await box.metadata.get(metaPath(ws))
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

  it('孤儿标签：未定义但被引用 → list 返回 defined:false 可治理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 历史自由输入 / AI 打标引入的未定义标签
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['野生标', '另一个野生'] })

    const tags = await box.tags.list()
    const orphan = tags.find((t) => t.name === '野生标')
    expect(orphan).toBeTruthy()
    expect(orphan?.defined).toBe(false)
    expect(orphan?.color).toBe('#94a3b8') // 默认灰
    expect(orphan?.count).toBe(2)
    expect(orphan?.parent).toBeNull()
    const orphan2 = tags.find((t) => t.name === '另一个野生')
    expect(orphan2?.defined).toBe(false)
    // 内置标签不再自动出现（v2.3.2 起无内置补全）
    expect(tags.find((t) => t.name === '重要')).toBeFalsy()
  })

  it('adopt 孤儿标签：补定义，引用不动，颜色生效', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })

    await box.tags.adopt('野生标', '#ef4444')
    const tags = await box.tags.list()
    const t = tags.find((x) => x.name === '野生标')
    expect(t?.defined).toBe(true)
    expect(t?.color).toBe('#ef4444')
    // 引用仍在
    expect(t?.count).toBe(1)
    // 未使用标签不可 adopt
    await expect(box.tags.adopt('不存在的', '#000000')).rejects.toThrow('未被使用')
  })

  it('delete 孤儿标签：仅清理引用（定义不存在时跳过定义删除）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })

    await box.tags.delete('野生标')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '野生标')).toBeFalsy()
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual([])
  })
})
