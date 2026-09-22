/**
 * v2.5.9/A9 刀 1a：`files.listSubfolders` —— 子文件夹名单**以盘为准**（主进程侧）
 *
 * 设计口径（`DESIGN-v2.5.9-A9-子文件夹以盘为准.md` §二 §三 §四）：
 *  - tab 名单 = 该实体该类型目录下**实际存在**的子目录，不再是全局 config 那张表；
 *  - **空目录要显示并淡一档** ⇒ 接口必须带 `has_files`（渲染层自己再 readdir 一次就是双源+双倍 IO）；
 *  - **顺序在主进程排完再出**（§八 实测：readdir 顺序稳定但**不是名称序**，且不保证跨平台一致
 *    ⇒ 顺序只能有一个权威，散到渲染层排第二次就是双源）；
 *  - 客户 / 供应商同一把刀（§四 N2 之甲）。
 *  - 请求形状沿用仓内既有口径（`product_set` 槽位承载实体名 + `scope`），
 *    不另发明一套字段名——同一件事在三个 API 里叫三种名字就是双源。
 *
 * ⚠ 本文件只测主进程判据；渲染层"看不见盘上新建目录"那条 P2 的端到端反证在 `tests/e2e/`（刀 1b）。
 */
import { describe, it, expect, vi } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listActualSubfolders } from '../../src/main/core/subfolders'

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-'))

async function boxWithWs() {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { box, ws }
}

describe('A9 刀1a · listSubfolders 以盘为准', () => {
  it('盘上新建的目录（config 表里没有）必须出现 —— P2 的根治判据', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    // 绕过应用，直接在硬盘上建一个目录（模拟"手工建 / 坚果云同步进来"）
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', '场景实拍'), { recursive: true })

    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.map((s) => s.name)).toContain('场景实拍')
    // 而那张全局表里确实没有它 —— 证明"看得见"不是因为表里有
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders).not.toContain('场景实拍')
  })

  it('空目录 has_files=false、有文件 has_files=true（渲染层据此淡显）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', '空的'), { recursive: true })
    const full = path.join(ws, '产品集', '系列A', '图包', '有货')
    await fsp.mkdir(full, { recursive: true })
    await fsp.writeFile(path.join(full, 'a.png'), 'x')

    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.find((s) => s.name === '空的')?.has_files).toBe(false)
    expect(got.find((s) => s.name === '有货')?.has_files).toBe(true)
  })

  it('按名称排序，且不是 readdir 原序 —— 顺序权威只能在主进程', async () => {
    const { box, ws } = await boxWithWs()
    await fsp.mkdir(path.join(ws, '产品集'), { recursive: true })
    await box.workspace.productSetCreate({ name: '系列A' })
    // 故意按"非拼音序"的创建顺序建（§八 实测本机 readdir 出来就是这个乱序形状）
    for (const n of ['主图', '白底图', '素材', '详情页']) {
      await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', n), { recursive: true })
    }
    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    // 拼音序：白(bái) < 素(sù) < 详(xiáng) < 主(zhǔ)。写死字面量而不是"用同一个比较器再排一遍"，
    // 否则这条判据就成了同义反复（生产代码不排序时它照样绿）。
    expect(got.map((s) => s.name)).toEqual(['白底图', '素材', '详情页', '主图'])
  })

  it('证书 / 文档两域各自看自己的目录（不串台）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '证书', '报关单'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '文档', '安装手册'), { recursive: true })

    const cert = await box.files.listSubfolders({ product_set: '系列A', file_type: 'cert' })
    const doc = await box.files.listSubfolders({ product_set: '系列A', file_type: 'doc' })
    expect(cert.map((s) => s.name)).toContain('报关单')
    expect(cert.map((s) => s.name)).not.toContain('安装手册')
    expect(doc.map((s) => s.name)).toContain('安装手册')
    expect(doc.map((s) => s.name)).not.toContain('报关单')
  })

  it('客户 / 供应商同形状（§四 N2 之甲）', async () => {
    const { box, ws } = await boxWithWs()
    await box.clients.create({ name: '客户甲' })
    await fsp.mkdir(path.join(ws, '客户', '客户甲', '对账明细'), { recursive: true })
    const got = await box.files.listSubfolders({ product_set: '客户甲', scope: 'customer' })
    expect(got.map((s) => s.name)).toContain('对账明细')
  })

  it('隐藏目录与文件不进名单；实体不存在返回空数组而不抛错', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    const imgs = path.join(ws, '产品集', '系列A', '图包')
    await fsp.mkdir(path.join(imgs, '.隐藏'), { recursive: true })
    await fsp.writeFile(path.join(imgs, '散落文件.png'), 'x')
    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.map((s) => s.name)).not.toContain('.隐藏')

    const none = await box.files.listSubfolders({ product_set: '不存在的集', file_type: 'image' })
    expect(none).toEqual([])
  })

  it('实体名带穿越路径必须被拒（复用既有安全闸，不是新写一套）', async () => {
    const { box } = await boxWithWs()
    await expect(
      box.files.listSubfolders({ product_set: '../../etc', file_type: 'image' }),
    ).rejects.toThrow()
  })
})

describe('A9 刀1c · productSetList 一并带回各集真实子文件夹（卡片面同一答案）', () => {
  it('每集带回自己的 image/cert/doc 实际目录（含空目录），不是全局表', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.workspace.productSetCreate({ name: '乙集' })
    await fsp.mkdir(path.join(ws, '产品集', '甲集', '图包', '甲集独有'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '乙集', '证书', '乙集证'), { recursive: true })

    const list = await box.workspace.productSetList()
    const a = list.find((p) => p.name === '甲集')!
    const b = list.find((p) => p.name === '乙集')!
    expect(a.image_folders!.map((x) => x.name)).toContain('甲集独有')
    expect(b.image_folders!.map((x) => x.name)).not.toContain('甲集独有')
    expect(b.cert_folders!.map((x) => x.name)).toContain('乙集证')
    // 空/非空标记一路带到卡片面（卡片要能区分"有货"与"空壳"）
    expect(a.image_folders!.find((x) => x.name === '甲集独有')?.has_files).toBe(false)
  })

  it('与 files.listSubfolders 给同一个答案（唯一实现，禁两处各写一遍）', async () => {
    const { box } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })
    const list = await box.workspace.productSetList()
    const viaList = list.find((p) => p.name === '甲集')!.image_folders!
    const viaApi = await box.files.listSubfolders({ product_set: '甲集', file_type: 'image' })
    expect(viaList).toEqual(viaApi)
  })
})

describe('A9 刀2b · createSubfolder 只建本集，不再自动进模板表', () => {
  it('新建子文件夹：目录落在本集，config 模板表不被改写', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })

    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '临时夹' })

    await expect(fsp.stat(path.join(ws, '产品集', '甲集', '图包', '临时夹'))).resolves.toBeTruthy()
    const cfg = await box.workspace.loadConfig(ws)
    // 旧行为：把名字 push 进全站一份的 image_subfolders（=「新建一个，未来所有集都带」）
    expect(cfg.image_subfolders).not.toContain('临时夹')
    const subs = await box.files.listSubfolders({ product_set: '甲集', file_type: 'image' })
    expect(subs.map((x) => x.name)).toContain('临时夹') // 本集看得见（盘驱动）
  })

  it('新建另一个产品集时**不会**继承甲集里新建的那个文件夹（模板没被改写过）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '只在甲' })
    await box.workspace.productSetCreate({ name: '乙集' })

    const b = await box.files.listSubfolders({ product_set: '乙集', file_type: 'image' })
    expect(b.map((x) => x.name)).not.toContain('只在甲')
    // 但模板表里本来有的默认项照旧进乙集（模板角色没坏）
    const cfg = await box.workspace.loadConfig(ws)
    for (const d of cfg.image_subfolders) expect(b.map((x) => x.name)).toContain(d)
  })

  it('客户域同口径：新建只落本客户，不写 customer_subfolders 模板', async () => {
    const { box, ws } = await boxWithWs()
    await box.clients.create({ name: '张三' })
    await box.files.createSubfolder({ product_set: '张三', scope: 'customer', file_type: '', name: '张三专夹' })
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.customer_subfolders).not.toContain('张三专夹')
    const got = await box.files.listSubfolders({ product_set: '张三', scope: 'customer' })
    expect(got.map((x) => x.name)).toContain('张三专夹')
  })
})

describe('A9 刀3b · 改名默认只改模板，改所有实体要显式点名', () => {
  /** 建两个集，各有一个同名图包子文件夹（其一有文件，便于看盘上有没有被动过） */
  async function twoSetsWithFolder() {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.workspace.productSetCreate({ name: '乙集' })
    for (const set of ['甲集', '乙集']) {
      const d = path.join(ws, '产品集', set, '图包', '场景图')
      await fsp.mkdir(d, { recursive: true })
      await fsp.writeFile(path.join(d, 'a.png'), 'x')
    }
    // 让「场景图」进模板（模拟用户在设置页登记过；新建不再自动进模板是刀2b 之后的事实）
    const cfg0 = await box.workspace.loadConfig(ws)
    cfg0.image_subfolders = [...new Set([...cfg0.image_subfolders, '场景图'])]
    await box.workspace.saveConfig(ws, cfg0)
    return { box, ws }
  }

  it('默认（不传 acrossEntities）：只改模板名，**任何实体目录都不动**', async () => {
    const { box, ws } = await twoSetsWithFolder()
    const cfg = await box.workspace.renameSubfolder('image', '场景图', '场景实拍')
    expect(cfg.image_subfolders).toContain('场景实拍')
    expect(cfg.image_subfolders).not.toContain('场景图')
    for (const set of ['甲集', '乙集']) {
      // 旧名仍在盘上、新名不存在：这是本判据的核心（旧行为会把每个集都改掉）
      await expect(fsp.stat(path.join(ws, '产品集', set, '图包', '场景图'))).resolves.toBeTruthy()
      await expect(fsp.stat(path.join(ws, '产品集', set, '图包', '场景实拍'))).rejects.toThrow()
    }
  })

  it('acrossEntities=true：才真的连所有实体一起改（能力保留，只是不再默认）', async () => {
    const { box, ws } = await twoSetsWithFolder()
    await box.workspace.renameSubfolder('image', '场景图', '场景实拍', { acrossEntities: true })
    for (const set of ['甲集', '乙集']) {
      await expect(fsp.stat(path.join(ws, '产品集', set, '图包', '场景实拍'))).resolves.toBeTruthy()
      await expect(fsp.stat(path.join(ws, '产品集', set, '图包', '场景图'))).rejects.toThrow()
      // 文件跟着目录走（改名不是复制：盘上还是那个 a.png）
      await expect(fsp.readFile(path.join(ws, '产品集', set, '图包', '场景实拍', 'a.png'), 'utf8')).resolves.toBe('x')
    }
  })

  it('只改模板时，若某实体里根本没有该文件夹，也不报错（旧行为同样不动盘）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '甲集' })
    const cfg0 = await box.workspace.loadConfig(ws)
    cfg0.image_subfolders = [...new Set([...cfg0.image_subfolders, '只存在于模板'])]
    await box.workspace.saveConfig(ws, cfg0)
    const cfg = await box.workspace.renameSubfolder('image', '只存在于模板', '换了个名')
    expect(cfg.image_subfolders).toContain('换了个名')
  })
})

describe('A9 刀5 · 客户/供应商内部挪（tab → tab）', () => {
  it('客户：同一实体内从一个子文件夹挪进另一个，盘上落位正确', async () => {
    const { box, ws } = await boxWithWs()
    await box.clients.create({ name: '华东客户' })
    const base = path.join(ws, '客户', '华东客户')
    await fsp.mkdir(path.join(base, '沟通'), { recursive: true })
    await fsp.mkdir(path.join(base, '归档'), { recursive: true })
    const f = path.join(base, '沟通', '报价.pdf')
    await fsp.writeFile(f, 'pdf')

    const r = await box.files.moveFiles({
      paths: [f],
      scope: 'customer',
      target_product_set: '华东客户',
      sub_folder: '归档',
    })
    expect(r.failed).toHaveLength(0)
    expect(r.moved).toHaveLength(1)
    await expect(fsp.stat(path.join(base, '归档', '报价.pdf'))).resolves.toBeTruthy()
    await expect(fsp.stat(f)).rejects.toThrow()
    // 挪完之后 tab 列表仍以盘为准：目标在、源目录空着也还在（且标出"没文件"）
    const subs = await listActualSubfolders(base)
    // 只看本次造的两个（`clients.create` 还会按模板建出 报价/合同/其他 等，与本判据无关）
    const mine = subs.filter((e) => ['归档', '沟通'].includes(e.name))
    expect(mine.map((e) => e.name)).toEqual(['沟通', '归档']) // 名称序（gou < gui），非创建序
    expect(mine.find((e) => e.name === '沟通')?.has_files).toBe(false)
    expect(mine.find((e) => e.name === '归档')?.has_files).toBe(true)
  })

  it('供应商：同一条 scope 分支不能被漏掉', async () => {
    const { box, ws } = await boxWithWs()
    await box.suppliers.create({ name: '北方厂' })
    const base = path.join(ws, '供应商', '北方厂')
    await fsp.mkdir(path.join(base, '样品'), { recursive: true })
    await fsp.mkdir(path.join(base, '合同'), { recursive: true })
    const f = path.join(base, '样品', 'a4.pdf')
    await fsp.writeFile(f, 'x')
    const r = await box.files.moveFiles({
      paths: [f],
      scope: 'supplier',
      target_product_set: '北方厂',
      sub_folder: '合同',
    })
    expect(r.failed).toHaveLength(0)
    await expect(fsp.stat(path.join(base, '合同', 'a4.pdf'))).resolves.toBeTruthy()
  })

  it('客户内部挪动后**标签必须跟着走**（与产品集内部移动同口径，不许另起一套）', async () => {
    const { box, ws } = await boxWithWs()
    await box.clients.create({ name: '华东客户' })
    const base = path.join(ws, '客户', '华东客户')
    await fsp.mkdir(path.join(base, '沟通'), { recursive: true })
    await fsp.mkdir(path.join(base, '归档'), { recursive: true })
    const f = path.join(base, '沟通', '带标签.pdf')
    await fsp.writeFile(f, 'x')
    await box.metadata.update({ file_path: f, tags: ['重点'] })
    await box.files.moveFiles({
      paths: [f],
      scope: 'customer',
      target_product_set: '华东客户',
      sub_folder: '归档',
    })
    const after = await box.metadata.get(path.join(base, '归档', '带标签.pdf'))
    expect(after.tags).toEqual(['重点'])
    // 旧 key 不许留下僵尸条目（否则元数据只会越积越脏）
    const stale = await box.metadata.get(f)
    expect(stale.tags ?? []).toHaveLength(0)
  })
})

// —— 刀6：悬案·实体页「就地改名」（2026-09-21）——
// 与 刀3b 的 `renameSubfolder` 是两把不同的刀：
//   刀3b = 改**模板**（默认）或**所有实体**（⇌）；本刀 = 只改**一个实体下**的那一个目录。
describe('悬案 · 就地改名 renameSubfolderInEntity', () => {
  it('只改点名那一个实体的盘上目录：模板表与其他实体都不动', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.renameSubfolder('image', '主图', '首图') // 模板：主图 → 首图
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.workspace.productSetCreate({ name: '乙集' })
    await box.workspace.productSetCreate({ name: '丙集' })

    await box.workspace.renameSubfolderInEntity('image', '乙集', '首图', '乙特供')

    // ① 盘上：只有乙集那个目录换了名
    const dirs = async (ps: string) =>
      (await listActualSubfolders(path.join(ws, '产品集', ps, '图包'))).map((e) => e.name)
    expect(await dirs('乙集')).toContain('乙特供')
    expect(await dirs('乙集')).not.toContain('首图')
    // ② 其他实体原样：模板那几个目录都在，且**没有**被塞进「乙特供」
    expect(await dirs('甲集')).toContain('首图')
    expect(await dirs('甲集')).not.toContain('乙特供')
    expect(await dirs('丙集')).toContain('首图')
    expect(await dirs('丙集')).not.toContain('乙特供')
    // ③ 模板表没被碰（仍是「首图」，不会变成「乙特供」）
    const cfg = await box.workspace.getConfig()
    expect(cfg.image_subfolders).toContain('首图')
    expect(cfg.image_subfolders).not.toContain('乙特供')
    expect(cfg.image_subfolders).not.toContain('主图')
    // ④ 反向锚点：正因为模板没改，**新建**的实体仍旧拿到模板名（这正是"只影响一个"的证明）
    await box.workspace.productSetCreate({ name: '丁集' })
    expect(await dirs('丁集')).toContain('首图')
    expect(await dirs('丁集')).not.toContain('乙特供')
  })

  it('重名/不存在/内建笔记三条红线照旧挡（就地改名不是后门）', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })

    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '占位', scope: 'productSet' })
    await expect(
      box.workspace.renameSubfolderInEntity('image', '甲集', '占位', '主图'), // 目标已存在
    ).rejects.toThrow(/已存在同名目录/)
    await expect(
      box.workspace.renameSubfolderInEntity('image', '甲集', '压根没有', '随便'),
    ).rejects.toThrow(/不存在/)
    await expect(
      box.workspace.renameSubfolderInEntity('image', '甲集', '主图', '笔记'),
    ).rejects.toThrow(/不能重命名为/)
    expect(ws).toBeTruthy()
  })
})

// —— 刀6 补（批 2.5 · P1-9）：改名后的**数据面**联动 ——
// 元数据 key 与缩略图缓存 key 都是「相对工作区路径」的单向推导（`metadata.fileMetadataKey` /
// `paths.thumbnailPath` 的 sha256），目录一改名，夹内每个文件的 key 全体变样：
// 旧条目留在原地成僵尸、新路径读到空 ⇒ 用户看到标签/备注/到期日"凭空消失"。
// 这是数据面改动，判据必须逐条钉住「旧 key 不留、新 key 内容一字不差」。
describe('悬案 · 就地改名后的元数据联动（P1-9）', () => {
  it('改名把夹内文件的 metadata key 一起搬走：标签/备注跟到新路径，旧 key 不留僵尸', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '首图', scope: 'productSet' })

    const oldDir = path.join(ws, '产品集', '甲集', '图包', '首图')
    const oldFile = path.join(oldDir, 'a.png')
    await fsp.writeFile(oldFile, 'png')
    await box.metadata.update({ file_path: oldFile, tags: ['重点'], notes: '别删这行' })
    expect((await box.metadata.get(oldFile)).tags).toEqual(['重点']) // 前置：改名前的 key 确实带数据

    await box.workspace.renameSubfolderInEntity('image', '甲集', '首图', '新首图')

    const newFile = path.join(ws, '产品集', '甲集', '图包', '新首图', 'a.png')
    const after = await box.metadata.get(newFile)
    expect(after.tags).toEqual(['重点'])
    expect(after.notes).toBe('别删这行')
    // 旧 key 不留僵尸条目（否则元数据只会越积越脏）
    expect((await box.metadata.get(oldFile)).tags ?? []).toEqual([])
  })

  it('acrossEntities 改名（改所有实体）逐实体都迁：两个集里的标签都不丢', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.workspace.productSetCreate({ name: '乙集' })
    for (const ps of ['甲集', '乙集']) {
      const f = path.join(ws, '产品集', ps, '图包', '主图', `${ps}.png`)
      await fsp.writeFile(f, 'png')
      await box.metadata.update({ file_path: f, tags: ['重点'] })
    }

    await box.workspace.renameSubfolder('image', '主图', '首图', { acrossEntities: true })

    for (const ps of ['甲集', '乙集']) {
      const f = path.join(ws, '产品集', ps, '图包', '首图', `${ps}.png`)
      expect((await box.metadata.get(f)).tags, `${ps} 的标签应跟到新目录`).toEqual(['重点'])
      expect((await box.metadata.get(path.join(ws, '产品集', ps, '图包', '主图', `${ps}.png`))).tags ?? [])
        .toEqual([])
    }
  })

  it('客户区改名（key 相对工作区根）同样迁：标签不因目录名换了就丢', async () => {
    // 键规则两分支：产品集内相对「产品集/」、其余相对工作区根（metadata.fileMetadataKey）。
    // 上一条只钉住了产品集分支，这条钉客户分支——界面上的"就地改名"就发生在客户/供应商 tab 上。
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.clients.create({ name: '华东客户' })
    // 客户模板默认就含「沟通」（customer_subfolders），直接用；再手建一个是为了证明迁的是盘上真目录
    const oldFile = path.join(ws, '客户', '华东客户', '沟通', '合同.pdf')
    await fsp.writeFile(oldFile, 'pdf')
    await box.metadata.update({ file_path: oldFile, notes: '客户原件' })

    await box.workspace.renameSubfolderInEntity('customer', '华东客户', '沟通', '往来')

    const newFile = path.join(ws, '客户', '华东客户', '往来', '合同.pdf')
    expect((await box.metadata.get(newFile)).notes).toBe('客户原件')
    expect((await box.metadata.get(oldFile)).notes ?? '').toBe('')
  })

  it('metadata.json 损坏时不借改名之手抹档案：拒绝覆盖 + 留证，盘上目录照旧改名', async () => {
    // 数据面改动的兜底判据：迁 key 是「读→改→写」整档重写，若把损坏档案当空库起步就会**一次性清空**
    // 全部标签/备注。jsonStore 的写入路径对此有守卫（严格读 + 隔离备份 + 拒绝覆盖），本迁移显式带
    // `validate` 走同一条路——这条钉住它别被后手拆掉。
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '首图', scope: 'productSet' })
    const junk = '{坏掉的json!!'
    const storePath = path.join(ws, '.qihefilemanager', 'metadata.json')
    await fsp.writeFile(storePath, junk, 'utf-8')

    await expect(box.workspace.renameSubfolderInEntity('image', '甲集', '首图', '新首图')).rejects.toThrow()

    const entries = await fsp.readdir(path.join(ws, '.qihefilemanager'))
    const backup = entries.find((f) => f.startsWith('metadata.json.corrupt-'))
    expect(backup, '损坏档案必须留证（.corrupt-*）').toBeTruthy()
    expect(await fsp.readFile(path.join(ws, '.qihefilemanager', backup!), 'utf-8')).toBe(junk)
    // 透明口径：目录改名在写元数据之前就落盘了（与 files.renameFile 同序），报错是"元数据没跟上"而不是"改名没做"
    expect(await fsp.stat(path.join(ws, '产品集', '甲集', '图包', '新首图')).then(() => true).catch(() => false)).toBe(true)
  })

  it('夹里没有任何元数据时，改名不白写整档 metadata.json（没命中就一个字节都不动）', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '首图', scope: 'productSet' })
    await fsp.writeFile(path.join(ws, '产品集', '甲集', '图包', '首图', '无标签.png'), 'png')
    const store = path.join(ws, '.qihefilemanager', 'metadata.json')
    expect(await fsp.stat(store).then(() => true).catch(() => false), '前置：还没有人写过元数据').toBe(false)

    await box.workspace.renameSubfolderInEntity('image', '甲集', '首图', '新首图')

    expect(await fsp.stat(store).then(() => true).catch(() => false), '没得迁就不该凭空造出 metadata.json').toBe(false)
  })

  it('目标 key 被「回收站幽灵条目」占住时源侧优先：标签判给活文件，旧 key 不留悬空条目（v2.6 审查轮 1）', async () => {
    // 复现链（逐环都是既有口径，不是构造的怪状态）：
    //   ① 回收站**不清理元数据**（`trash.ts` trashItem 头注释：恢复要原样还原）⇒ 盘上不存在的路径
    //      照样有条目，这是常态；
    //   ② 目录改名要求**目标目录在盘上不存在**（renameSubfolderInEntity 的 `fsp.stat(to)` 守卫）
    //      ⇒ 任何占用「新前缀/…」这个 key 的条目必然是幽灵（没有活文件）；
    //   ③ 而迁移回调遇到「新 key 已有内容」就 `continue`（照 moveFiles 的保守语义搬来的）⇒ 活文件的
    //      标签根本没跟过去，旧 key 悬空留在已不存在的目录上，界面按新路径读出来的是**已删文件**的标签。
    // 家底：`moveFiles` 两个 key 都可能有活文件，保守跳过才合理；目录改名语境不同（②），该源侧优先。
    // 目录名刻意避开默认模板（主图/详情页/白底图/素材）——本用例要自己掌控盘上目录的生死。
    const home = await tmp()
    const box = buildTestBox(home)
    const ws = path.join(home, 'ws')
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '甲集' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '存档A', scope: 'productSet' })

    // ① 存档A/a.png 存在过、打过 T1，随后进回收站（条目按 trash 口径留在原地）
    const ghost = path.join(ws, '产品集', '甲集', '图包', '存档A', 'a.png')
    await fsp.writeFile(ghost, 'png')
    await box.metadata.update({ file_path: ghost, tags: ['T1'] })
    const del = await box.files.fileDelete([ghost])
    expect(del.deleted, '前置：文件确实进了回收站').toBe(1)
    expect(await fsp.stat(ghost).then(() => true).catch(() => false), '前置：盘上已无此文件').toBe(false)
    expect((await box.metadata.get(ghost)).tags, '前置：幽灵条目仍带 T1（回收站不清元数据）').toEqual(['T1'])

    // ② 存档A 整个删掉（盘上不存在）→ 建 存档B/a.png 打 T2
    await box.files.deleteSubfolder({ product_set: '甲集', file_type: 'image', name: '存档A', scope: 'productSet' })
    await box.files.createSubfolder({ product_set: '甲集', file_type: 'image', name: '存档B', scope: 'productSet' })
    const live = path.join(ws, '产品集', '甲集', '图包', '存档B', 'a.png')
    await fsp.writeFile(live, 'png')
    await box.metadata.update({ file_path: live, tags: ['T2'] })

    // ③ 存档B → 存档A（合法：目标目录盘的没有 ⇒ 占用 key 的只能是 ① 的幽灵）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // ⚠ 调用记录必须在 mockRestore **之前**取走：vitest 的 mockRestore = mockReset + 还原实现，会清空 calls
    let warned = ''
    try {
      await box.workspace.renameSubfolderInEntity('image', '甲集', '存档B', '存档A')
    } finally {
      warned = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      warnSpy.mockRestore()
    }

    const renamed = path.join(ws, '产品集', '甲集', '图包', '存档A', 'a.png')
    const got = await box.metadata.get(renamed)
    expect(got.tags, '活文件的标签必须跟着目录走（不许被幽灵条目顶掉，否则界面把已删文件的标签显示给活文件）').toEqual(['T2'])
    expect((await box.metadata.get(live)).tags ?? [], '旧 key 不许留悬空条目（否则元数据只会越积越脏）').toEqual([])
    // 幽灵的占用不是静默丢弃：留一行可查（顶替是不可逆的，用户从回收站恢复时会看到标签换了主人）
    expect(warned, '顶掉幽灵条目要留痕（不许静默）').toContain('幽灵条目')
    expect(warned, '留痕要指名道姓，否则运维查不到是哪一条被顶掉').toContain('存档A/a.png')
  })
})
