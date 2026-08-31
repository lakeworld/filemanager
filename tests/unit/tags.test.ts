import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-'))
}

/** 内置固定色标签名（与 core/tags.ts BUILTIN_TAGS 保持一致） */
const BUILTIN_NAMES = ['重要', '待更新', '已更新', '问题', '归档']

/** 系列A/图包/主图/a.jpg 的绝对路径（元数据按路径推导 key；文件无需真实存在） */
const metaPath = (ws: string, name = 'a.jpg'): string =>
  path.join(ws, '产品集', '系列A', '图包', '主图', name)

describe('标签体系（v2.0.2 / v2.3.2 迁移）', () => {
  it('首次 list() 一次性迁移：清除内置固定色标签定义与引用，写入迁移标记', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 构造含 builtin 定义的 tags.json + 引用内置名的 metadata / product_sets
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重要', '自定义'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重要', '待更新', '野生标'] })
    await fsp.writeFile(
      path.join(ws, '.qihefilemanager', 'tags.json'),
      JSON.stringify({
        重要: { color: '#ef4444', builtin: true },
        待更新: { color: '#f97316', builtin: true },
        已更新: { color: '#22c55e', builtin: true },
        问题: { color: '#eab308', builtin: true },
        归档: { color: '#64748b', builtin: true },
        自定义: { color: '#123456' },
      }),
    )

    const tags = await box.tags.list()
    // 内置 5 色不再出现（定义已删、引用已清）
    for (const n of BUILTIN_NAMES) {
      expect(tags.find((t) => t.name === n)).toBeFalsy()
    }
    // 非内置自定义标签保留
    expect(tags.find((t) => t.name === '自定义')?.defined).toBe(true)
    // 引用清理：文件与产品集的 tags 不再含内置名
    const meta = await box.metadata.get(metaPath(ws))
    expect(meta.tags).toEqual(['野生标'])
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual(['自定义'])
    // 迁移标记写入且不暴露为真实标签
    const defs = JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'tags.json'), 'utf-8'))
    expect(defs._migrated_builtin).toEqual({ color: '' })
    expect(tags.find((t) => t.name === '_migrated_builtin')).toBeFalsy()
  })

  it('第二次 list() 不再补全任何标签（新建标签不会被覆盖/补回）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list() // 首次触发迁移（写入标记）

    await box.tags.create('用户标签', '#123456')
    const tags = await box.tags.list() // 第二次：不应再补全内置标签
    expect(tags.find((t) => t.name === '用户标签')?.defined).toBe(true)
    for (const n of BUILTIN_NAMES) {
      expect(tags.find((t) => t.name === n)).toBeFalsy()
    }
  })

  it('迁移标记键：不暴露为真实标签，create 拒绝同名', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list()
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '_migrated_builtin')).toBeFalsy()
    await expect(box.tags.create('_migrated_builtin', '#000000')).rejects.toThrow('系统保留')
  })

  it('删除标签后不再复活（含用户自建的同名内置色标签）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list() // 迁移完成，无内置标签
    await box.tags.create('重要', '#ef4444') // 用户可自由重建同名标签
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重要'] })

    await box.tags.delete('重要')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '重要')).toBeFalsy()
    // 再次 list 仍不出现（不复活）
    const again = await box.tags.list()
    expect(again.find((t) => t.name === '重要')).toBeFalsy()
  })

  it('颜色均可改（不再有固定色不可改限制）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list()
    await box.tags.create('重要', '#ef4444')
    await box.tags.setColor('重要', '#000000')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '重要')?.color).toBe('#000000')
  })

  it('create + setColor + list 聚合（文件 + 产品集计数）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重点'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['重点', '跟进中'] })

    await box.tags.create('重点', '#ef4444')
    await box.tags.create('跟进中', '#f59e0b')

    const tags = await box.tags.list()
    const important = tags.find((t) => t.name === '重点')
    expect(important?.color).toBe('#ef4444')
    expect(important?.count).toBe(2) // 1 文件 + 1 产品集
    const pending = tags.find((t) => t.name === '跟进中')
    expect(pending?.count).toBe(1)
  })

  it('父/子标签：create 子标签 + list 树形 + setParent 提升', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await box.tags.create('证书类', '#0ea5e9')
    await box.tags.create('3C', '#0ea5e9', '证书类')
    await box.tags.create('质检', '#0ea5e9', '证书类')

    const tags = await box.tags.list()
    const parent = tags.find((t) => t.name === '证书类')
    expect(parent?.children).toEqual(['3C', '质检'])
    const child = tags.find((t) => t.name === '3C')
    expect(child?.parent).toBe('证书类')

    // 子标签提升为顶层
    await box.tags.setParent('3C', null)
    const after = await box.tags.list()
    expect(after.find((t) => t.name === '3C')?.parent).toBeNull()
    expect(after.find((t) => t.name === '证书类')?.children).toEqual(['质检'])
  })

  it('父标签重命名同步子标签 parent 引用', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('证书类', '#0ea5e9')
    await box.tags.create('3C', '#0ea5e9', '证书类')

    await box.tags.rename('证书类', '资质类')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '3C')?.parent).toBe('资质类')
  })

  it('删除父标签：子标签提升为顶层，引用清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['删我'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['删我', '保留'] })

    await box.tags.create('删我', '#111111')
    await box.tags.create('子删', '#222222', '删我')

    await box.tags.delete('删我')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '删我')).toBeFalsy()
    // 子标签提升为顶层
    expect(tags.find((t) => t.name === '子删')?.parent).toBeNull()
    // 引用清理
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual([])
    const meta = await box.metadata.get(metaPath(ws))
    expect(meta.tags).toEqual(['保留'])
  })

  it('rename 同步引用 + 迁移旧版 tags_state', async () => {
    const home = await tmp()
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, '.qihefilemanager'), { recursive: true })
    await fsp.writeFile(
      path.join(ws, '.qihefilemanager', 'tags_state.json'),
      JSON.stringify({ colors: { 旧标: '#abcdef' } }),
    )
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['旧标'], notes: '' })

    await box.tags.rename('旧标', '新标')
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual(['新标'])
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '新标')?.color).toBe('#abcdef')
  })

  it('孤儿标签：未定义但被引用 → list 返回 defined:false 可治理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 历史自由输入引入的未定义标签
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })
    await box.metadata.update({ file_path: metaPath(ws), tags: ['野生标', '另一个野生'] })

    const tags = await box.tags.list()
    const orphan = tags.find((t) => t.name === '野生标')
    expect(orphan).toBeTruthy()
    expect(orphan?.defined).toBe(false)
    expect(orphan?.color).toBe('#94a3b8') // 默认灰
    expect(orphan?.count).toBe(2)
    expect(orphan?.parent).toBeNull()
    const orphan2 = tags.find((t) => t.name === '另一个野生')
    expect(orphan2?.defined).toBe(false)
    // 内置标签不再自动出现（v2.3.2 起无内置补全）
    expect(tags.find((t) => t.name === '重要')).toBeFalsy()
  })

  it('adopt 孤儿标签：补定义，引用不动，颜色生效', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })

    await box.tags.adopt('野生标', '#ef4444')
    const tags = await box.tags.list()
    const t = tags.find((x) => x.name === '野生标')
    expect(t?.defined).toBe(true)
    expect(t?.color).toBe('#ef4444')
    // 引用仍在
    expect(t?.count).toBe(1)
    // 未使用标签不可 adopt
    await expect(box.tags.adopt('不存在的', '#000000')).rejects.toThrow('未被使用')
  })

  it('delete 孤儿标签：仅清理引用（定义不存在时跳过定义删除）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生标'], notes: '' })

    await box.tags.delete('野生标')
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '野生标')).toBeFalsy()
    const list = await box.workspace.productSetList()
    expect(list[0].tags).toEqual([])
  })
})

describe('标签引用源注册机制（v2.4.4 T7）', () => {
  it('自定义引用源注册后：rename/delete/adopt 的引用传播自动覆盖', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 模拟实体（客户/发票 v2.4.7 已接入，本用例验证注册机制的通用性）：独立 JSON 存储，注册为引用源
    const storeFile = path.join(ws, '.qihefilemanager', 'mock_sources.json')
    const mock: Record<string, { tags: string[] }> = {
      客户甲: { tags: ['大客户', '待跟进'] },
      客户乙: { tags: ['大客户'] },
    }
    await fsp.writeFile(storeFile, JSON.stringify(mock))
    const load = async (): Promise<Record<string, { tags: string[] }>> =>
      JSON.parse(await fsp.readFile(storeFile, 'utf-8'))
    const save = async (m: Record<string, { tags: string[] }>): Promise<void> =>
      fsp.writeFile(storeFile, JSON.stringify(m))

    box.tags.registerSource('mock', {
      id: 'mock',
      list: async () =>
        Object.entries(await load()).map(([name, v]) => ({ name, tags: [...(v.tags ?? [])] })),
      save: async (entries) => {
        const m = await load()
        for (const { name, tags } of entries) {
          if (m[name]) m[name].tags = tags
        }
        await save(m)
      },
    })

    // 新建标签定义（先过 migrateAndInit）
    await box.tags.create('大客户', '#123456')

    // rename：传播到 mock 源
    await box.tags.rename('大客户', '重点客户')
    let m = await load()
    expect(m['客户甲'].tags).toEqual(['重点客户', '待跟进'])
    expect(m['客户乙'].tags).toEqual(['重点客户'])
    // 计数包含自定义源
    const tags = await box.tags.list()
    expect(tags.find((t) => t.name === '重点客户')?.count).toBe(2)

    // delete：传播到 mock 源
    await box.tags.delete('重点客户')
    m = await load()
    expect(m['客户甲'].tags).toEqual(['待跟进'])
    expect(m['客户乙'].tags).toEqual([])

    // 孤儿（未定义引用）计数同样来自全部引用源
    await fsp.writeFile(
      storeFile,
      JSON.stringify({ 客户甲: { tags: ['野生标'] } } as Record<string, { tags: string[] }>),
    )
    const orphan = (await box.tags.list()).find((t) => t.name === '野生标')
    expect(orphan?.defined).toBe(false)
    expect(orphan?.count).toBe(1)
  })
})
describe('标签体系（v2.5.3 T2：tags.json 事务化写路径 / 损坏拒写 / 无变化不写盘）', () => {
  it('损坏 tags.json：写路径拒绝覆盖并隔离留证（.corrupt-* 备份），隔离后重建成功', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list() // 迁移完成（写入 _migrated_builtin 标记）
    await box.workspace.productSetCreate({ name: '系列A', tags: ['野生'], notes: '' })

    const p = path.join(ws, '.qihefilemanager', 'tags.json')
    const corrupt = '{"重要":'
    await fsp.writeFile(p, corrupt)
    const dir = path.join(ws, '.qihefilemanager')

    await expect(box.tags.create('新标签', '#000000')).rejects.toThrow(/损坏|覆盖/)
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('tags.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe(corrupt)
    // 隔离后重建成功（迁移标记 + 新标签均落盘）
    await box.tags.create('新标签', '#000000')
    const t = (await box.tags.list()).find((x) => x.name === '新标签')
    expect(t?.defined).toBe(true)
  })

  it('无变化不写盘：setColor 同色 / setParent 同父均不触碰磁盘（mtime 不变）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.list()
    await box.tags.create('甲', '#123456')
    await box.tags.create('乙', '#654321', '甲')
    const p = path.join(ws, '.qihefilemanager', 'tags.json')
    const mtime1 = (await fsp.stat(p)).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    await box.tags.setColor('甲', '#123456') // 同色
    await box.tags.setParent('乙', '甲') // 同父
    expect((await fsp.stat(p)).mtimeMs).toBe(mtime1)
    // 实际变化 → 落盘
    await box.tags.setColor('甲', '#000000')
    expect((await fsp.stat(p)).mtimeMs).not.toBe(mtime1)
  })
})
// —— v2.5.7（A3）：标签域 scope ——

describe('标签域 scope（v2.5.7 A3）', () => {
  it('create 带 scope → list 返回该 scope；缺省 → general（全域）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('文件标', '#111111', null, 'file')
    await box.tags.create('客户标', '#222222', null, 'client')
    await box.tags.create('发票标', '#444444', null, 'invoice')
    await box.tags.create('报价标', '#555555', null, 'quote')
    await box.tags.create('全域标', '#333333')
    await box.metadata.update({ file_path: metaPath(ws), tags: ['文件标'] }) // 避免孤儿
    const list = await box.tags.list()
    expect(list.find((t) => t.name === '文件标')?.scope).toBe('file')
    expect(list.find((t) => t.name === '客户标')?.scope).toBe('client')
    // v2.5.7（用户拍板 2026-08-30）：ledger 拆分 → 发票/报价独立域
    expect(list.find((t) => t.name === '发票标')?.scope).toBe('invoice')
    expect(list.find((t) => t.name === '报价标')?.scope).toBe('quote')
    expect(list.find((t) => t.name === '全域标')?.scope).toBe('general')
  })

  it('setScope：设置/清除域（general 清除 → tags.json 无 scope 字段，旧档兼容）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('标A', '#111111', null, 'file')
    await box.tags.create('标B', '#222222')
    await box.metadata.update({ file_path: metaPath(ws), tags: ['标A', '标B'] })
    // v2.5.7（用户拍板 2026-08-30）：ledger 已拆分——旧值写入归一为全域（general）；类型已不含 ledger，cast 模拟旧档
    await box.tags.setScope('标B', 'ledger' as never)
    let list = await box.tags.list()
    expect(list.find((t) => t.name === '标B')?.scope).toBe('general')
    // 新域 invoice/quote 正常写入
    await box.tags.setScope('标B', 'invoice')
    list = await box.tags.list()
    expect(list.find((t) => t.name === '标B')?.scope).toBe('invoice')
    await box.tags.setScope('标B', 'quote')
    list = await box.tags.list()
    expect(list.find((t) => t.name === '标B')?.scope).toBe('quote')
    // 清除回 general
    await box.tags.setScope('标B', undefined)
    list = await box.tags.list()
    expect(list.find((t) => t.name === '标B')?.scope).toBe('general')
    // 旧档（无 scope 字段）读兼容：list 归一化为 general
    const store = JSON.parse(
      await fsp.readFile(path.join(ws, '.qihefilemanager', 'tags.json'), 'utf-8'),
    )
    expect(store['标B'].scope).toBeUndefined()
  })

  it('setScope 无变化不写盘（与既有 T2 语义一致）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.tags.create('标C', '#111111', null, 'file')
    await box.metadata.update({ file_path: metaPath(ws), tags: ['标C'] })
    const p = path.join(ws, '.qihefilemanager', 'tags.json')
    const m1 = (await fsp.stat(p)).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    await box.tags.setScope('标C', 'file')
    expect((await fsp.stat(p)).mtimeMs).toBe(m1)
  })

  it('旧档直读域归一：磁盘残留 ledger / 未知域值 → 全域（不丢不隐身）；合法七域原样保持；零回写', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const p = path.join(ws, '.qihefilemanager', 'tags.json')
    // 构造「2.5.6 升上来的旧档」：含已废除 ledger、更高版本才会写的未知域值、以及合法域值各一
    // （迁移标记已在位，避免 list() 首读触发的内置标签迁移改写本用例输入）
    await fsp.writeFile(p, JSON.stringify({
      _migrated_builtin: { color: '' },
      旧台账标: { color: '#111111', scope: 'ledger' },
      未来域标: { color: '#222222', scope: 'future_domain' },
      合法文件: { color: '#333333', scope: 'file' },
      合法产品: { color: '#444444', scope: 'product_set' },
      合法客户: { color: '#555555', scope: 'client' },
      合法供应: { color: '#666666', scope: 'supplier' },
      合法发票: { color: '#777777', scope: 'invoice' },
      合法报价: { color: '#888888', scope: 'quote' },
      合法全域: { color: '#999999', scope: 'general' },
    }))
    const names = ['旧台账标', '未来域标', '合法文件', '合法产品', '合法客户', '合法供应', '合法发票', '合法报价', '合法全域']
    await box.metadata.update({ file_path: metaPath(ws), tags: names })
    const list = await box.tags.list()
    const scopeOf = (n: string): string | undefined => list.find((t) => t.name === n)?.scope
    // 非法值回落全域：标签必须仍在列表里（原样透出会让它在设置页分组与各业务页候选中同时隐身）
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(names))
    expect(scopeOf('旧台账标')).toBe('general')
    expect(scopeOf('未来域标')).toBe('general')
    // 合法域逐一保持（零改动）
    expect(scopeOf('合法文件')).toBe('file')
    expect(scopeOf('合法产品')).toBe('product_set')
    expect(scopeOf('合法客户')).toBe('client')
    expect(scopeOf('合法供应')).toBe('supplier')
    expect(scopeOf('合法发票')).toBe('invoice')
    expect(scopeOf('合法报价')).toBe('quote')
    expect(scopeOf('合法全域')).toBe('general')
    // 读时归一不回写磁盘（零迁移语义：只有用户改域才落盘）
    const raw = JSON.parse(await fsp.readFile(p, 'utf-8'))
    expect(raw['旧台账标'].scope).toBe('ledger')
    expect(raw['未来域标'].scope).toBe('future_domain')
    // 改域一次即把非法旧值固化清掉（写路径同口径归一）
    await box.tags.setScope('旧台账标', 'invoice')
    const list2 = await box.tags.list()
    expect(list2.find((t) => t.name === '旧台账标')?.scope).toBe('invoice')
    const raw2 = JSON.parse(await fsp.readFile(p, 'utf-8'))
    expect(raw2['旧台账标'].scope).toBe('invoice')
  })

  it('供应商标签引用源注册：rename/delete 自动覆盖（锁内读改写通道）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    // 建供应商（含标签）——真实 SuppliersService.create（buildTestBox 已注册供应商引用源）
    const created = await box.suppliers.create({ name: '供应商甲', tags: ['供应商标'] })
    expect(created.tags).toContain('供应商标')
    // 定义标签（supplier 域）——rename/delete 传播目标
    await box.tags.create('供应商标', '#123456', null, 'supplier')
    // rename：引用传播（含 suppliers.json 内引用）
    await box.tags.rename('供应商标', '供应商新标')
    const sp = path.join(ws, '.qihefilemanager', 'suppliers.json')
    const after = JSON.parse(await fsp.readFile(sp, 'utf-8'))
    expect(after['供应商甲'].tags).toContain('供应商新标')
    expect(after['供应商甲'].tags).not.toContain('供应商标')
    // delete：引用清理
    await box.tags.delete('供应商新标')
    const del = JSON.parse(await fsp.readFile(sp, 'utf-8'))
    expect(del['供应商甲'].tags ?? []).not.toContain('供应商新标')
  })
})
