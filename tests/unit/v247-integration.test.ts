/**
 * v2.4.7 集成单测：search / dashboard / trash / indexCache / notify 五模块新行为
 * - search（§4.2）：客户实体命中（名/别名/标签）、客户/发票/入库三区文件纳入、客户文件标签命中
 * - dashboard（§4.3）：total_customers、invoiceTodos 30 天窗口边界、checkExpiringCerts 区域 key 判读
 * - trash（§4.4）：客户目录移入/恢复/彻底删除（customers.json 条目清理、发票 customer 字段保留）、
 *   客户子文件夹 restore 回填 customer_subfolders
 * - indexCache（§4.5）：build() 增补客户/发票/入库三区逐目录快照
 * - notify（§6.4）：发票待办并入每日去重通道 + 合并消息纯函数
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import { WorkspaceIndex } from '../../src/main/core/indexCache'
import type { CompactItem } from '../../src/main/core/indexCache'
import { computeNotifiable, composeDailyNotification } from '../../src/main/notify'
import type { InvoiceTodoItem, NotifyState } from '../../src/main/notify'
import { invoicesPath, writeJsonAtomic } from '../../src/main/core/paths'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-v247-'))
}

/** 建工作区（ensureWorkspaceDirs 已建 客户/发票/入库/交换区 空目录） */
async function buildBox() {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { box, ws }
}

/** n 天后的本地日期 YYYY-MM-DD（invoices.json due_date 归一化格式） */
function dateInDays(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 最小发票台账记录（仅测试窗口所需字段） */
function invRecord(over: Partial<import('../../src/shared/types').InvoiceRecord>): import('../../src/shared/types').InvoiceRecord {
  return {
    number: 'T',
    date: '2026-01-01',
    amount: 100,
    seller: '供应商',
    buyer: '本公司',
    status: '待报销',
    file_path: '发票/2026/x.pdf',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('搜索（§4.2）', () => {
  it('客户实体命中：客户名/别名/标签均可命中，附文件数', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '张三', alias: 'ZhangSan Trading', tags: ['外贸', '重点'], notes: 'n' })
    await fsp.writeFile(path.join(ws, '客户', '张三', '报价', '报价单.pdf'), 'pdf')

    const r1 = await box.search.search('张三')
    expect(r1.customers!.map((c) => c.name)).toContain('张三')
    const c = r1.customers!.find((x) => x.name === '张三')!
    expect(c.file_count).toBeGreaterThanOrEqual(1)
    expect(c.alias).toBe('ZhangSan Trading')
    expect(c.tags).toContain('外贸')

    // 别名命中（大小写不敏感）
    const r2 = await box.search.search('zhangsan')
    expect(r2.customers!.some((x) => x.name === '张三')).toBe(true)
    // 标签命中
    const r3 = await box.search.search('外贸')
    expect(r3.customers!.some((x) => x.name === '张三')).toBe(true)
    // 不相关关键词 → 不命中
    const r4 = await box.search.search('无此关键词')
    expect(r4.customers).toHaveLength(0)
  })

  it('客户/发票/入库三区文件按文件名命中，path 自明来源区域', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '李四' })
    await fsp.writeFile(path.join(ws, '客户', '李四', '合同', '采购合同.pdf'), 'x')
    await fsp.mkdir(path.join(ws, '发票', '2026'), { recursive: true })
    await fsp.writeFile(path.join(ws, '发票', '2026', '发票2401.pdf'), 'x')
    await fsp.mkdir(path.join(ws, '入库', '2026'), { recursive: true })
    await fsp.writeFile(path.join(ws, '入库', '2026', '入库单001.pdf'), 'x')

    const r1 = await box.search.search('采购合同')
    expect(r1.files.some((f) => f.name === '采购合同.pdf')).toBe(true)
    const r2 = await box.search.search('发票2401')
    expect(r2.files.some((f) => f.name === '发票2401.pdf' && f.path.includes('发票'))).toBe(true)
    const r3 = await box.search.search('入库单001')
    expect(r3.files.some((f) => f.name === '入库单001.pdf' && f.path.includes('入库'))).toBe(true)
  })

  it('客户区文件标签命中（metadata key 泛化后客户文件可打标）；客户随文件命中一并返回', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '王五' })
    const f = path.join(ws, '客户', '王五', '报价', '报价单.pdf')
    await fsp.writeFile(f, 'x')
    await box.metadata.update({ file_path: f, tags: ['报价', '已确认'] })

    const r = await box.search.search('已确认')
    expect(r.files.some((x) => x.path === f)).toBe(true)
    expect(r.files.find((x) => x.path === f)!.tags).toContain('已确认')
    // 对齐产品集形态：文件命中时所属客户一并返回
    expect(r.customers!.some((c) => c.name === '王五')).toBe(true)
  })
})

describe('仪表盘（§4.3）', () => {
  it('total_customers：客户/ 一级目录数', async () => {
    const { box } = await buildBox()
    await box.clients.create({ name: '甲' })
    await box.clients.create({ name: '乙' })
    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_customers).toBe(2)
  })

  it('invoiceTodos：30 天窗口边界 + 已入账排除 + 无 due_date/非法日期跳过 + due_date 升序', async () => {
    const { box, ws } = await buildBox()
    await writeJsonAtomic(invoicesPath(ws), {
      invoices: {
        A001: invRecord({ number: 'A001', due_date: dateInDays(29) }),
        A002: invRecord({ number: 'A002', due_date: dateInDays(31) }), // 31 天外 → 排除
        A003: invRecord({ number: 'A003', due_date: dateInDays(10), status: '已入账' }), // 已入账 → 排除
        A004: invRecord({ number: 'A004' }), // 无 due_date → 排除
        A005: invRecord({ number: 'A005', due_date: '2026-13-99' }), // 非法日期 → 跳过
        A006: invRecord({ number: 'A006', due_date: dateInDays(-5) }), // 已过期未处理 → 纳入
        A007: invRecord({ number: 'A007', due_date: dateInDays(29), status: '已报销' }), // 非已入账 → 纳入
      },
    })
    const todos = await box.dashboard.invoiceTodos()
    expect(todos.map((t) => t.number)).toEqual(['A006', 'A001', 'A007'])
  })

  it('checkExpiringCerts：客户区 key 按工作区相对路径校验（合同到期可提醒）；发票区 key 不走本通道', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '赵六' })
    const contract = path.join(ws, '客户', '赵六', '合同', '采购合同.pdf')
    await fsp.writeFile(contract, 'x')
    await box.metadata.update({ file_path: contract, expiry_date: dateInDays(10) })
    // 发票区文件带到期日 → 不参与证书到期提醒（发票待办走 invoices.json，§6.4）
    await fsp.mkdir(path.join(ws, '发票', '2026'), { recursive: true })
    const invFile = path.join(ws, '发票', '2026', 'f.pdf')
    await fsp.writeFile(invFile, 'x')
    await box.metadata.update({ file_path: invFile, expiry_date: dateInDays(5) })

    const expiring = await box.dashboard.checkExpiringCerts()
    expect(expiring.some(([ps, fn]) => ps === '赵六' && fn === '采购合同.pdf')).toBe(true)
    expect(expiring.some(([, fn]) => fn === 'f.pdf')).toBe(false)
  })
})

describe('回收站（§4.4）', () => {
  it('客户目录移入回收站 → 恢复回原位；customers.json 条目保留', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '客户甲' })
    const dir = path.join(ws, '客户', '客户甲')
    await fsp.writeFile(path.join(dir, '报价', 'x.pdf'), 'x')

    await box.deleteCustomer('客户甲')
    await expect(fsp.stat(dir)).rejects.toThrow()
    expect((await box.clients.list()).map((c) => c.name)).not.toContain('客户甲')
    // 档案条目保留（恢复即复原的前提）
    expect((await box.clients.loadCustomersInfo())['客户甲']).toBeTruthy()

    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('customer')

    await box.trash.restore(entries[0].id)
    await expect(fsp.stat(dir)).resolves.toBeTruthy()
    expect((await box.clients.list()).map((c) => c.name)).toContain('客户甲')
  })

  it('客户 purge：元数据前缀清理 + customers.json 条目删除；发票 customer 字段保留字面值', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '客户乙' })
    const dir = path.join(ws, '客户', '客户乙')
    const f = path.join(dir, '合同', '合同.pdf')
    await fsp.writeFile(f, 'x')
    await box.metadata.update({ file_path: f, tags: ['重点'] })
    // 发票台账含 customer 字面值（账物分离：purge 不得级联修改）
    await writeJsonAtomic(invoicesPath(ws), {
      invoices: { 'INV-1': invRecord({ number: 'INV-1', customer: '客户乙' }) },
    })

    await box.deleteCustomer('客户乙')
    const entries = await box.trash.list()
    await box.trash.purge(entries[0].id)

    expect((await box.clients.loadCustomersInfo())['客户乙']).toBeUndefined()
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain('客户/客户乙/合同/合同.pdf')
    const inv = JSON.parse(await fsp.readFile(invoicesPath(ws), 'utf-8'))
    expect(inv.invoices['INV-1'].customer).toBe('客户乙')
  })

  it('客户子文件夹 restore 回填 cfg.customer_subfolders', async () => {
    const { box, ws } = await buildBox()
    await box.clients.create({ name: '客户丙' })
    const sub = path.join(ws, '客户', '客户丙', '对账单')
    await fsp.mkdir(sub, { recursive: true })

    await box.trash.trashItem(ws, sub, 'subfolder')
    const entries = await box.trash.list()
    expect(entries[0].kind).toBe('subfolder')

    await box.trash.restore(entries[0].id)
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.customer_subfolders).toContain('对账单')
  })
})

describe('索引（§4.5）', () => {
  it('build 增补三区扫描：客户/<名>/<各子文件夹>、发票/<YYYY>/、入库/<YYYY>/ 逐目录快照', async () => {
    const { ws } = await buildBox()
    await fsp.mkdir(path.join(ws, '客户', '甲', '报价'), { recursive: true })
    await fsp.mkdir(path.join(ws, '客户', '甲', '合同'), { recursive: true })
    await fsp.mkdir(path.join(ws, '发票', '2026'), { recursive: true })
    await fsp.mkdir(path.join(ws, '入库', '2026'), { recursive: true })
    const index = new WorkspaceIndex()
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    const built = await index.build(ws, listRaw)
    expect(built).toBe(4) // 客户甲 2 子目录 + 发票 1 + 入库 1
    const dirs = [
      path.join(ws, '客户', '甲', '报价'),
      path.join(ws, '客户', '甲', '合同'),
      path.join(ws, '发票', '2026'),
      path.join(ws, '入库', '2026'),
    ]
    for (const d of dirs) {
      expect(await index.query(d, listRaw)).toEqual([])
    }
    expect(calls).toBe(4) // 全部命中 → 未再触发 listRaw
  })
})

describe('系统通知（§6.4）', () => {
  it('computeNotifiable：发票待办并入每日去重通道（key 前缀 发票待办/；同日去重、跨天复位、与证书互不干扰）', () => {
    const base = new Date(2026, 7, 9, 12, 0, 0)
    const todos: InvoiceTodoItem[] = [
      { number: 'A1', due_date: '2026-08-20' },
      { number: 'A2', due_date: '2026-08-15' },
    ]
    const r1 = computeNotifiable([], null, base, todos)
    // 输出按 due_date 升序（最近到期在前）
    expect(r1.invoiceToNotify).toEqual([
      { number: 'A2', due_date: '2026-08-15' },
      { number: 'A1', due_date: '2026-08-20' },
    ])
    expect(r1.nextState.keys).toContain('发票待办/A1')
    expect(r1.nextState.keys).toContain('发票待办/A2')

    // 同日再查 → 全部去重
    const r2 = computeNotifiable([], r1.nextState, base, todos)
    expect(r2.invoiceToNotify).toHaveLength(0)
    // 跨天复位 → 可再通知
    const r3 = computeNotifiable([], r1.nextState, new Date(2026, 7, 10, 9), todos)
    expect(r3.invoiceToNotify).toHaveLength(2)

    // 证书与发票同一状态通道，key 互不干扰
    const state: NotifyState = { date: '2026-08-09', keys: ['系列A/a.jpg'] }
    const r4 = computeNotifiable([['系列A', 'a.jpg', '2026-09-01']], state, base, [{ number: 'B1', due_date: '2026-08-25' }])
    expect(r4.toNotify).toHaveLength(0)
    expect(r4.invoiceToNotify).toHaveLength(1)
    expect(r4.nextState.keys).toEqual(['系列A/a.jpg', '发票待办/B1'])
  })

  it('composeDailyNotification：仅证书 / 仅发票 / 合并一条 / 全空返回 null', () => {
    // 仅证书 → 标题与正文与 v2.4.2 一致
    const certsOnly = composeDailyNotification([['系列A', 'a.jpg', '2026-09-01']], [])
    expect(certsOnly!.title).toBe('证书到期提醒')
    expect(certsOnly!.body).toBe('产品集「系列A」中 a.jpg 将于 2026-09-01 到期，请及时处理')
    // 仅发票
    const invOnly = composeDailyNotification([], [{ number: 'A1', due_date: '2026-08-20' }])
    expect(invOnly!.title).toBe('发票待办提醒')
    expect(invOnly!.body).toBe('1 张发票待办，最近 2026-08-20')
    // 合并 → 一条通知，证书部分不变 + 发票行（最近 = 到期日最早）
    const both = composeDailyNotification([['系列A', 'a.jpg', '2026-09-01']], [
      { number: 'A1', due_date: '2026-08-20' },
      { number: 'A2', due_date: '2026-08-15' },
    ])
    expect(both!.title).toBe('证书到期提醒')
    expect(both!.body).toBe(
      '产品集「系列A」中 a.jpg 将于 2026-09-01 到期，请及时处理\n2 张发票待办，最近 2026-08-15',
    )
    // 全空 → null（调用方不发通知）
    expect(composeDailyNotification([], [])).toBeNull()
  })
})
