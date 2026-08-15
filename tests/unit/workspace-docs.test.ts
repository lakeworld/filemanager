import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-ws-docs-'))
}

const TXT = Buffer.from('fake text bytes')

describe('产品集文档目录——workspace 侧（v2.5.1 F1）', () => {
  it('productSetCreate：自动建 文档/ 及其默认子文件夹，doc_count=0', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const info = await box.workspace.productSetCreate({ name: '系列A' })
    expect(info.doc_count).toBe(0)
    // 默认 doc_subfolders 子目录全部建出
    for (const sub of ['说明书', '参数表', '质检报告']) {
      await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', sub))).resolves.toBeTruthy()
    }
  })

  it('productSetList / productSetStats：doc_count 统计文档文件数', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 放 2 个文件到 文档/说明书（含子目录递归 1 个）
    const sub = path.join(ws, '产品集', '系列A', '文档', '说明书')
    await fsp.writeFile(path.join(sub, 'a.md'), TXT)
    await fsp.writeFile(path.join(sub, 'b.txt'), TXT)
    await fsp.mkdir(path.join(sub, '附图'), { recursive: true })
    await fsp.writeFile(path.join(sub, '附图', 'c.pdf'), TXT)

    const list = await box.workspace.productSetList()
    expect(list[0].doc_count).toBe(3)

    const stats = await box.workspace.productSetStats('系列A')
    expect(stats.doc_count).toBe(3)
  })

  it('renameSubfolder(type=doc)：迁移所有产品集的 文档/<old> → <new> 并更新配置', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })
    // 系列B 不建该子目录（懒建场景）
    await fsp.writeFile(path.join(ws, '产品集', '系列A', '文档', '说明书', 'a.md'), TXT)

    const cfg = await box.workspace.renameSubfolder('doc', '说明书', '使用说明')
    expect(cfg.doc_subfolders).toContain('使用说明')
    expect(cfg.doc_subfolders).not.toContain('说明书')
    // 系列A 目录真实迁移
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', '使用说明', 'a.md'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', '说明书'))).rejects.toBeTruthy()
    // 系列B 未建源目录 → 静默跳过（幂等）
  })

  it('loadConfig：旧配置缺 doc_subfolders → 合并默认值并写回（向后兼容）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 手工写一个缺 doc_subfolders 的旧配置
    const cfgPath = path.join(ws, '.qihefilemanager', 'config.json')
    const old = {
      name: 'Workspace',
      naming_template: { sku_fields: [], conflict_suffix: '_副本' },
      image_subfolders: ['主图'],
      cert_subfolders: ['3C'],
    }
    await fsp.mkdir(path.dirname(cfgPath), { recursive: true })
    await fsp.writeFile(cfgPath, JSON.stringify(old))

    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.doc_subfolders).toEqual(['说明书', '参数表', '质检报告'])
    // 写回磁盘
    const onDisk = JSON.parse(await fsp.readFile(cfgPath, 'utf-8'))
    expect(onDisk.doc_subfolders).toEqual(['说明书', '参数表', '质检报告'])
  })
})
