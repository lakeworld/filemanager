/**
 * 供应商服务单测（v2.4.9 S2）
 * 覆盖（brief §六 9 组）：
 * 1. create：同名查重拒绝（既有档案/既有目录）；正常创建建目录 + 固定子文件夹 合同/对账单/往来文件 + 档案
 * 2. update：字段更新持久化 + updated_at 刷新；list() 返回一致
 * 3. rename：目录迁移 + 档案 key 迁移 + inbound.supplier_id 级联；新名冲突拒绝；有文件不可重命名
 * 4. delete→restore→purge：kind=supplier；restore 复原目录（含固定子文件夹）+ 档案；purge 四清理
 *    （目录 + metadata 前缀 + 缩略图 + suppliers.json 条目）且 inbound.supplier_id 留字面值不级联
 * 5. trash 全链路：trashItem/restore/purge supplier 分支（档案缺失时 restore 补回）
 * 6. list：名称排序 + file_count 递归计数（隐藏文件不计）
 * 7. inbound 带 supplier_id 存在性不硬校验（删除供应商后编辑旧入库单放行）
 * 8. 区域判别：interpretMetadataKeyRegion 供应商 key → 'supplier'；同名产品集优先逻辑同客户
 * 9. Logger 注入断言：create/rename 调用 logger.info（S6 core 接口）
 * 10. 关联产品集（v2.4.9 打磨 M8）：linkRelation/unlinkRelation（校验产品集存在、去重、档案持久化）；
 *     create/update 带不存在产品集拒绝、带合法集透传（update 去重）
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { WorkspaceService } from '../../src/main/core/workspace'
import { SuppliersService, resolveSupplierSyncProfile } from '../../src/main/core/suppliers'
import { MemoryLogger } from '../../src/main/core/logger'
import { interpretMetadataKeyRegion } from '../../src/main/core/metadata'
import { BoxService } from '../../src/main/core'
import type { ThumbnailProvider } from '../../src/main/core/files'
import type { InboundCreateRequest } from '../../src/main/core/inbound'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-suppliers-'))
}

async function readSuppliersStore(ws: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'suppliers.json'), 'utf-8'))
}

async function readInboundStore(ws: string): Promise<{ records: Record<string, { supplier_id?: string }> }> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'inbound.json'), 'utf-8'))
}

/** 在 供应商/<name>/<sub>/ 下写一个文件，返回绝对路径 */
async function addSupplierFile(ws: string, name: string, sub: string, file: string): Promise<string> {
  const dir = path.join(ws, '供应商', name, sub)
  await fsp.mkdir(dir, { recursive: true })
  const p = path.join(dir, file)
  await fsp.writeFile(p, 'file-bytes')
  return p
}

function inboundReq(overrides: Partial<InboundCreateRequest> = {}): InboundCreateRequest {
  return { id: 'IN-001', date: '2026-08-11', supplier: '甲', file_path: '入库/2026/IN-001.pdf', ...overrides }
}

/** 记录 removeThumbnails 调用的假缩略图实现（purge 缩略图清理断言用） */
class RecordingThumbs implements ThumbnailProvider {
  removed: string[] = []
  async ensureThumbnail(): Promise<string> {
    return ''
  }
  async thumbnailUrl(): Promise<string> {
    return ''
  }
  async removeThumbnail(): Promise<void> {}
  async removeThumbnails(files: string[]): Promise<void> {
    this.removed.push(...files)
  }
  async removeThumbnailsInDir(): Promise<void> {}
}

describe('供应商服务（v2.4.9 S2）', () => {
  it('create：同名查重拒绝（既有档案/既有目录）；正常创建建目录 + 固定子文件夹 + 档案', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const created = await box.suppliers.create({ name: '甲', contact: '王工', phone: '138', tags: ['重点'] })
    expect(created.name).toBe('甲')
    expect(created.contact).toBe('王工')
    expect(created.phone).toBe('138')
    expect(created.file_count).toBe(0)

    // 目录 + 三个固定子文件夹
    const root = path.join(ws, '供应商', '甲')
    for (const sub of ['合同', '对账单', '往来文件']) {
      expect((await fsp.stat(path.join(root, sub))).isDirectory()).toBe(true)
    }
    // 档案条目（created_at/updated_at ISO）
    const store = await readSuppliersStore(ws)
    expect(store['甲']).toBeTruthy()
    expect((store['甲'] as { created_at: string }).created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // 同名拒绝（既有档案命中）
    await expect(box.suppliers.create({ name: '甲' })).rejects.toThrow('供应商已存在')
    // 同名拒绝（既有目录命中——档案未命中但目录实存）
    await fsp.mkdir(path.join(ws, '供应商', '乙'), { recursive: true })
    await expect(box.suppliers.create({ name: '乙' })).rejects.toThrow('供应商已存在')
  })

  it('create 建齐 config.supplier_subfolders（v2.5.5 对齐客户：可配置，不再固定集）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 默认集 = SUPPLIER_SUBFOLDERS 兜底（合同/对账单/往来文件）
    await box.suppliers.create({ name: '甲' })
    const root = path.join(ws, '供应商', '甲')
    for (const sub of ['合同', '对账单', '往来文件']) {
      expect((await fsp.stat(path.join(root, sub))).isDirectory()).toBe(true)
    }
    let cfg = await box.workspace.loadConfig()
    expect(cfg.supplier_subfolders).toEqual(['合同', '对账单', '往来文件'])

    // 自定义 config.supplier_subfolders → 新建供应商按自定义集建齐（旧「决策 1 固定集」废止）
    const cfg2 = await box.workspace.updateConfig({
      ...cfg,
      supplier_subfolders: ['采购合同', '质检报告'],
    })
    expect(cfg2.supplier_subfolders).toEqual(['采购合同', '质检报告'])
    await box.suppliers.create({ name: '乙' })
    const root2 = path.join(ws, '供应商', '乙')
    for (const sub of ['采购合同', '质检报告']) {
      expect((await fsp.stat(path.join(root2, sub))).isDirectory()).toBe(true)
    }
    // 乙不再建旧固定集
    await expect(fsp.stat(path.join(root2, '合同'))).rejects.toBeTruthy()
  })

  it('update：字段更新持久化 + updated_at 刷新；list() 返回一致', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const created = await box.suppliers.create({ name: '甲', contact: '王工' })
    const updated = await box.suppliers.update({
      name: '甲',
      contact: '李工',
      phone: '13900000000',
      email: 'j@example.com',
      address: '义乌',
      notes: '账期 30 天',
      tags: ['重点'],
    })
    expect(updated.contact).toBe('李工')
    expect(updated.phone).toBe('13900000000')
    expect(updated.email).toBe('j@example.com')
    expect(updated.address).toBe('义乌')
    expect(updated.notes).toBe('账期 30 天')
    expect(updated.tags).toEqual(['重点'])
    expect(updated.updated_at >= created.updated_at).toBe(true)

    // 持久化 + 未传字段保留原值
    const store = await readSuppliersStore(ws)
    expect((store['甲'] as { contact: string }).contact).toBe('李工')
    expect((store['甲'] as { email: string }).email).toBe('j@example.com')
    const partial = await box.suppliers.update({ name: '甲', phone: '137' })
    expect(partial.contact).toBe('李工')
    expect(partial.email).toBe('j@example.com')
    expect(partial.phone).toBe('137')

    // list() 与档案一致
    const list = await box.suppliers.list()
    const s = list.find((x) => x.name === '甲')
    expect(s?.contact).toBe('李工')
    expect(s?.phone).toBe('137')
    expect(s?.tags).toEqual(['重点'])

    // 不存在的供应商拒绝
    await expect(box.suppliers.update({ name: '不存在' })).rejects.toThrow('供应商不存在')
  })

  it('rename：目录迁移 + 档案 key 迁移 + inbound.supplier_id 级联；新名冲突拒绝；有文件不可重命名', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.suppliers.create({ name: '甲', contact: '王工', tags: ['重点'] })
    // 入库单引用供应商（supplier_id 名字引用）
    await box.inbound.create(inboundReq({ id: 'IN-001', supplier: '甲', supplier_id: '甲' }))

    await box.renameSupplier('甲', '乙')

    // 目录迁移
    await expect(fsp.stat(path.join(ws, '供应商', '甲'))).rejects.toThrow()
    expect((await fsp.stat(path.join(ws, '供应商', '乙'))).isDirectory()).toBe(true)
    // 档案 key 迁移（tags 随条目整体移动）
    const store = await readSuppliersStore(ws)
    expect(store['甲']).toBeUndefined()
    expect((store['乙'] as { tags: string[] }).tags).toEqual(['重点'])
    // inbound.supplier_id 级联更新
    const inbound = await readInboundStore(ws)
    expect(inbound.records['IN-001'].supplier_id).toBe('乙')

    // 新名冲突拒绝（目录已存在）
    await box.suppliers.create({ name: '丙' })
    await expect(box.renameSupplier('乙', '丙')).rejects.toThrow('新供应商已存在')

    // 有文件不可重命名（metadata key 路径推导的代价，同客户规则）
    await addSupplierFile(ws, '乙', '合同', 'a.pdf')
    await expect(box.renameSupplier('乙', '丁')).rejects.toThrow('已有文件')
    // 空供应商可改名
    await expect(box.renameSupplier('丙', '丁')).resolves.toBeUndefined()
  })

  it('delete→restore→purge：kind=supplier；restore 复原目录与档案；purge 四清理且 inbound 留字面值', async () => {
    const home = await tmp()
    const ws = await tmp()
    const workspace = new WorkspaceService(home)
    const thumbs = new RecordingThumbs()
    const box = new BoxService(thumbs, workspace)
    await workspace.create(ws)
    await box.suppliers.create({ name: '甲', tags: ['重点'] })
    await addSupplierFile(ws, '甲', '合同', 'a.pdf')
    // 入库单引用（supplier_id 名字引用）
    await box.inbound.create(inboundReq({ id: 'IN-001', supplier: '甲', supplier_id: '甲' }))
    // 供应商区 + 产品集区元数据 key（key 泛化后为工作区相对路径）
    const store = await box.metadata.loadMetadataStore()
    store.files['供应商/甲/合同/a.pdf'] = { cert_type: '', expiry_date: '', tags: ['x'], notes: '', added_at: new Date().toISOString() }
    store.files['供应商/甲/对账单/b.pdf'] = { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: new Date().toISOString() }
    store.files['系列A/图包/主图/c.jpg'] = { cert_type: '', expiry_date: '', tags: ['x'], notes: '', added_at: new Date().toISOString() }
    await box.metadata.saveMetadataStore(store)

    // 删除 → 回收站 kind=supplier；档案条目保留（恢复即复原）
    const root = path.join(ws, '供应商', '甲')
    await box.deleteSupplier('甲')
    await expect(fsp.stat(root)).rejects.toThrow()
    expect(await box.suppliers.list()).toHaveLength(0)
    let entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('supplier')
    expect((await readSuppliersStore(ws))['甲']).toBeTruthy()

    // 恢复：目录 + 固定子文件夹 + 档案复原
    await box.trash.restore(entries[0].id)
    expect((await fsp.stat(root)).isDirectory()).toBe(true)
    for (const sub of ['合同', '对账单', '往来文件']) {
      expect((await fsp.stat(path.join(root, sub))).isDirectory()).toBe(true)
    }
    expect((await box.suppliers.list())[0].tags).toEqual(['重点'])

    // 再删除 → purge 四清理
    await box.deleteSupplier('甲')
    entries = await box.trash.list()
    await box.trash.purge(entries[0].id)

    // ①目录 ②metadata 前缀无残留（产品集区保留）③缩略图批量清理 ④suppliers.json 条目删除
    await expect(fsp.stat(root)).rejects.toThrow()
    const meta = await box.metadata.loadMetadataStore()
    expect(Object.keys(meta.files).filter((k) => k.startsWith('供应商/甲'))).toHaveLength(0)
    expect(meta.files['系列A/图包/主图/c.jpg']).toBeTruthy()
    expect(thumbs.removed).toContain(path.join(ws, '供应商', '甲', '合同', 'a.pdf'))
    expect((await readSuppliersStore(ws))['甲']).toBeUndefined()
    // inbound.supplier_id 留字面值不级联删（purge 不报错）
    const inbound = await readInboundStore(ws)
    expect(inbound.records['IN-001'].supplier_id).toBe('甲')
    expect(await box.trash.list()).toHaveLength(0)
  })

  it('trash 全链路：trashItem/restore/purge supplier 分支（档案缺失时 restore 补回）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.suppliers.create({ name: '甲' })
    // 模拟目录存在但档案缺失（如外部手工建目录）
    const store = await readSuppliersStore(ws)
    delete store['甲']
    await fsp.writeFile(path.join(ws, '.qihefilemanager', 'suppliers.json'), JSON.stringify(store, null, 2))

    const dir = path.join(ws, '供应商', '甲')
    await box.trash.trashItem(ws, dir, 'supplier')
    let entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('supplier')

    // restore：目录复原 + 固定子文件夹 + 档案条目补回
    await box.trash.restore(entries[0].id)
    expect((await fsp.stat(dir)).isDirectory()).toBe(true)
    for (const sub of ['合同', '对账单', '往来文件']) {
      expect((await fsp.stat(path.join(dir, sub))).isDirectory()).toBe(true)
    }
    expect((await readSuppliersStore(ws))['甲']).toBeTruthy()

    // 再次 trashItem → purge：目录 + 条目清理
    await box.trash.trashItem(ws, dir, 'supplier')
    entries = await box.trash.list()
    await box.trash.purge(entries[0].id)
    await expect(fsp.stat(dir)).rejects.toThrow()
    expect((await readSuppliersStore(ws))['甲']).toBeUndefined()
    expect(await box.trash.list()).toHaveLength(0)
  })

  it('list：名称排序 + file_count 递归计数（隐藏文件不计）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.suppliers.create({ name: '张三' })
    await box.suppliers.create({ name: 'Alice' })
    await addSupplierFile(ws, 'Alice', '合同', 'a.pdf')
    await addSupplierFile(ws, 'Alice', '往来文件', 'b.pdf')
    await addSupplierFile(ws, 'Alice', '合同', '.hidden') // 隐藏文件不计入 file_count

    const list = await box.suppliers.list()
    expect(list.map((s) => s.name)).toEqual(['Alice', '张三'])
    const alice = list.find((s) => s.name === 'Alice')
    expect(alice?.file_count).toBe(2)
    expect(list.find((s) => s.name === '张三')?.file_count).toBe(0)
  })

  it('inbound：supplier_id 不硬校验存在性（删除供应商后编辑旧入库单放行；未知名创建/更新直接放行）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.suppliers.create({ name: '甲' })
    await box.inbound.create(inboundReq({ id: 'IN-001', supplier: '甲', supplier_id: '甲' }))

    // 删除供应商（purge 后 suppliers.json 无条目）→ 旧入库单仍可编辑（名字引用不校验）
    await box.deleteSupplier('甲')
    await box.trash.purge((await box.trash.list())[0].id)
    const rec = await box.inbound.update(
      'IN-001',
      inboundReq({ id: 'IN-001', supplier: '甲', supplier_id: '甲', notes: '编辑后' }),
    )
    expect(rec.notes).toBe('编辑后')
    expect(rec.supplier_id).toBe('甲')

    // 创建/更新带不存在的 supplier_id 直接放行（不硬校验）
    const rec2 = await box.inbound.create(inboundReq({ id: 'IN-002', supplier: '未知', supplier_id: '不存在' }))
    expect(rec2.supplier_id).toBe('不存在')
    const rec3 = await box.inbound.update(
      'IN-002',
      inboundReq({ id: 'IN-002', supplier: '未知', supplier_id: '仍不存在' }),
    )
    expect(rec3.supplier_id).toBe('仍不存在')
  })

  it('区域判别：供应商 key → supplier；同名产品集优先同客户', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const wsPath = box.workspace.currentWorkspacePath()!

    expect(await interpretMetadataKeyRegion(wsPath, '供应商/甲/合同/x.pdf')).toBe('supplier')
    expect(await interpretMetadataKeyRegion(wsPath, '供应商/甲/对账单/y.pdf')).toBe('supplier')
    // 既有区域不受影响
    expect(await interpretMetadataKeyRegion(wsPath, '客户/张三/报价/a.pdf')).toBe('customer')
    expect(await interpretMetadataKeyRegion(wsPath, '系列A/图包/主图/a.jpg')).toBe('productSet')

    // 存量同名保留名产品集（§3.7 不强制迁移）：首段 供应商 但 产品集/供应商 实存 → 产品集优先
    await fsp.mkdir(path.join(wsPath, '产品集', '供应商'), { recursive: true })
    expect(await interpretMetadataKeyRegion(wsPath, '供应商/x.pdf')).toBe('productSet')
  })

  it('Logger 注入：create/rename 调用 logger.info（S6 core 接口）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const workspace = new WorkspaceService(home)
    await workspace.create(ws)
    const logger = new MemoryLogger()
    const suppliers = new SuppliersService(workspace, logger)
    const infoMsgs = (): string[] => logger.calls.filter((c) => c.level === 'info').map((c) => c.msg)

    await suppliers.create({ name: '甲' })
    expect(infoMsgs()).toEqual([expect.stringContaining('甲')])

    await suppliers.rename('甲', '乙')
    expect(infoMsgs()).toEqual([expect.stringContaining('甲'), expect.stringContaining('乙')])
  })

  it('linkRelation：产品集存在才可关联（去重）→ 档案持久化；unlinkRelation 解除（v2.4.9 打磨 M8）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.suppliers.create({ name: '甲' })
    await box.workspace.productSetCreate({ name: '系列A' })

    // 不存在的产品集 → 拒绝
    await expect(box.suppliers.linkRelation('甲', '不存在集')).rejects.toThrow('不存在')

    let s = await box.suppliers.linkRelation('甲', '系列A')
    expect(s.related_product_sets).toEqual(['系列A'])
    // 重复关联去重
    s = await box.suppliers.linkRelation('甲', '系列A')
    expect(s.related_product_sets).toEqual(['系列A'])
    // 档案持久化（目录扫描为实、JSON 为档案：list() 与档案一致）
    expect((await readSuppliersStore(ws))['甲']).toHaveProperty('related_product_sets', ['系列A'])
    expect((await box.suppliers.list()).find((x) => x.name === '甲')?.related_product_sets).toEqual(['系列A'])
    // 移除
    s = await box.suppliers.unlinkRelation('甲', '系列A')
    expect(s.related_product_sets).toEqual([])
    expect((await readSuppliersStore(ws))['甲']).toHaveProperty('related_product_sets', [])
    // 不存在的供应商拒绝
    await expect(box.suppliers.linkRelation('不存在', '系列A')).rejects.toThrow('供应商不存在')
    await expect(box.suppliers.unlinkRelation('不存在', '系列A')).rejects.toThrow('供应商不存在')
  })

  it('create/update：带不存在产品集拒绝；create 透传 related_product_sets；update 透传 + 去重（v2.4.9 打磨 M8）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    // create 带不存在产品集 → 拒绝（不落盘：目录 + 档案均未创建）
    await expect(box.suppliers.create({ name: '甲', related_product_sets: ['不存在集'] })).rejects.toThrow('不存在')
    expect(await box.suppliers.list()).toHaveLength(0)

    // create 带合法集 → 透传落盘 + buildInfo 输出
    const created = await box.suppliers.create({ name: '甲', related_product_sets: ['系列A', '系列A'] })
    expect(created.related_product_sets).toEqual(['系列A', '系列A'])
    expect((await readSuppliersStore(ws))['甲']).toHaveProperty('related_product_sets', ['系列A', '系列A'])

    // update 带不存在产品集 → 拒绝（原值保留）
    await expect(box.suppliers.update({ name: '甲', related_product_sets: ['系列B', '不存在集'] })).rejects.toThrow('不存在')
    expect((await readSuppliersStore(ws))['甲']).toHaveProperty('related_product_sets', ['系列A', '系列A'])

    // update 合法集 → 透传 + 去重
    const updated = await box.suppliers.update({ name: '甲', related_product_sets: ['系列B', '系列B'] })
    expect(updated.related_product_sets).toEqual(['系列B'])
    expect((await readSuppliersStore(ws))['甲']).toHaveProperty('related_product_sets', ['系列B'])
    // 未传字段保留原值
    const partial = await box.suppliers.update({ name: '甲', contact: '李工' })
    expect(partial.related_product_sets).toEqual(['系列B'])
  })
})
describe('供应商服务（v2.5.3 T2：锁内读改写事务 / 并发）', () => {
  it('并发 create 不同供应商：锁内查重（档案残留防御）不误伤，8 供应商全部落盘', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const names = Array.from({ length: 8 }, (_, i) => `并发C${i}`)
    await Promise.all(names.map((n) => box.suppliers.create({ name: n })))
    expect(await box.suppliers.list()).toHaveLength(8)
    const store = await readSuppliersStore(ws)
    for (const n of names) expect(store[n]).toBeTruthy()
  })

  it('并发 update 不同供应商：字段更新不互丢（锁内读改写基于最新磁盘内容）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const names = Array.from({ length: 8 }, (_, i) => `并发S${i}`)
    for (const n of names) await box.suppliers.create({ name: n })

    await Promise.all(
      names.map((n, i) => box.suppliers.update({ name: n, phone: `1390000000${i}`, contact: `c${i}` })),
    )
    const list = await box.suppliers.list()
    for (let i = 0; i < names.length; i++) {
      const s = list.find((x) => x.name === names[i])
      expect(s?.phone).toBe(`1390000000${i}`)
      expect(s?.contact).toBe(`c${i}`)
    }
    const store = await readSuppliersStore(ws)
    for (let i = 0; i < names.length; i++) {
      expect((store[names[i]] as { phone: string }).phone).toBe(`1390000000${i}`)
    }
  })
})

// —— v2.5.4（弹一 C-1，云桥 M3）：supplier 能力域（listSince / get / writeErpExt / syncProfile + 裁决纯函数）——
describe('supplier 能力域（v2.5.4 C-1/M3）', () => {
  async function makeSupplier(ws: string, name = '域供应商'): Promise<string> {
    await fsp.mkdir(path.join(ws, '供应商', name), { recursive: true })
    return name
  }

  describe('resolveSupplierSyncProfile 纯函数', () => {
    it('req.updated_at ≤ local → STALE（applied:false，无 denied）', () => {
      const local = { contact: '旧', updated_at: '2026-08-20T10:00:00.000Z' }
      const r = resolveSupplierSyncProfile(local, { updated_at: '2026-08-20T09:00:00.000Z' })
      expect(r).toEqual({ applied: false })
    })

    it('较新 → 仅合白名单差异字段 + erp_ext', () => {
      const local = { contact: '旧', phone: '13800138000', updated_at: '2026-08-20T10:00:00.000Z' }
      const r = resolveSupplierSyncProfile(local, {
        fields: { contact: '新', address: '广州' },
        erp_ext: { code: 'GYS-1' },
        updated_at: '2026-08-20T11:00:00.000Z',
      })
      expect(r.applied).toBe(true)
      expect(r.next?.contact).toBe('新')
      expect(r.next?.address).toBe('广州')
      expect(r.next?.phone).toBe('13800138000') // 未传字段保留
      expect(r.next?.erp_ext).toEqual({ code: 'GYS-1' })
      expect(r.next?.updated_at).toBe('2026-08-20T11:00:00.000Z')
    })

    it('白名单外字段 → denied', () => {
      const local = { updated_at: '2026-08-20T10:00:00.000Z' }
      const r = resolveSupplierSyncProfile(local, {
        fields: { tags: ['x'] },
        updated_at: '2026-08-20T11:00:00.000Z',
      })
      expect(r).toEqual({ applied: false, denied: true })
    })

    it('空白 phone → denied', () => {
      const local = { updated_at: '2026-08-20T10:00:00.000Z' }
      const r = resolveSupplierSyncProfile(local, {
        fields: { phone: '  ' },
        updated_at: '2026-08-20T11:00:00.000Z',
      })
      expect(r).toEqual({ applied: false, denied: true })
    })

    it('无任何变更 → applied:false 不刷 updated_at', () => {
      const local = { contact: '同值', updated_at: '2026-08-20T10:00:00.000Z' }
      const r = resolveSupplierSyncProfile(local, {
        fields: { contact: '同值' },
        updated_at: '2026-08-20T11:00:00.000Z',
      })
      expect(r).toEqual({ applied: false })
    })
  })

  describe('listSince / get', () => {
    it('listSince 无 since → 全量；有 since → 严大于 updated_at', async () => {
      const home = await tmp()
      const ws = await tmp()
      const box = buildTestBox(home)
      await box.workspace.create(ws)
      await box.suppliers.create({ name: '早供应商', phone: '13900000101' })
      await box.suppliers.create({ name: '晚供应商', phone: '13900000102' })
      const all = await box.suppliers.list()
      // 强制两个不同的 updated_at 时间戳
      const store = await readSuppliersStore(ws)
      const early: Record<string, string> = { updated_at: '2026-08-20T09:00:00.000Z' }
      const late: Record<string, string> = { updated_at: '2026-08-20T10:00:00.000Z' }
      Object.assign(store['早供应商'] as Record<string, unknown>, early)
      Object.assign(store['晚供应商'] as Record<string, unknown>, late)
      await fsp.writeFile(
        path.join(ws, '.qihefilemanager', 'suppliers.json'),
        JSON.stringify(store, null, 2),
      )

      const since = await box.suppliers.listSince('2026-08-20T09:30:00.000Z')
      expect(since.length).toBe(1)
      expect(since[0].name).toBe('晚供应商')
      const full = await box.suppliers.listSince()
      expect(full.length).toBe(2)
      const invalid = await box.suppliers.listSince('not-a-date')
      expect(invalid.length).toBe(2) // 非法 since → 全量
    })

    it('get：存在返回档案（file_count 递归计数）；目录缺失 → null；空名 → null', async () => {
      const home = await tmp()
      const ws = await tmp()
      const box = buildTestBox(home)
      await box.workspace.create(ws)
      await box.suppliers.create({ name: '甲供应商', contact: '王五' })
      await addSupplierFile(ws, '甲供应商', '合同', 'a.pdf')

      const got = await box.suppliers.get('甲供应商')
      expect(got?.name).toBe('甲供应商')
      expect(got?.contact).toBe('王五')
      expect(got?.file_count).toBe(1)
      expect(await box.suppliers.get('不存在供应商')).toBeNull()
      expect(await box.suppliers.get('  ')).toBeNull()
    })
  })

  describe('writeErpExt / syncProfile', () => {
    it('writeErpExt：仅写 erp_ext，保留其余字段；目录缺失抛错', async () => {
      const home = await tmp()
      const ws = await tmp()
      const box = buildTestBox(home)
      await box.workspace.create(ws)
      await box.suppliers.create({ name: '乙供应商', contact: '李四' })

      await box.suppliers.writeErpExt('乙供应商', { code: 'GYS-20260820-0001', status: 'active' })
      const store = await readSuppliersStore(ws)
      const entry = store['乙供应商'] as { contact: string; erp_ext: Record<string, unknown> }
      expect(entry.contact).toBe('李四')
      expect(entry.erp_ext).toEqual({ code: 'GYS-20260820-0001', status: 'active' })

      await expect(box.suppliers.writeErpExt('不存在供应商', {})).rejects.toThrow('供应商不存在')
    })

    it('writeErpExt：目录有而 JSON 无条目 → 补最小条目后写（D8 目录基准）', async () => {
      const home = await tmp()
      const ws = await tmp()
      const box = buildTestBox(home)
      await box.workspace.create(ws)
      await makeSupplier(ws, '无档案供应商')

      await box.suppliers.writeErpExt('无档案供应商', { code: 'GYS-X' })
      const store = await readSuppliersStore(ws)
      const entry = store['无档案供应商'] as { erp_ext: Record<string, unknown> }
      expect(entry.erp_ext).toEqual({ code: 'GYS-X' })
    })

    it('syncProfile：较新 → 写白名单差异 + erp_ext；STALE → applied:false；白名单外 → 抛错', async () => {
      const home = await tmp()
      const ws = await tmp()
      const box = buildTestBox(home)
      await box.workspace.create(ws)
      await box.suppliers.create({ name: '丙供应商', contact: '旧联系人', phone: '13800138000' })

      // STALE：回传旧 updated_at → applied:false 无错误
      const stale = await box.suppliers.syncProfile({
        name: '丙供应商',
        fields: { contact: '强行改' },
        updated_at: '2020-01-01T00:00:00.000Z',
      })
      expect(stale).toEqual({ applied: false })

      // 较新 → applied:true，字段落库
      const applied = await box.suppliers.syncProfile({
        name: '丙供应商',
        fields: { contact: '新联系人', address: '深圳' },
        erp_ext: { code: 'GYS-C' },
        updated_at: '2099-01-01T00:00:00.000Z',
      })
      expect(applied).toEqual({ applied: true })
      const got = await box.suppliers.get('丙供应商')
      expect(got?.contact).toBe('新联系人')
      expect(got?.address).toBe('深圳')
      expect(got?.phone).toBe('13800138000') // 未传保留
      expect(got?.erp_ext).toEqual({ code: 'GYS-C' })

      // 白名单外字段（tags）→ FIELD_DENIED（抛错）
      await expect(
        box.suppliers.syncProfile({
          name: '丙供应商',
          fields: { tags: ['x'] as unknown as string },
          updated_at: '2199-01-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('白名单')
    })
  })
})