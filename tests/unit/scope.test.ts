/**
 * v2.4.7（§4.1 + §4.6）单测：metadata key 泛化 + files scope 机制。
 * - metadata key 泛化：产品集内格式不变；工作区内其他位置 = 工作区相对路径；工作区外空串；
 *   客户/发票区文件打标/读回/清理全链路；判读规则（首段 ∈ 四区且非实存产品集目录 → 对应区域，产品集优先兜底）
 * - files scope：fileList / importFiles / moveFiles / createSubfolder / deleteSubfolder 的
 *   'customer' 作用域（product_set 槽位承载客户名、file_type 忽略、config 写 customer_subfolders）；
 *   缺省 'productSet' 旧调用方零改动。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import { interpretMetadataKeyRegion } from '../../src/main/core/metadata'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 最小 1x1 PNG（导入时当图片处理；客户区文件用任意字节即可） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-scope-'))
}

/** 建客户目录骨架（客户/名/报价 + 合同；目录扫描为实，clients 服务未接线时测试直接建目录） */
async function setupCustomer(ws: string, name = '张三'): Promise<void> {
  await fsp.mkdir(path.join(ws, '客户', name, '报价'), { recursive: true })
  await fsp.mkdir(path.join(ws, '客户', name, '合同'), { recursive: true })
}

describe('v2.4.7 metadata key 泛化（§4.1）', () => {
  it('产品集内 key 格式不变；工作区内其他位置 = 工作区相对路径；工作区外空串', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const psFile = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    await fsp.mkdir(path.dirname(psFile), { recursive: true })
    await fsp.writeFile(psFile, 'x')
    expect(box.metadata.fileMetadataKey(psFile)).toBe('系列A/图包/主图/a.jpg')

    // 客户区 / 发票区 / 入库区 / 交换区 → 工作区相对路径
    const customerFile = path.join(ws, '客户', '张三', '报价', 'a.pdf')
    const invoiceFile = path.join(ws, '发票', '2026', 'f.pdf')
    const inboundFile = path.join(ws, '入库', '2026', 'r.pdf')
    const exchangeFile = path.join(ws, '交换区', 'd.json')
    await fsp.mkdir(path.dirname(customerFile), { recursive: true })
    await fsp.mkdir(path.dirname(invoiceFile), { recursive: true })
    await fsp.mkdir(path.dirname(inboundFile), { recursive: true })
    await fsp.mkdir(path.dirname(exchangeFile), { recursive: true })
    await Promise.all([
      fsp.writeFile(customerFile, 'x'),
      fsp.writeFile(invoiceFile, 'x'),
      fsp.writeFile(inboundFile, 'x'),
      fsp.writeFile(exchangeFile, 'x'),
    ])
    expect(box.metadata.fileMetadataKey(customerFile)).toBe('客户/张三/报价/a.pdf')
    expect(box.metadata.fileMetadataKey(invoiceFile)).toBe('发票/2026/f.pdf')
    expect(box.metadata.fileMetadataKey(inboundFile)).toBe('入库/2026/r.pdf')
    expect(box.metadata.fileMetadataKey(exchangeFile)).toBe('交换区/d.json')

    // 工作区外 → 空串；工作区根 / 产品集目录本身 → 空串
    expect(box.metadata.fileMetadataKey(path.join(os.tmpdir(), 'x.jpg'))).toBe('')
    expect(box.metadata.fileMetadataKey(ws)).toBe('')
    expect(box.metadata.fileMetadataKey(path.join(ws, '产品集'))).toBe('')
  })

  it('客户区文件：update / setTagsBatch / get / removeFileMetadata 全链路（key = 工作区相对路径）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')
    const filePath = path.join(ws, '客户', '张三', '报价', 'a.pdf')
    await fsp.writeFile(filePath, 'x')

    await box.metadata.update({ file_path: filePath, tags: ['重点'], notes: '购销合同', expiry_date: '2027-06-30' })
    const m = await box.metadata.get(filePath)
    expect(m.tags).toEqual(['重点'])
    expect(m.notes).toBe('购销合同')
    expect(m.expiry_date).toBe('2027-06-30')

    const store = await box.metadata.loadMetadataStore()
    expect(store.files['客户/张三/报价/a.pdf']).toBeTruthy()

    // 批量打标同样生效（§4.1 影响面：update/setTagsBatch/setFileMetadataBatch/removeFileMetadata 全部走泛化 key）
    const r = await box.metadata.setTagsBatch({ paths: [filePath], add: ['新标签'] })
    expect(r.updated).toBe(1)
    expect(r.failed).toHaveLength(0)
    expect((await box.metadata.get(filePath)).tags).toEqual(['重点', '新标签'])

    await box.metadata.removeFileMetadata(filePath)
    expect((await box.metadata.get(filePath)).tags).toEqual([])
  })

  it('update：工作区外文件报错文案「文件不在工作区内」', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await expect(
      box.metadata.update({ file_path: path.join(os.tmpdir(), 'outside.jpg'), tags: ['T'] }),
    ).rejects.toThrow('文件不在工作区内')
  })

  it('判读规则：四区 key → 对应区域；产品集 key / 非区域首段 → productSet；同名保留名产品集 → 产品集优先', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    const wsPath = box.workspace.currentWorkspacePath()!

    expect(await interpretMetadataKeyRegion(wsPath, '客户/张三/报价/a.pdf')).toBe('customer')
    expect(await interpretMetadataKeyRegion(wsPath, '发票/2026/f.pdf')).toBe('invoice')
    expect(await interpretMetadataKeyRegion(wsPath, '入库/2026/r.pdf')).toBe('inbound')
    expect(await interpretMetadataKeyRegion(wsPath, '交换区/d.json')).toBe('exchange')
    expect(await interpretMetadataKeyRegion(wsPath, '系列A/图包/主图/a.jpg')).toBe('productSet')
    expect(await interpretMetadataKeyRegion(wsPath, '导出/x.txt')).toBe('productSet')

    // 存量同名保留名产品集（§3.7 不强制迁移）：首段 客户 但 产品集/客户 实存 → 产品集优先
    await fsp.mkdir(path.join(wsPath, '产品集', '客户'), { recursive: true })
    expect(await interpretMetadataKeyRegion(wsPath, '客户/x.jpg')).toBe('productSet')
  })
})

describe('v2.4.7 files scope（§4.6）', () => {
  it('fileList scope=customer：列出 客户/<名>/<子文件夹> 文件并 join 标签（file_type 忽略）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')
    const dir = path.join(ws, '客户', '张三', '报价')
    const a = path.join(dir, 'a.pdf')
    const b = path.join(dir, 'b.jpg')
    await fsp.writeFile(a, 'x')
    await fsp.writeFile(b, PNG_1PX)
    await box.metadata.update({ file_path: a, tags: ['合同'] })

    const list = await box.files.fileList({
      product_set: '张三',
      file_type: 'other', // customer scope 忽略 file_type
      sub_folder: '报价',
      scope: 'customer',
    })
    expect(list.map((f) => f.name).sort()).toEqual(['a.pdf', 'b.jpg'])
    const aEntry = list.find((f) => f.name === 'a.pdf')
    expect(aEntry?.tags).toEqual(['合同'])
    expect(aEntry?.path).toBe(a)

    // 未建的子文件夹 → 空列表（与产品集语义一致）
    const empty = await box.files.fileList({ product_set: '张三', file_type: 'other', sub_folder: '不存在', scope: 'customer' })
    expect(empty).toHaveLength(0)
  })

  it('importFiles scope=customer：归档到 客户/<名>/<子文件夹>，命名模板 product_set 槽位 = 客户名', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')

    const src = path.join(ws, '..', 'contract.pdf')
    await fsp.writeFile(src, 'pdf-bytes')
    const r = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '张三',
      target_folder: '报价',
      target_type: 'image', // customer scope 忽略
      sub_folder: '报价',
      scope: 'customer',
    })
    expect(r.imported).toHaveLength(1)
    expect(r.failed).toHaveLength(0)
    // v2.4.9 S5：默认模板含 sequence——单文件批次编号 '1'
    expect(r.imported[0].name).toBe('张三_报价_contract_1.pdf')

    const dest = path.join(ws, '客户', '张三', '报价', '张三_报价_contract_1.pdf')
    await expect(fsp.stat(dest)).resolves.toBeTruthy()
    expect(box.metadata.fileMetadataKey(dest)).toBe('客户/张三/报价/张三_报价_contract_1.pdf')
  })

  it('importFiles scope=supplier：归档到 供应商/<名>/<子文件夹>，命名模板 product_set 槽位 = 供应商名（v2.5.5 对齐对称用例）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await fsp.mkdir(path.join(ws, '供应商', '恒通', '合同'), { recursive: true })

    const src = path.join(ws, '..', 'statement.pdf')
    await fsp.writeFile(src, 'pdf-bytes')
    const r = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '恒通',
      target_folder: '对账单',
      target_type: 'image', // supplier scope 忽略
      sub_folder: '对账单',
      scope: 'supplier',
    })
    expect(r.imported).toHaveLength(1)
    expect(r.failed).toHaveLength(0)
    // v2.4.9 S5：默认模板含 sequence——单文件批次编号 '1'
    expect(r.imported[0].name).toBe('恒通_对账单_statement_1.pdf')

    const dest = path.join(ws, '供应商', '恒通', '对账单', '恒通_对账单_statement_1.pdf')
    await expect(fsp.stat(dest)).resolves.toBeTruthy()
    expect(box.metadata.fileMetadataKey(dest)).toBe('供应商/恒通/对账单/恒通_对账单_statement_1.pdf')
  })

  it('moveFiles scope=customer：结构化目标 = 客户/<名>/<子文件夹>（target_type 忽略），元数据随路径迁移', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')
    const src = path.join(ws, '客户', '张三', '报价', 'a.pdf')
    await fsp.writeFile(src, 'x')
    await box.metadata.update({ file_path: src, tags: ['合同'] })

    const r = await box.files.moveFiles({
      paths: [src],
      scope: 'customer',
      target_product_set: '张三',
      sub_folder: '合同',
      // 不传 target_type：customer scope 不依赖
    })
    expect(r.moved).toHaveLength(1)
    expect(r.failed).toHaveLength(0)

    const dest = path.join(ws, '客户', '张三', '合同', 'a.pdf')
    await expect(fsp.stat(dest)).resolves.toBeTruthy()
    // 元数据 key 迁移：客户/张三/报价/a.pdf → 客户/张三/合同/a.pdf
    const store = await box.metadata.loadMetadataStore()
    expect(store.files['客户/张三/报价/a.pdf']).toBeUndefined()
    expect(store.files['客户/张三/合同/a.pdf']?.tags).toEqual(['合同'])
  })

  it('createSubfolder scope=customer：建 客户/<名>/<子文件夹> + config.customer_subfolders 写入', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')

    await box.files.createSubfolder({ product_set: '张三', file_type: 'image', name: '样品', scope: 'customer' })
    await expect(fsp.stat(path.join(ws, '客户', '张三', '样品'))).resolves.toBeTruthy()
    let cfg = await box.workspace.loadConfig()
    expect(cfg.customer_subfolders).toContain('样品')

    // 重复创建 → 拒绝
    await expect(
      box.files.createSubfolder({ product_set: '张三', file_type: 'image', name: '样品', scope: 'customer' }),
    ).rejects.toThrow('子文件夹已存在')

    // 产品集语义不变（缺省 scope='productSet'）
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.files.createSubfolder({ product_set: '系列A', file_type: 'image', name: '新图包' })
    cfg = await box.workspace.loadConfig()
    expect(cfg.image_subfolders).toContain('新图包')
    expect(cfg.customer_subfolders).not.toContain('新图包')
  })

  it('deleteSubfolder scope=customer：目录移入回收站 + config.customer_subfolders 移除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await setupCustomer(ws, '张三')

    await box.files.createSubfolder({ product_set: '张三', file_type: 'image', name: '样品', scope: 'customer' })
    await box.files.deleteSubfolder({ product_set: '张三', file_type: 'image', name: '样品', scope: 'customer' })

    await expect(fsp.stat(path.join(ws, '客户', '张三', '样品'))).rejects.toBeTruthy()
    const cfg = await box.workspace.loadConfig()
    expect(cfg.customer_subfolders).not.toContain('样品')
    // 回收站条目（kind=subfolder，恢复逻辑按原路径首段回填 customer_subfolders）
    const items = await box.trash.list()
    expect(items.some((i) => i.kind === 'subfolder' && i.originalPath.includes('客户'))).toBe(true)
  })

  it('旧调用方零改动：缺省 scope 走产品集路径（fileList / moveFiles / createSubfolder）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const src = path.join(ws, '产品集', '系列A', '图包', '主图', 'a.jpg')
    await fsp.mkdir(path.dirname(src), { recursive: true })
    await fsp.writeFile(src, PNG_1PX)

    const list = await box.files.fileList({ product_set: '系列A', file_type: 'image', sub_folder: '主图' })
    expect(list.map((f) => f.name)).toEqual(['a.jpg'])

    const r = await box.files.moveFiles({
      paths: [src],
      target_product_set: '系列A',
      target_type: 'image',
      sub_folder: '白底图',
    })
    expect(r.moved).toHaveLength(1)
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '图包', '白底图', 'a.jpg'))).resolves.toBeTruthy()
  })
})
