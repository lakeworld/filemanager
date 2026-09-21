/**
 * v2.5.9（A9 刀4）：老工作区体检——「模板表 vs 盘上实际」的差额清单
 *
 * 为什么需要它：A9 把子文件夹名单改成**以盘为准**之后，界面上会**突然多出**一批
 * 以前看不见的目录（盘上有、全局表里没登记过的）。聚合页（图包库/证书库）改成以盘为准
 * 之前，得先让用户看清自己的存量到底长什么样，否则"改完突然多出一堆"没法解释。
 *
 * 本判据钉四件事：
 *   ① 盘上有、表里没有 ⇒ `unregistered`（这就是"会突然出现"的那批，逐实体点名）
 *   ② 表里有、任何实体盘上都没有 ⇒ `templateOnly`（模板里的死条目，新建时才生效）
 *   ③ 盘上真实为空的目录 ⇒ `emptyFolders`（A9 之后会淡显，用户该先知道有哪些）
 *   ④ 干净工作区 ⇒ 三项全空（不误报：占位/隐藏目录/普通文件都不算）
 */
import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { auditSubfolderDrift } from '../../src/main/core/healthAudit'

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-health-'))
}

describe('healthAudit · 模板表与盘上的差额', () => {
  it('干净工作区：三项全空（不误报）', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '主图'), { recursive: true })
    await fsp.writeFile(path.join(ws, '产品集', '甲集', '图包', '主图', 'a.png'), 'x')
    const r = await auditSubfolderDrift(ws, {
      image_subfolders: ['主图'],
      cert_subfolders: [],
      doc_subfolders: [],
      customer_subfolders: [],
      supplier_subfolders: [],
    })
    expect(r.unregistered).toEqual([])
    expect(r.templateOnly).toEqual([])
    expect(r.emptyFolders).toEqual([])
    expect(r.scannedEntities).toBe(1)
  })

  it('① 盘上有、表里没有 ⇒ unregistered（逐实体点名，这就是"会突然出现"的那批）', async () => {
    const ws = await tmp()
    // 甲集：表里只有主图，盘上却还有「场景图」（用户手工建的/网盘同步进来的）
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '主图'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '场景图'), { recursive: true })
    await fsp.writeFile(path.join(ws, '产品集', '甲集', '图包', '场景图', 'b.png'), 'x')
    const r = await auditSubfolderDrift(ws, {
      image_subfolders: ['主图'],
      cert_subfolders: [],
      doc_subfolders: [],
      customer_subfolders: [],
      supplier_subfolders: [],
    })
    expect(r.unregistered).toEqual([
      { scope: 'productSet', entity: '甲集', kind: 'image', name: '场景图' },
    ])
  })

  it('② 表里有、任何实体盘上都没有 ⇒ templateOnly（模板死条目）', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '主图'), { recursive: true })
    const r = await auditSubfolderDrift(ws, {
      image_subfolders: ['主图', '场景图'], // 场景图登记了，但盘上不存在
      cert_subfolders: [],
      doc_subfolders: [],
      customer_subfolders: [],
      supplier_subfolders: [],
    })
    expect(r.templateOnly).toEqual(['场景图'])
    expect(r.unregistered).toEqual([])
  })

  it('③ 空目录进 emptyFolders（A9 后会淡显，用户该先知道）', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '主图'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '空夹'), { recursive: true })
    await fsp.writeFile(path.join(ws, '产品集', '甲集', '图包', '空夹', '.DS_Store'), 'x') // 点文件不算"有文件"
    const r = await auditSubfolderDrift(ws, { image_subfolders: ['主图', '空夹'] })
    // 两个都空（主图本轮没放文件、空夹只放了 .DS_Store）⇒ 都该进清单；
    // 且**在表里也不是豁免理由**——A9 之后空目录一样显示（只是淡一档）。
    expect(r.emptyFolders).toEqual([
      // 名称序（拼音）：空夹 kong < 主图 zhu——报告要能直接念，不能是 readdir 的机器序
      { scope: 'productSet', entity: '甲集', kind: 'image', name: '空夹' },
      { scope: 'productSet', entity: '甲集', kind: 'image', name: '主图' },
    ])
  })

  it('④ 三域 + 客户/供应商都扫（证书/文档/客户/供应商不得漏）', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '证书', '质检'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '文档', '参数表'), { recursive: true })
    await fsp.mkdir(path.join(ws, '客户', '华东客户', '报价'), { recursive: true })
    await fsp.mkdir(path.join(ws, '客户', '华东客户', '手工夹'), { recursive: true })
    await fsp.mkdir(path.join(ws, '供应商', '北方厂', '合同'), { recursive: true })
    await fsp.mkdir(path.join(ws, '供应商', '北方厂', '手工夹'), { recursive: true })
    await fsp.writeFile(path.join(ws, '供应商', '北方厂', '手工夹', 'x.pdf'), 'x')
    const r = await auditSubfolderDrift(ws, {
      cert_subfolders: ['质检'],
      doc_subfolders: ['参数表'],
      customer_subfolders: ['报价'],
      supplier_subfolders: ['合同'],
    })
    expect(r.unregistered).toEqual([
      { scope: 'customer', entity: '华东客户', kind: 'customer', name: '手工夹' },
      { scope: 'supplier', entity: '北方厂', kind: 'supplier', name: '手工夹' },
    ])
    expect(r.scannedEntities).toBe(3) // 1 产品集 + 1 客户 + 1 供应商
  })

  it('隐藏目录/普通文件/符号链接不计入（复用 listActualSubfolders 的同一口径）', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '.tmp'), { recursive: true })
    await fsp.writeFile(path.join(ws, '产品集', '甲集', '图包', '散文件.txt'), 'x')
    await fsp.symlink('/nonexistent', path.join(ws, '产品集', '甲集', '图包', '断链'))
    const r = await auditSubfolderDrift(ws, { image_subfolders: [] })
    expect(r.unregistered).toEqual([])
    expect(r.emptyFolders).toEqual([])
  })
})
