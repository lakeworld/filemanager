/**
 * shareView 单测（v2.5.1 A2：share 能力域 core，PLAN-v2.6-v2.7 §3.2）
 * 覆盖：
 * - 实体视图字段白名单（不含 erp_ext / ocr_ext 命名空间）
 * - mergeTagsNotes 全分支（并集/本地空采纳/冲突保留本地，D10）
 * - path 粒度两级（文件路径 → metadata store / 产品集根路径 → product_sets.json）
 * - 树组装隐藏目录排除（.qihefilemanager 等）
 * - ensureProductSet/ensureCustomer 同名合并；拉取写拒绝清单（D18）
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { ShareViewService, mergeTagsNotes, isHiddenRelPath } from '../../src/main/core/shareView'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-share-'))
}

async function makeBox(): Promise<{ home: string; ws: string; box: ReturnType<typeof buildTestBox> }> {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { home, ws, box }
}

// —— mergeTagsNotes 纯函数（D10）——

describe('mergeTagsNotes（D10 两级粒度合并）', () => {
  it('tags 并集：本地 + 远端去重', () => {
    expect(mergeTagsNotes({ tags: ['a', 'b'], notes: '本地' }, { tags: ['b', 'c'], notes: '远端' })).toEqual({
      tags: ['a', 'b', 'c'],
      notes: '本地',
      conflict: true,
    })
  })

  it('本地 notes 为空 → 采纳远端', () => {
    expect(mergeTagsNotes({ tags: [], notes: '' }, { tags: ['x'], notes: '远端' })).toEqual({
      tags: ['x'],
      notes: '远端',
      conflict: false,
    })
  })

  it('本地 notes 非空且相同 → 保留本地无冲突', () => {
    expect(mergeTagsNotes({ tags: [], notes: 'same' }, { tags: [], notes: 'same' })).toEqual({
      tags: [],
      notes: 'same',
      conflict: false,
    })
  })
})

// —— isHiddenRelPath（D18 拒绝清单）——

describe('isHiddenRelPath（D18）', () => {
  it('拒绝 .qihefilemanager/ 与其下任意路径（含 trash）', () => {
    expect(isHiddenRelPath('.qihefilemanager/customers.json')).toBe(true)
    expect(isHiddenRelPath('.qihefilemanager/trash/a.jpg')).toBe(true)
  })
  it('拒绝 导出/ 与 交换区/', () => {
    expect(isHiddenRelPath('导出/a.zip')).toBe(true)
    expect(isHiddenRelPath('交换区/x.pdf')).toBe(true)
  })
  it('正常路径放行', () => {
    expect(isHiddenRelPath('产品集/PS1/图包/a.jpg')).toBe(false)
    expect(isHiddenRelPath('客户/张三/报价/a.pdf')).toBe(false)
  })
})

// —— ShareViewService（core 整链）——

describe('ShareViewService（v2.5.1 A2）', () => {
  it('listProductSets：实体视图字段白名单（tags/notes 有，erp_ext/ocr_ext 无）', async () => {
    const { ws, box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['t'], notes: 'n' })
    const svc = new ShareViewService(box)
    const sets = (await svc.listProductSets()) as { name: string; tags: string[]; notes: string }[]
    expect(sets).toHaveLength(1)
    expect(sets[0].name).toBe('PS1')
    expect(sets[0].tags).toEqual(['t'])
    expect(sets[0].notes).toBe('n')
    expect('erp_ext' in sets[0]).toBe(false)
    expect('ocr_ext' in sets[0]).toBe(false)
  })

  it('listCustomers：白名单字段（不含 erp_ext 命名空间）', async () => {
    const { box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138' })
    await box.clients.writeErpExt('张三', { code: 'C1' })
    const svc = new ShareViewService(box)
    const customers = (await svc.listCustomers()) as { name: string; phone: string }[]
    expect(customers).toHaveLength(1)
    expect(customers[0].name).toBe('张三')
    expect(customers[0].phone).toBe('138')
    expect('erp_ext' in customers[0]).toBe(false)
  })

  it('v2.5.4 C-5b 转调等价：share.listCustomers 与 customer 实体域同源（同名集；共享字段一致；仅命名空间剥离）', async () => {
    const { box } = await makeBox()
    await box.clients.create({ name: '甲', phone: '139', notes: '重要' })
    await box.clients.create({ name: '乙', phone: '138', notes: '' })
    await box.clients.writeErpExt('甲', { code: 'C-A' })
    const svc = new ShareViewService(box)

    const shareCusts = (await svc.listCustomers()) as { name: string; phone: string; notes: string; erp_ext?: unknown }[]
    const entityCusts = await box.clients.list()

    const shareNames = shareCusts.map((c) => c.name).sort()
    const entityNames = entityCusts.map((c) => c.name).sort()
    expect(shareNames).toEqual(entityNames) // 同源：同一客户集合
    expect(shareCusts.find((c) => c.name === '甲')?.phone).toBe('139') // 共享业务字段一致
    expect(shareCusts.find((c) => c.name === '甲')?.notes).toBe('重要')
    expect('erp_ext' in (shareCusts.find((c) => c.name === '甲') ?? {})).toBe(false) // share 视图剥离命名空间
    expect(entityCusts.find((c) => c.name === '甲')?.erp_ext).toEqual({ code: 'C-A' }) // 实体域保留
  })

  it('listTree：一层目录（名称/类型/大小/mtime），隐藏目录排除', async () => {
    const { ws, box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1' })
    await fsp.mkdir(path.join(ws, '.qihefilemanager'), { recursive: true })
    const svc = new ShareViewService(box)
    const tree = (await svc.listTree()) as { name: string; kind: string }[]
    const names = tree.map((e) => e.name)
    expect(names).toContain('产品集')
    expect(names).toContain('客户')
    expect(names).not.toContain('.qihefilemanager')
    const dir = tree.find((e) => e.name === '产品集')
    expect(dir?.kind).toBe('dir')
  })

  it('getMetadata：文件路径 → metadata store；产品集根 → product_sets.json（两级粒度 D10）', async () => {
    const { ws, box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['ps-tag'], notes: 'ps-note' })
    // 写一个文件 + 元数据
    const dir = path.join(ws, '产品集', 'PS1', '图包')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'a.jpg')
    await fsp.writeFile(file, 'x')
    await box.metadata.update({ file_path: file, tags: ['f-tag'], notes: 'f-note' })
    const svc = new ShareViewService(box)
    // 文件级
    const fileMeta = await svc.getMetadata('产品集/PS1/图包/a.jpg')
    expect(fileMeta.tags).toContain('f-tag')
    expect(fileMeta.notes).toBe('f-note')
    // 产品集根级
    const psMeta = await svc.getMetadata('产品集/PS1')
    expect(psMeta.tags).toContain('ps-tag')
    expect(psMeta.notes).toBe('ps-note')
  })

  it('statFile / readFileChunk：定位读与越界截断（≤4MB/chunk）', async () => {
    const { ws, box } = await makeBox()
    const dir = path.join(ws, '产品集', 'PS1')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'data.bin')
    await fsp.writeFile(file, Buffer.alloc(100, 0x41))
    const svc = new ShareViewService(box)
    const st = await svc.statFile('产品集/PS1/data.bin')
    expect(st.size).toBe(100)
    const chunk = await svc.readFileChunk('产品集/PS1/data.bin', 50, 30)
    expect(chunk.byteLength).toBe(30)
    // 越界 → 短读截断到 EOF
    const tail = await svc.readFileChunk('产品集/PS1/data.bin', 90, 30)
    expect(tail.byteLength).toBe(10)
  })

  it('writePulledFile：offset 定位写 + 拒绝清单（.qihefilemanager/导出/交换区）→ HIDDEN', async () => {
    const { ws, box } = await makeBox()
    const svc = new ShareViewService(box)
    await svc.writePulledFile('产品集/PS1/图包/new.jpg', new Uint8Array([1, 2, 3]), 0)
    const p = path.join(ws, '产品集', 'PS1', '图包', 'new.jpg')
    expect((await fsp.readFile(p)).length).toBe(3)
    // 续写
    await svc.writePulledFile('产品集/PS1/图包/new.jpg', new Uint8Array([4]), 3)
    expect((await fsp.readFile(p)).length).toBe(4)
    // 拒绝清单
    await expect(svc.writePulledFile('.qihefilemanager/x', new Uint8Array([1]), 0)).rejects.toThrow('隐藏目录')
    await expect(svc.writePulledFile('导出/x', new Uint8Array([1]), 0)).rejects.toThrow('隐藏目录')
    await expect(svc.writePulledFile('交换区/x', new Uint8Array([1]), 0)).rejects.toThrow('隐藏目录')
    // 逃逸
    await expect(svc.writePulledFile('../x', new Uint8Array([1]), 0)).rejects.toThrow()
  })

  it('writePulledFile：多级 sku 深路径两段写 → 落盘/回读/树大小一致（h2 疑点）', async () => {
    const { ws, box } = await makeBox()
    const svc = new ShareViewService(box)
    const rel = '产品集/D1/图包/sku/SKU--01.jpg'
    const part1 = new Uint8Array(1000).fill(0xab)
    const part2 = new Uint8Array(500).fill(0xcd)
    await svc.writePulledFile(rel, part1, 0)
    await svc.writePulledFile(rel, part2, 1000)
    const expected = Buffer.concat([Buffer.from(part1), Buffer.from(part2)])
    expect(expected.length).toBe(1500)
    // 目录树恰含 1 个 file 条目且 size=1500
    const tree = (await svc.listTree('产品集/D1/图包/sku')) as { name: string; kind: string; size: number }[]
    expect(tree).toHaveLength(1)
    expect(tree[0].name).toBe('SKU--01.jpg')
    expect(tree[0].kind).toBe('file')
    expect(tree[0].size).toBe(1500)
    // statFile 同路径 size=1500
    const st = await svc.statFile(rel)
    expect(st.size).toBe(1500)
    // readFileChunk 回读 0..1500 与写入字节完全一致
    const back = await svc.readFileChunk(rel, 0, 1500)
    expect(Buffer.from(back).equals(expected)).toBe(true)
    // 磁盘落盘核对（h2 疑点就是「拉取不落盘」）
    const onDisk = await fsp.readFile(path.join(ws, '产品集', 'D1', '图包', 'sku', 'SKU--01.jpg'))
    expect(onDisk.equals(expected)).toBe(true)
    // 拒绝清单门禁不因新用例改变：隐藏目录仍抛错
    await expect(svc.writePulledFile('.qihefilemanager/x', new Uint8Array([1]), 0)).rejects.toThrow('隐藏目录')
    await expect(svc.writePulledFile('导出/x', new Uint8Array([1]), 0)).rejects.toThrow('隐藏目录')
  })

  it('ensureProductSet / ensureCustomer：同名合并 → exists，新建 → created', async () => {
    const { box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1' })
    await box.clients.create({ name: '张三' })
    const svc = new ShareViewService(box)
    expect(await svc.ensureProductSet('PS1')).toBe('exists')
    expect(await svc.ensureProductSet('PS2')).toBe('created')
    expect(await svc.ensureCustomer('张三')).toBe('exists')
    expect(await svc.ensureCustomer('李四')).toBe('created')
  })

  it('mergePulledMetadata：两级合并 + 冲突清单 + ≤500 批限', async () => {
    const { ws, box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['ps'], notes: 'ps-local' })
    const dir = path.join(ws, '产品集', 'PS1', '图包')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'a.jpg')
    await fsp.writeFile(file, 'x')
    await box.metadata.update({ file_path: file, tags: ['f1'], notes: 'local-note' })
    const svc = new ShareViewService(box)
    const r = await svc.mergePulledMetadata([
      { path: '产品集/PS1/图包/a.jpg', tags: ['f2'], notes: 'remote-note' },
      { path: '产品集/PS1', tags: ['ps2'], notes: 'ps-remote' },
    ])
    // 文件级：tags 并集 + 本地 notes 保留（冲突）
    expect(r.conflicts).toContain('产品集/PS1/图包/a.jpg')
    const fileMeta = await box.metadata.get(file)
    expect(fileMeta.tags).toEqual(['f1', 'f2'])
    expect(fileMeta.notes).toBe('local-note')
    // 产品集根级：tags 并集 + 本地 notes 保留
    expect(r.conflicts).toContain('产品集/PS1')
    const psExtra = await box.workspace.loadProductSetsInfo()
    expect(psExtra['PS1'].tags).toEqual(['ps', 'ps2'])
    expect(psExtra['PS1'].notes).toBe('ps-local')
    // 批限
    const many = Array.from({ length: 501 }, (_, i) => ({ path: `产品集/PS1/图包/x${i}.jpg`, tags: [], notes: '' }))
    await expect(svc.mergePulledMetadata(many)).rejects.toThrow('500')
  })
})

describe('ensureSubfolder（LAN v0.2.3 自动注册拉取子文件夹白名单）', () => {
  it('图包子文件夹：缺失目录 → 创建 + 注册 + 幂等去重', async () => {
    const { ws, box } = await makeBox()
    const svc = new ShareViewService(box)
    await svc.ensureSubfolder('image', '夏季新款', 'sku')
    await svc.ensureSubfolder('image', '夏季新款', 'sku') // 幂等
    const dir = path.join(ws, '产品集', '夏季新款', '图包', 'sku')
    expect((await fsp.stat(dir)).isDirectory()).toBe(true)
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders.filter((x) => x === 'sku')).toHaveLength(1)
  })

  it('已存在的目录：仅补注册，不抛「子文件夹已存在」', async () => {
    const { ws, box } = await makeBox()
    await fsp.mkdir(path.join(ws, '产品集', '夏季新款', '图包', '白底'), { recursive: true })
    const svc = new ShareViewService(box)
    await svc.ensureSubfolder('image', '夏季新款', '白底')
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders).toContain('白底')
  })

  it.each([
    ['cert', '证书', '质检'],
    ['doc', '文档', '参数表'],
  ])('%s 子文件夹注册到对应白名单', async (kind, label, name) => {
    const { ws, box } = await makeBox()
    const svc = new ShareViewService(box)
    await svc.ensureSubfolder(kind as 'cert' | 'doc', '夏季新款', name)
    const dir = path.join(ws, '产品集', '夏季新款', label, name)
    expect((await fsp.stat(dir)).isDirectory()).toBe(true)
    const cfg = await box.workspace.loadConfig(ws)
    const list = kind === 'cert' ? cfg.cert_subfolders : cfg.doc_subfolders
    expect(list).toContain(name)
  })

  it('客户子文件夹：客户/<名>/<子> + customer_subfolders 注册', async () => {
    const { ws, box } = await makeBox()
    const svc = new ShareViewService(box)
    await svc.ensureCustomer('华东客户')
    await svc.ensureSubfolder('customer', '华东客户', '沟通')
    const dir = path.join(ws, '客户', '华东客户', '沟通')
    expect((await fsp.stat(dir)).isDirectory()).toBe(true)
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.customer_subfolders).toContain('沟通')
  })

  it('非法名称/非法 kind → 拒绝', async () => {
    const { box } = await makeBox()
    const svc = new ShareViewService(box)
    await expect(svc.ensureSubfolder('image', '夏季新款', '../evil')).rejects.toThrow()
    await expect(svc.ensureSubfolder('image', '../x', 'sku')).rejects.toThrow()
    await expect(svc.ensureSubfolder('bogus' as never, '夏季新款', 'sku')).rejects.toThrow(/kind/)
  })

  it('v2.5.5：注册成功后触发 onSubfolderRegistered 回调（渲染侧面板刷新事件源）', async () => {
    const { box } = await makeBox()
    const registered: { kind: string; holder: string; name: string }[] = []
    const svc = new ShareViewService(box, { onSubfolderRegistered: (info) => registered.push(info) })
    await svc.ensureSubfolder('image', '夏季新款', '白底')
    await svc.ensureSubfolder('customer', '华东客户', '沟通')
    await svc.ensureSubfolder('cert', '夏季新款', '质检')
    await svc.ensureSubfolder('doc', '夏季新款', '说明书')
    // 四类 kind 逐一核对回调携带正确载荷（渲染侧刷新据此路由）
    expect(registered).toEqual([
      { kind: 'image', holder: '夏季新款', name: '白底' },
      { kind: 'customer', holder: '华东客户', name: '沟通' },
      { kind: 'cert', holder: '夏季新款', name: '质检' },
      { kind: 'doc', holder: '夏季新款', name: '说明书' },
    ])
  })
})
