import { describe, it, expect } from 'vitest'
import { isPathInsideWorkspace, thumbnailPath, productSetFromFilePath, defaultWorkspaceConfig, readJsonFile } from '../../src/main/core/paths'
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

describe('readJsonFile 损坏备份（v2.5 P1-C1/B2）', () => {
  it('文件存在但 JSON 损坏 → 备份 .corrupt-<ts> 后返回 null', async () => {
    const dir = await tmp()
    const p = path.join(dir, 'data.json')
    await fsp.writeFile(p, '{bad json')
    expect(await readJsonFile(p)).toBeNull()
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('data.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe('{bad json')
  })

  it('文件缺失 → 返回 null 且不产生备份', async () => {
    const dir = await tmp()
    const p = path.join(dir, 'missing.json')
    expect(await readJsonFile(p)).toBeNull()
    expect(await fsp.readdir(dir)).toEqual([])
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

  it('删除产品集：目录移入回收站，元数据保留；彻底删除后才清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '待删' })

    // 写入一条元数据
    await box.metadata.update({ file_path: path.join(ws, '产品集', '待删', '图包', '主图', 'a.jpg'), cert_type: '3C' })

    await box.deleteProductSet('待删')
    const dir = path.join(ws, '产品集', '待删')
    await expect(fsp.stat(dir)).rejects.toThrow()
    // v2.3.1 回收站：删除时元数据保留（恢复可还原）
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('productSet')
    let store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toHaveLength(1)

    // 彻底删除后才清理
    await box.trash.purge(entries[0].id)
    store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toHaveLength(0)
  })

  // —— v2.2.1：子文件夹重命名 + 同步迁移已有产品集 ——
  it('子文件夹重命名：迁移所有产品集目录 + 更新配置', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    const cfg = await box.workspace.renameSubfolder('image', '主图', '场景图')
    expect(cfg.image_subfolders).toContain('场景图')
    expect(cfg.image_subfolders).not.toContain('主图')

    // 两个产品集的图包目录都已迁移
    for (const ps of ['系列A', '系列B']) {
      const oldDir = path.join(ws, '产品集', ps, '图包', '主图')
      await expect(fsp.stat(oldDir)).rejects.toThrow()
      const newDir = path.join(ws, '产品集', ps, '图包', '场景图')
      expect((await fsp.stat(newDir)).isDirectory()).toBe(true)
    }
    // 证书目录不受影响
    const certDir = path.join(ws, '产品集', '系列A', '证书', '3C')
    expect((await fsp.stat(certDir)).isDirectory()).toBe(true)
  })

  it('子文件夹重命名：重名拒绝 + 不存在的旧名拒绝 + 幂等', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 重名拒绝
    await expect(box.workspace.renameSubfolder('image', '主图', '详情页')).rejects.toThrow('已存在')
    // 旧名不存在拒绝
    await expect(box.workspace.renameSubfolder('image', '不存在的', '新名')).rejects.toThrow('不存在')
    // 同名（old === new）幂等返回
    const cfg = await box.workspace.renameSubfolder('image', '主图', '主图')
    expect(cfg.image_subfolders).toContain('主图')
    // 未建子目录的产品集不报错（源不存在跳过）
    await box.workspace.productSetCreate({ name: '空集' })
    const cfg2 = await box.workspace.renameSubfolder('cert', '3C', 'CCC')
    expect(cfg2.cert_subfolders).toContain('CCC')
  })

  it('v2.4.7：工作区根目录保留名拦截（产品集新建/重命名，不区分大小写）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 新建拦截：保留名一律拒绝（中文保留名 + 大小写变体）
    for (const bad of ['客户', '发票', '入库', '交换区', '产品集', '图包', '证书', '导出']) {
      await expect(box.workspace.productSetCreate({ name: bad })).rejects.toThrow('保留')
    }
    await expect(box.workspace.productSetCreate({ name: '客户' })).rejects.toThrow('保留')
    // 重命名拦截：既有产品集不可改名为保留名
    await expect(box.workspace.renameProductSet('系列A', '发票')).rejects.toThrow('保留')
    // 非保留名照常可用
    const ok = await box.workspace.productSetCreate({ name: '正常集' })
    expect(ok.name).toBe('正常集')
  })

  it('v2.5（P1-B2）：config.json 损坏 → loadConfig 返回默认值并备份原文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const p = path.join(ws, '.qihefilemanager', 'config.json')
    await fsp.writeFile(p, '{"name": "坏')
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.name).toBe('Workspace') // 降级默认值，不再静默覆盖
    const dir = path.join(ws, '.qihefilemanager')
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe('{"name": "坏')
  })
})
