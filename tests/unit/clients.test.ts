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

  // —— v2.4.9 S1：客户对齐启禾 OS（type/phone/email/address + erp_ext 只读面）——

  it('create/update：type/phone/email/address 透传持久化，list() 返回一致', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const created = await box.clients.create({
      name: '张三',
      type: '企业',
      phone: '13800138000',
      email: 'zs@example.com',
      address: '浙江省义乌市',
    })
    expect(created.type).toBe('企业')
    expect(created.phone).toBe('13800138000')
    expect(created.email).toBe('zs@example.com')
    expect(created.address).toBe('浙江省义乌市')

    // 档案持久化（customers.json）
    const store = await readCustomersStore(ws)
    expect((store['张三'] as { type: string }).type).toBe('企业')
    expect((store['张三'] as { phone: string }).phone).toBe('13800138000')
    expect((store['张三'] as { email: string }).email).toBe('zs@example.com')
    expect((store['张三'] as { address: string }).address).toBe('浙江省义乌市')

    // update 全字段更新
    const updated = await box.clients.update({
      name: '张三',
      type: '个人',
      phone: '13900000000',
      email: 'new@example.com',
      address: '广东省深圳市',
    })
    expect(updated.type).toBe('个人')
    expect(updated.phone).toBe('13900000000')
    expect(updated.email).toBe('new@example.com')
    expect(updated.address).toBe('广东省深圳市')

    // update 未传字段保留原值
    const partial = await box.clients.update({ name: '张三', phone: '13700000000' })
    expect(partial.type).toBe('个人')
    expect(partial.email).toBe('new@example.com')
    expect(partial.address).toBe('广东省深圳市')

    // list() 返回与档案一致
    const list = await box.clients.list()
    const c = list.find((x) => x.name === '张三')
    expect(c?.type).toBe('个人')
    expect(c?.phone).toBe('13700000000')
    expect(c?.email).toBe('new@example.com')
    expect(c?.address).toBe('广东省深圳市')
  })

  it('type 枚举校验：非「企业/个人」拒绝（create/update 两入口），缺省合法', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // create：非法枚举拒绝（校验在建目录前，无残留目录）
    await expect(
      box.clients.create({ name: '张三', type: '供应商' as unknown as '企业' | '个人' }),
    ).rejects.toThrow('客户类型只能是「企业」或「个人」')
    expect(await box.clients.list()).toHaveLength(0)

    // 缺省合法
    await box.clients.create({ name: '张三' })

    // update：非法枚举拒绝，且不落盘
    await expect(
      box.clients.update({ name: '张三', type: '其他' as unknown as '企业' | '个人' }),
    ).rejects.toThrow('客户类型只能是「企业」或「个人」')
    const store = await readCustomersStore(ws)
    expect((store['张三'] as { type?: string }).type).toBeUndefined()

    // update 缺省合法（不传 type 保留原值）
    const c = await box.clients.update({ name: '张三', phone: '138' })
    expect(c.type).toBeUndefined()
    expect(c.phone).toBe('138')
  })

  it('旧档案（无新字段）读取宽松：type/phone/email/address 输出 undefined 而非抛错', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })

    // 模拟 v2.4.8 旧档案：删除新字段（create 序列化后本就不含 undefined 键，此处显式清理模拟旧数据）
    const store = await readCustomersStore(ws)
    const old = store['张三'] as Record<string, unknown>
    delete old.type
    delete old.phone
    delete old.email
    delete old.address
    await fsp.writeFile(path.join(ws, '.qihefilemanager', 'customers.json'), JSON.stringify(store, null, 2))

    // buildInfo 输出 undefined 而非抛错；既有字段不受影响
    const list = await box.clients.list()
    const c = list.find((x) => x.name === '张三')
    expect(c?.type).toBeUndefined()
    expect(c?.phone).toBeUndefined()
    expect(c?.email).toBeUndefined()
    expect(c?.address).toBeUndefined()
    expect(c?.name).toBe('张三')
    expect(c?.tags).toEqual([])
  })

  it('erp_ext 传入仍被忽略：API 面不含入参（类型层面保证），透传路径被拒', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // CustomerCreateRequest/CustomerUpdateRequest 无 erp_ext 字段（类型层面保证）；
    // 运行时即使多传也不会落盘（本体物理不可写，v2.7 erp-bridge 才写回）
    await box.clients.create({ name: '张三', erp_ext: { level: 'VIP' } } as unknown as {
      name: string
      erp_ext: unknown
    })
    let store = await readCustomersStore(ws)
    expect((store['张三'] as { erp_ext?: unknown }).erp_ext).toBeUndefined()
    const created = await box.clients.list()
    expect(created.find((x) => x.name === '张三')?.erp_ext).toBeUndefined()

    await box.clients.update({ name: '张三', erp_ext: { level: 'SVIP' } } as unknown as {
      name: string
      erp_ext: unknown
    })
    store = await readCustomersStore(ws)
    expect((store['张三'] as { erp_ext?: unknown }).erp_ext).toBeUndefined()
  })
})
describe('客户服务（v2.5.3 T2：锁内读改写事务 / 并发 / 损坏 / 无变化不写盘）', () => {
  it('并发 create 不同客户：mutateJsonFile 锁内串行，8 客户全部落盘不丢', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const names = Array.from({ length: 8 }, (_, i) => `并发客${i}`)
    await Promise.all(names.map((n) => box.clients.create({ name: n, notes: n })))
    const list = await box.clients.list()
    expect(list).toHaveLength(8)
    for (const n of names) {
      expect(list.find((c) => c.name === n)?.notes).toBe(n)
    }
    const store = await readCustomersStore(ws)
    for (const n of names) expect(store[n]).toBeTruthy()
  })

  it('并发 update 不同客户：各字段更新不互丢（锁内读改写基于最新磁盘内容）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const names = Array.from({ length: 8 }, (_, i) => `并发U${i}`)
    for (const n of names) await box.clients.create({ name: n })

    await Promise.all(names.map((n, i) => box.clients.update({ name: n, phone: `1380000000${i}` })))
    const list = await box.clients.list()
    for (let i = 0; i < names.length; i++) {
      expect(list.find((c) => c.name === names[i])?.phone).toBe(`1380000000${i}`)
    }
    const store = await readCustomersStore(ws)
    for (let i = 0; i < names.length; i++) {
      expect((store[names[i]] as { phone: string }).phone).toBe(`1380000000${i}`)
    }
  })

  it('损坏 customers.json：写路径拒绝覆盖并隔离留证（.corrupt-* 备份），隔离后重建成功', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const p = path.join(ws, '.qihefilemanager', 'customers.json')
    const corrupt = '{"张三": '
    await fsp.writeFile(p, corrupt)

    // 写路径（create）：首次拒绝覆盖，损坏文件被隔离为 .corrupt-* 备份并保留原文
    // （注：客户是「目录扫描为实 + JSON 为档案」，create 先建目录再写档案——损坏拒写时目录已建，
    // 按实际恢复路径清理该残留目录后重试）
    await expect(box.clients.create({ name: '李四' })).rejects.toThrow(/损坏|覆盖/)
    const dir = path.join(ws, '.qihefilemanager')
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('customers.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(corrupt)
    await fsp.rm(path.join(ws, '客户', '李四'), { recursive: true, force: true }) // 清理残留目录

    // 隔离后重建成功
    const c = await box.clients.create({ name: '李四' })
    expect(c.name).toBe('李四')
    expect((await box.clients.list()).map((x) => x.name)).toEqual(['李四'])
  })

  it('无变化不写盘：已关联再关联 / 解除无关关联均不触碰磁盘（mtime 不变）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.clients.create({ name: '张三', notes: 'x' })
    await box.clients.linkRelation('张三', '系列A')

    const p = path.join(ws, '.qihefilemanager', 'customers.json')
    const mtime1 = (await fsp.stat(p)).mtimeMs
    await new Promise((r) => setTimeout(r, 30)) // 越过文件系统 mtime 精度
    // 已关联再关联 / 解除不存在的关联 → 无变化不写盘
    await box.clients.linkRelation('张三', '系列A')
    await box.clients.unlinkRelation('张三', '不存在关联')
    expect((await fsp.stat(p)).mtimeMs).toBe(mtime1)
    // 实际解除关联 → 落盘（mtime 变化）
    await box.clients.unlinkRelation('张三', '系列A')
    expect((await fsp.stat(p)).mtimeMs).not.toBe(mtime1)
  })
})

describe('clients.mutateCustomers（v2.5.3 P1-3：锁内增量读改写，index.ts 客户标签引用源 save 用）', () => {
  it('并发 rename/delete 不同客户不互丢（锁内读改写替代整档替换）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const names = Array.from({ length: 8 }, (_, i) => `客${i}`)
    for (const n of names) await box.clients.create({ name: n, notes: n })

    // 4 个 rename（客0..3 → 新客0..3）+ 4 个 delete（客4..7），全部并发
    const tasks: Promise<void>[] = []
    for (let i = 0; i < 4; i++) {
      const oldName = `客${i}`
      const newName = `新客${i}`
      tasks.push(
        box.clients.mutateCustomers(ws, (store) => {
          if (store[oldName] && !store[newName]) {
            store[newName] = store[oldName]
            delete store[oldName]
            return true
          }
          return false
        }),
      )
    }
    for (let i = 4; i < 8; i++) {
      const name = `客${i}`
      tasks.push(
        box.clients.mutateCustomers(ws, (store) => {
          if (store[name]) {
            delete store[name]
            return true
          }
          return false
        }),
      )
    }
    await Promise.all(tasks)

    // 全部落盘：rename 旧键消失、新键条目（notes 随条目移动）完整；delete 键消失
    const store = (await readCustomersStore(ws)) as Record<string, { notes: string }>
    for (let i = 0; i < 4; i++) {
      expect(store[`客${i}`]).toBeUndefined()
      expect(store[`新客${i}`]?.notes).toBe(`客${i}`)
    }
    for (let i = 4; i < 8; i++) expect(store[`客${i}`]).toBeUndefined()
    expect(Object.keys(store)).toHaveLength(4)
  })

  it('mutate 返回 false 不写盘（mtime 不变）；返回 true 落盘', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.clients.create({ name: '张三' })

    const p = path.join(ws, '.qihefilemanager', 'customers.json')
    // 无变化（返回 false）→ 不触碰磁盘（mtime 不变）
    await box.clients.mutateCustomers(ws, () => false)
    const mtime1 = (await fsp.stat(p)).mtimeMs
    await new Promise((r) => setTimeout(r, 30)) // 越过文件系统 mtime 精度
    await box.clients.mutateCustomers(ws, () => false)
    expect((await fsp.stat(p)).mtimeMs).toBe(mtime1)
    // 实际变更（返回 true）→ 落盘（mtime 变化）
    await box.clients.mutateCustomers(ws, (store) => {
      if (store['张三']) {
        store['张三'].notes = '改'
        return true
      }
      return false
    })
    expect((await fsp.stat(p)).mtimeMs).not.toBe(mtime1)
    const after = await readCustomersStore(ws)
    expect((after['张三'] as { notes: string }).notes).toBe('改')
  })
})