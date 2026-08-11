/**
 * 客户服务单测（v2.4.7 §5）
 * 覆盖：CRUD / 名称校验（assertSafeFolderName）/ 默认子文件夹创建 / 档案字段更新与 erp_ext 只读保留 /
 * 关联增删（校验产品集存在、去重）/ 有文件不可重命名 / 删除走回收站（条目保留、恢复复原、purge 清理条目与元数据前缀）/
 * 标签引用源（rename/delete/adopt 自动覆盖）/ 客户子文件夹恢复回填 config.customer_subfolders。
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-'))
}

async function readCustomersStore(ws: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'customers.json'), 'utf-8'))
}

/** 在 客户/<name>/<sub>/ 下写一个文件，返回绝对路径 */
async function addCustomerFile(ws: string, customer: string, sub: string, name: string): Promise<string> {
  const dir = path.join(ws, '客户', customer, sub)
  await fsp.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fsp.writeFile(p, 'file-bytes')
  return p
}

describe('客户服务（v2.4.7 §5）', () => {
  it('create：建目录 + 默认子文件夹（config.customer_subfolders）+ 档案条目，list 按名排序', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.clients.create({ name: '张三', tags: ['重点'], notes: '备注' })
    await box.clients.create({ name: 'Alice' })

    // 目录 + 默认子文件夹
    const root = path.join(ws, '客户', '张三')
    for (const sub of ['报价', '合同', '沟通', '其他']) {
      expect((await fsp.stat(path.join(root, sub))).isDirectory()).toBe(true)
    }
    // 档案条目（created_at/updated_at ISO）
    const store = await readCustomersStore(ws)
    expect(store['张三']).toBeTruthy()
    expect((store['张三'] as { created_at: string }).created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // list：按名排序、字段合并
    const list = await box.clients.list()
    expect(list.map((c) => c.name)).toEqual(['Alice', '张三'])
    const z = list.find((c) => c.name === '张三')
    expect(z?.tags).toEqual(['重点'])
    expect(z?.notes).toBe('备注')
    expect(z?.file_count).toBe(0)
  })

  it('create：名称校验拒绝非法名（分隔符 / .. / 非法字符 / 首尾点）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await expect(box.clients.create({ name: '../逃逸' })).rejects.toThrow()
    await expect(box.clients.create({ name: 'a/b' })).rejects.toThrow('分隔符')
    await expect(box.clients.create({ name: 'a*b' })).rejects.toThrow('非法字符')
    await expect(box.clients.create({ name: '.hidden' })).rejects.toThrow()
    expect(await box.clients.list()).toHaveLength(0)
  })

  it('create：重名拒绝；update 不存在的客户拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.clients.create({ name: '张三' })
    await expect(box.clients.create({ name: '张三' })).rejects.toThrow('客户已存在')
    await expect(box.clients.update({ name: '不存在' })).rejects.toThrow('客户不存在')
  })

  it('update：档案字段 + tags/notes + related_product_sets 更新，erp_ext 原样保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.clients.create({ name: '张三' })

    // 预置 erp_ext（v2.7 erp-bridge 写回命名空间，本体不可写但必须保留）
    const store = await readCustomersStore(ws)
    ;(store['张三'] as { erp_ext?: unknown }).erp_ext = { level: 'VIP', last_order: '2026-08-01' }
    await fsp.writeFile(path.join(ws, '.qihefilemanager', 'customers.json'), JSON.stringify(store, null, 2))

    const c = await box.clients.update({
      name: '张三',
      alias: '三哥',
      country: '中国',
      contact: '13800138000',
      source: '展会',
      tags: ['重要', '外贸'],
      notes: '新备注',
      related_product_sets: ['系列A', '系列A'],
    })
    expect(c.alias).toBe('三哥')
    expect(c.country).toBe('中国')
    expect(c.contact).toBe('13800138000')
    expect(c.source).toBe('展会')
    expect(c.tags).toEqual(['重要', '外贸'])
    expect(c.notes).toBe('新备注')
    // 关联去重
    expect(c.related_product_sets).toEqual(['系列A'])
    // erp_ext 保留（API 面不含其入参 → 本体物理不可写）
    const after = await readCustomersStore(ws)
    expect((after['张三'] as { erp_ext: unknown }).erp_ext).toEqual({ level: 'VIP', last_order: '2026-08-01' })
    // updated_at 刷新
    const first = (await readCustomersStore(ws))['张三'] as { updated_at: string }
    expect(first.updated_at).toBeTruthy()
  })

  it('linkRelation：产品集存在才可关联（去重）；unlinkRelation 移除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    await box.workspace.productSetCreate({ name: '系列A' })

    // 不存在的产品集 → 拒绝
    await expect(box.clients.linkRelation('张三', '不存在集')).rejects.toThrow('不存在')

    let c = await box.clients.linkRelation('张三', '系列A')
    expect(c.related_product_sets).toEqual(['系列A'])
    // 重复关联去重
    c = await box.clients.linkRelation('张三', '系列A')
    expect(c.related_product_sets).toEqual(['系列A'])
    // 移除
    c = await box.clients.unlinkRelation('张三', '系列A')
    expect(c.related_product_sets).toEqual([])
    // 不存在的客户拒绝
    await expect(box.clients.linkRelation('不存在', '系列A')).rejects.toThrow('客户不存在')
  })

  it('rename：空客户目录 + 档案键迁移（tags/notes 随条目移动）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三', tags: ['重点'], notes: '备注' })

    await box.clients.rename('张三', '李四')
    await expect(fsp.stat(path.join(ws, '客户', '张三'))).rejects.toThrow()
    expect((await fsp.stat(path.join(ws, '客户', '李四'))).isDirectory()).toBe(true)
    const store = await readCustomersStore(ws)
    expect(store['张三']).toBeUndefined()
    expect((store['李四'] as { tags: string[] }).tags).toEqual(['重点'])

    const list = await box.clients.list()
    expect(list.map((c) => c.name)).toEqual(['李四'])
  })

  it('rename：有文件不可重命名；重名拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    await box.clients.create({ name: '李四' })

    await addCustomerFile(ws, '张三', '报价', 'a.pdf')
    await expect(box.clients.rename('张三', '王五')).rejects.toThrow('已有文件')
    await expect(box.clients.rename('张三', '李四')).rejects.toThrow('新客户已存在')
    // 空客户可改名
    await expect(box.clients.rename('李四', '王五')).resolves.toBeUndefined()
  })

  it('deleteCustomer：目录进回收站（kind=customer），档案条目保留，恢复后复原', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三', tags: ['重点'] })
    await addCustomerFile(ws, '张三', '报价', 'a.pdf')

    await box.deleteCustomer('张三')
    await expect(fsp.stat(path.join(ws, '客户', '张三'))).rejects.toThrow()
    // 列表消失（目录扫描为实）
    expect(await box.clients.list()).toHaveLength(0)
    // 回收站 kind=customer；档案条目保留（恢复即复原）
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('customer')
    const store = await readCustomersStore(ws)
    expect(store['张三']).toBeTruthy()

    await box.trash.restore(entries[0].id)
    const list = await box.clients.list()
    const restored = list.find((c) => c.name === '张三')
    expect(restored).toBeTruthy()
    expect(restored?.tags).toEqual(['重点'])
    expect(restored?.file_count).toBe(1)
  })

  it('purge 客户：customers.json 条目清理 + 客户区元数据前缀清理（不影响其他区域 key）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })
    await addCustomerFile(ws, '张三', '报价', 'a.pdf')

    // 直接写入客户区 + 产品集区元数据 key（key 泛化后为工作区相对路径）
    const store = await box.metadata.loadMetadataStore()
    store.files['客户/张三/报价/a.pdf'] = { cert_type: '', expiry_date: '', tags: ['x'], notes: '', added_at: new Date().toISOString() }
    store.files['客户/张三/合同/b.pdf'] = { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: new Date().toISOString() }
    store.files['系列A/图包/主图/c.jpg'] = { cert_type: '', expiry_date: '', tags: ['x'], notes: '', added_at: new Date().toISOString() }
    await box.metadata.saveMetadataStore(store)

    await box.deleteCustomer('张三')
    const entries = await box.trash.list()
    expect(entries[0].kind).toBe('customer')
    await box.trash.purge(entries[0].id)

    // customers.json 条目清理
    const after = await readCustomersStore(ws)
    expect(after['张三']).toBeUndefined()
    // 客户区元数据前缀清理，产品集区保留
    const meta = await box.metadata.loadMetadataStore()
    expect(Object.keys(meta.files).filter((k) => k.startsWith('客户/张三'))).toHaveLength(0)
    expect(meta.files['系列A/图包/主图/c.jpg']).toBeTruthy()
    expect(await box.trash.list()).toHaveLength(0)
  })

  it('客户子文件夹恢复：回填 config.customer_subfolders', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })

    const sub = path.join(ws, '客户', '张三', '特殊夹')
    await fsp.mkdir(sub, { recursive: true })
    await box.trash.trashItem(ws, sub, 'subfolder')
    await box.trash.restore((await box.trash.list())[0].id)

    await expect(fsp.stat(sub)).resolves.toBeTruthy()
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.customer_subfolders).toContain('特殊夹')
    // 默认子文件夹不受影响
    expect(cfg.customer_subfolders).toContain('报价')
  })

  it('标签引用源：客户 tags 参与 rename / delete / adopt（无手写传播）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // rename：客户引用自动改名
    await box.clients.create({ name: '张三', tags: ['重点'] })
    await box.tags.create('重点', '#ef4444')
    await box.tags.rename('重点', 'VIP')
    expect((await box.clients.list())[0].tags).toEqual(['VIP'])

    // delete：客户引用自动移除
    await box.tags.delete('VIP')
    expect((await box.clients.list())[0].tags).toEqual([])

    // adopt：被客户引用的孤儿标签可正式定义
    await box.clients.create({ name: '李四', tags: ['孤儿'] })
    await box.tags.adopt('孤儿', '#123456')
    const t = (await box.tags.list()).find((x) => x.name === '孤儿')
    expect(t?.defined).toBe(true)
    expect(t?.count).toBe(1)
  })
})
