import { describe, it, expect } from 'vitest'
import { isPathInsideWorkspace, thumbnailPath, productSetFromFilePath, defaultWorkspaceConfig } from '../../src/main/core/paths'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-path-'))
}

describe('isPathInsideWorkspace', () => {
  it('工作区内路径通过', () => {
    expect(isPathInsideWorkspace('/a/b', '/a/b/c/d.jpg')).toBe(true)
    expect(isPathInsideWorkspace('/a/b', '/a/b')).toBe(true)
  })
  it('越界路径拒绝（含前缀欺骗）', () => {
    expect(isPathInsideWorkspace('/a/b', '/a/bc/x.jpg')).toBe(false)
    expect(isPathInsideWorkspace('/a/b', '/a')).toBe(false)
    expect(isPathInsideWorkspace('/a/b', '/c/d')).toBe(false)
  })
})

describe('thumbnailPath 兼容性', () => {
  it('路径结构 = .qihefilemanager/.thumbnails/<hash前2>/<hash><ext>.thumb.jpg', () => {
    const t = thumbnailPath('/ws', '/ws/产品集/A/主图/图.jpg')
    const rel = path.relative('/ws/.qihefilemanager/.thumbnails', t)
    const parts = rel.split(path.sep)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveLength(2) // hash 前 2 位
    expect(parts[1]).toMatch(/^[0-9a-f]{32}\.jpg\.thumb\.jpg$/)
  })
  it('同路径哈希稳定', () => {
    expect(thumbnailPath('/ws', '/x/y.jpg')).toBe(thumbnailPath('/ws', '/x/y.jpg'))
  })
})

describe('productSetFromFilePath', () => {
  it('提取产品集名', () => {
    expect(productSetFromFilePath('/ws', '/ws/产品集/夏季系列/图包/主图/a.jpg')).toBe('夏季系列')
  })
  it('非产品集路径返回空', () => {
    expect(productSetFromFilePath('/ws', '/ws/导出/a.jpg')).toBe('')
    expect(productSetFromFilePath('/ws', '/other/a.jpg')).toBe('')
  })
})

describe('工作区全链路（对照原 app_test.go）', () => {
  it('建工作区 → 建产品集（8 子目录）→ 配置 → recents', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)

    // 建工作区
    const info = await box.workspace.create(ws)
    expect(info.name).toBe(path.basename(ws))

    // 默认配置
    const cfg = await box.workspace.getConfig()
    expect(cfg.image_subfolders).toEqual(['主图', '详情页', '白底图', '素材'])
    expect(cfg.cert_subfolders).toEqual(['3C', '质检', '专利'])

    // 建产品集 → 默认子目录结构
    const ps = await box.workspace.productSetCreate({ name: '夏季T恤系列' })
    expect(ps.name).toBe('夏季T恤系列')
    const psRoot = path.join(ws, '产品集', '夏季T恤系列')
    for (const sub of cfg.image_subfolders) {
      const d = path.join(psRoot, '图包', sub)
      expect((await fsp.stat(d)).isDirectory()).toBe(true)
    }
    for (const sub of cfg.cert_subfolders) {
      const d = path.join(psRoot, '证书', sub)
      expect((await fsp.stat(d)).isDirectory()).toBe(true)
    }

    // recents 记录
    const recents = await box.workspace.loadRecentWorkspaces()
    expect(recents).toContain(ws)

    // 当前工作区
    const cur = await box.workspace.current()
    expect(cur?.path).toBe(ws)
  })

  it('产品集列表统计数量', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'B系列' })
    await box.workspace.productSetCreate({ name: 'A系列', tags: ['重要'], notes: '备注' })

    const list = await box.workspace.productSetList()
    expect(list.map((p) => p.name).sort()).toEqual(['A系列', 'B系列'])
    const a = list.find((p) => p.name === 'A系列')
    expect(a?.tags).toEqual(['重要'])
    expect(a?.notes).toBe('备注')
  })

  it('删除产品集后元数据清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '待删' })

    // 写入一条元数据
    await box.metadata.update({ product_set: '待删', file_name: 'a.jpg', cert_type: '3C' })

    await box.deleteProductSet('待删')
    const dir = path.join(ws, '产品集', '待删')
    await expect(fsp.stat(dir)).rejects.toThrow()
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toHaveLength(0)
  })
})
