/**
 * 全局搜索单测（v2.4.0）：文件名 / 产品集名关键词命中、空查询行为。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-search-'))
}

/** 最小 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 建工作区 + 两个产品集 + 各自导入一张图（图包/主图 为默认子文件夹） */
async function buildSearchBox() {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  await box.workspace.productSetCreate({ name: '系列A' })
  await box.workspace.productSetCreate({ name: '系列B' })
  const srcA = path.join(ws, '..', '红色毛衣.jpg')
  await fsp.writeFile(srcA, PNG_1PX)
  const srcB = path.join(ws, '..', '蓝色衬衫.jpg')
  await fsp.writeFile(srcB, PNG_1PX)
  await box.files.importFiles({
    source_paths: [srcA, srcB],
    target_product_set: '系列A',
    target_folder: '主图',
    target_type: 'image',
    sub_folder: '主图',
  })
  return { box, ws }
}

describe('全局搜索（SearchService）', () => {
  it('文件名关键词命中：返回文件并带上所属产品集', async () => {
    const { box } = await buildSearchBox()
    // 导入时命名模板会重命名（v2.4.9 S5 后为 系列A_主图_红色毛衣_1.jpg），用包含匹配
    const r1 = await box.search.search('毛衣')
    expect(r1.files.map((f) => f.name).some((n) => n.includes('红色毛衣'))).toBe(true)
    expect(r1.product_sets.map((p) => p.name)).toContain('系列A')

    const r2 = await box.search.search('衬衫')
    expect(r2.files.map((f) => f.name).some((n) => n.includes('蓝色衬衫'))).toBe(true)
  })

  it('产品集名关键词命中（该集无文件匹配时也返回产品集）', async () => {
    const { box } = await buildSearchBox()

    const r = await box.search.search('系列B')
    expect(r.product_sets.map((p) => p.name)).toContain('系列B')
    // 无文件命中
    expect(r.files).toHaveLength(0)
  })

  it('空查询 / 纯空白：返回空结果不抛错', async () => {
    const { box } = await buildSearchBox()

    expect(await box.search.search('')).toEqual({ files: [], product_sets: [] })
    const blank = await box.search.search('   ')
    expect(blank.files).toHaveLength(0)
    expect(blank.product_sets).toHaveLength(0)
  })
})

describe('供应商/报价区文件命中（v2.4.9 §6.2）', () => {
  it('供应商/<名>/<子文件夹> 与 报价/<YYYY>/ 原件按文件名命中，path 自明来源区域', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await fsp.mkdir(path.join(ws, '供应商', '供应商A', '合同'), { recursive: true })
    await fsp.mkdir(path.join(ws, '供应商', '供应商A', '对账单'), { recursive: true })
    await fsp.mkdir(path.join(ws, '报价', '2026'), { recursive: true })
    await fsp.writeFile(path.join(ws, '供应商', '供应商A', '合同', '供应商A采购合同.pdf'), '%PDF-1.4')
    await fsp.writeFile(path.join(ws, '供应商', '供应商A', '对账单', '供应商A对账单.txt'), 'x')
    await fsp.writeFile(path.join(ws, '报价', '2026', '报价单QT-2026001.pdf'), '%PDF-1.4')

    const r1 = await box.search.search('采购合同')
    expect(r1.files.some((f) => f.name === '供应商A采购合同.pdf' && f.path.includes('供应商'))).toBe(true)
    const r2 = await box.search.search('对账单')
    expect(r2.files.some((f) => f.name === '供应商A对账单.txt' && f.path.includes('供应商'))).toBe(true)
    const r3 = await box.search.search('报价单QT')
    expect(r3.files.some((f) => f.name === '报价单QT-2026001.pdf' && f.path.includes('报价'))).toBe(true)
    // 供应商/报价台账记录不进全局搜索（同发票：只搜文件本体）
    const r4 = await box.search.search('供应商A')
    expect(r4.files.length).toBeGreaterThan(0)
  })
})

describe('搜索命中标签（v2.4.4 T1）', () => {
  it('文件标签命中：返回文件并附带 tags 供展示', async () => {
    const { box, ws } = await buildSearchBox()
    // 给「系列A」导入的图片打标（按名字定位，readdir 顺序不稳定）
    const setList = await box.workspace.productSetList()
    const setA = setList.find((s) => s.name === '系列A')!
    const fileList = await box.files.fileList({
      product_set: setA.name,
      file_type: 'image',
      sub_folder: '主图',
    })
    expect(fileList.length).toBeGreaterThan(0)
    const target = fileList.find((f) => f.name.includes('红色毛衣'))!
    // T2：文件列表附带 tags（先打标后 list 应带上）
    await box.metadata.update({ file_path: target.path, tags: ['红色毛衣', '主打款'] })
    const relisted = await box.files.fileList({
      product_set: setA.name,
      file_type: 'image',
      sub_folder: '主图',
    })
    expect(relisted.find((f) => f.name.includes('红色毛衣'))!.tags).toEqual(['红色毛衣', '主打款'])

    // 文件名不含关键词但标签命中
    const r = await box.search.search('主打款')
    expect(r.files.map((f) => f.name).some((n) => n.includes('红色毛衣'))).toBe(true)
    expect(r.files.find((f) => f.name.includes('红色毛衣'))!.tags).toContain('主打款')
    expect(r.product_sets.map((p) => p.name)).toContain('系列A')
  })

  it('产品集标签命中：产品集 tags 含关键词即返回（无需文件命中）', async () => {
    const { box } = await buildSearchBox()
    const setList = await box.workspace.productSetList()
    const setB = setList.find((s) => s.name === '系列B')!
    await box.workspace.updateProductSetInfo({ name: setB.name, tags: ['外贸主力'], notes: '' })

    const r = await box.search.search('外贸')
    expect(r.product_sets.map((p) => p.name)).toContain('系列B')
    // 产品集信息附带真实 tags（不再硬编码空数组）
    const hit = r.product_sets.find((p) => p.name === '系列B')!
    expect(hit.tags).toContain('外贸主力')
  })
})
