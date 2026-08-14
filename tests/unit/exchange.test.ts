/**
 * 交换区投递服务单测（v2.4.7，PLAN §8）：
 * - 四种 kind（invoice/inbound/customer/productSet）投递 → 真实文件归集 → 回执
 * - 坏 JSON 拒绝、id 与文件名不一致、kind 未知、投递文件不存在 → error 回执
 * - 重复 id → duplicate 回执，不重复归集；崩溃重入幂等
 * - 客户/产品集目标不存在 → error 回执（不自动建目录）
 * - 台账 sink 查重失败 → error 回执；台账未接入 → error 回执且文件不落盘
 * - sweep 批量补扫（跳过非 json）；簿记 500 条滚动截断；start/stop 生命周期
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTestBox } from './helpers'
import { ExchangeService, type ExchangeLedgerSinks } from '../../src/main/core/exchange'
import type { ExchangeReceipt } from '../../src/shared/types'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-exchange-'))
}

/** 写一个投递：描述 JSON + 文件本体 */
async function placeDelivery(
  ws: string,
  id: string,
  desc: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<void> {
  const dir = path.join(ws, '交换区')
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(desc))
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), content)
  }
}

/** 构造记账 sink（记录调用参数；可注入失败行为） */
function makeLedger() {
  const calls: { kind: 'invoice' | 'inbound'; payload: unknown; archived: string[] }[] = []
  const ledger: ExchangeLedgerSinks = {
    createInvoice: async (d, archived) => {
      calls.push({ kind: 'invoice', payload: d, archived })
    },
    createInbound: async (d, archived) => {
      calls.push({ kind: 'inbound', payload: d, archived })
    },
  }
  return { calls, ledger }
}

async function readReceipt(ws: string, id: string): Promise<ExchangeReceipt> {
  const p = path.join(ws, '交换区', '已处理', `${id}.receipt.json`)
  return JSON.parse(await fsp.readFile(p, 'utf-8')) as ExchangeReceipt
}

describe('交换区投递（v2.4.7）', () => {
  let ws: string
  let box: ReturnType<typeof buildTestBox>

  beforeEach(async () => {
    ws = await tmp()
    box = buildTestBox(await tmp())
    await box.workspace.create(ws)
  })

  function newExchange(ledger?: ExchangeLedgerSinks): ExchangeService {
    return new ExchangeService(box.workspace, ledger)
  }

  it('invoice 投递：文件归集 发票/<YYYY>/ + 台账 sink + ok 回执 + 投递区归零', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inv-001',
      {
        id: 'inv-001',
        kind: 'invoice',
        files: ['f.pdf'],
        invoice: { number: '12345678', code: '', date: '2026-08-01', amount: 100, seller: '开票方A', buyer: '购方B', customer: '张三', due_date: '2026-09-01' },
      },
      { 'f.pdf': 'invoice-content' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inv-001.json'))

    expect(receipt.status).toBe('ok')
    expect(receipt.id).toBe('inv-001')
    // 文件已归集到 发票/2026/
    const archivedDir = path.join(ws, '发票', '2026')
    const files = await fsp.readdir(archivedDir)
    expect(files).toHaveLength(1)
    expect(files[0].endsWith('.pdf')).toBe(true)
    expect(await fsp.readFile(path.join(archivedDir, files[0]), 'utf-8')).toBe('invoice-content')
    // 台账 sink 收到完整字段与已归档相对路径
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('invoice')
    expect((calls[0].payload as { number: string }).number).toBe('12345678')
    expect(calls[0].archived).toHaveLength(1)
    expect(calls[0].archived[0]).toMatch(/^发票\/2026\/.+\.pdf$/)
    expect(receipt.target_paths).toEqual(calls[0].archived)
    // 回执落盘 + 描述文件消费 + 投递区归零
    expect((await readReceipt(ws, 'inv-001')).status).toBe('ok')
    await expect(fsp.stat(path.join(ws, '交换区', 'inv-001.json'))).rejects.toThrow()
    await expect(fsp.stat(path.join(ws, '交换区', '已处理', 'inv-001.json'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, '交换区', 'f.pdf'))).rejects.toThrow()
  })

  it('inbound 投递：文件归集 入库/<YYYY>/ + 台账 sink', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inb-001',
      {
        id: 'inb-001',
        kind: 'inbound',
        files: ['x.pdf'],
        inbound: { id: 'RK001', date: '2026-07-15', supplier: '供应商X', product_set: '系列A', amount: 500 },
      },
      { 'x.pdf': 'inbound-content' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inb-001.json'))

    expect(receipt.status).toBe('ok')
    const archivedDir = path.join(ws, '入库', '2026')
    const files = await fsp.readdir(archivedDir)
    expect(files).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('inbound')
    expect((calls[0].payload as { id: string }).id).toBe('RK001')
    expect(calls[0].archived[0]).toMatch(/^入库\/2026\/.+\.pdf$/)
  })

  it('customer 投递：归集 客户/<名>/<子文件夹>，无台账 sink 参与', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    await fsp.mkdir(path.join(ws, '客户', '张三', '报价'), { recursive: true })
    await placeDelivery(
      ws,
      'cust-001',
      { id: 'cust-001', kind: 'customer', files: ['a.pdf'], customer: { name: '张三', sub_folder: '报价' } },
      { 'a.pdf': 'customer-content' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'cust-001.json'))

    expect(receipt.status).toBe('ok')
    const targetDir = path.join(ws, '客户', '张三', '报价')
    const files = await fsp.readdir(targetDir)
    expect(files).toHaveLength(1)
    expect(await fsp.readFile(path.join(targetDir, files[0]), 'utf-8')).toBe('customer-content')
    expect(calls).toHaveLength(0) // customer 无台账
    expect(receipt.target_paths[0]).toMatch(/^客户\/张三\/报价\/.+\.pdf$/)
  })

  it('customer 投递：客户/子文件夹不存在 → error 回执，不自动建客户', async () => {
    const exchange = newExchange()
    await placeDelivery(
      ws,
      'cust-404',
      { id: 'cust-404', kind: 'customer', files: ['a.pdf'], customer: { name: '李四', sub_folder: '报价' } },
      { 'a.pdf': 'x' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'cust-404.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('不存在')
    await expect(fsp.stat(path.join(ws, '客户', '李四')).catch(() => null)).resolves.toBeNull()
    // 投递被消费（error 回执 + 描述移走），防反复报警
    await expect(fsp.stat(path.join(ws, '交换区', 'cust-404.json'))).rejects.toThrow()
    expect((await readReceipt(ws, 'cust-404')).error).toContain('不存在')
  })

  it('productSet 投递：归集 产品集/<名>/<图包|证书>/<子文件夹>；子文件夹不存在 → error', async () => {
    await box.workspace.productSetCreate({ name: '系列A' })
    const exchange = newExchange()
    // image → 图包/主图
    await placeDelivery(
      ws,
      'ps-001',
      { id: 'ps-001', kind: 'productSet', files: ['b.jpg'], productSet: { name: '系列A', file_type: 'image', sub_folder: '主图' } },
      { 'b.jpg': 'img' },
    )
    const ok = await exchange.processFile(path.join(ws, '交换区', 'ps-001.json'))
    expect(ok.status).toBe('ok')
    const mainDir = path.join(ws, '产品集', '系列A', '图包', '主图')
    expect((await fsp.readdir(mainDir)).some((n) => n.endsWith('.jpg'))).toBe(true)
    // cert → 证书/3C
    await placeDelivery(
      ws,
      'ps-002',
      { id: 'ps-002', kind: 'productSet', files: ['c.pdf'], productSet: { name: '系列A', file_type: 'cert', sub_folder: '3C' } },
      { 'c.pdf': 'cert' },
    )
    const ok2 = await exchange.processFile(path.join(ws, '交换区', 'ps-002.json'))
    expect(ok2.status).toBe('ok')
    expect((await fsp.readdir(path.join(ws, '产品集', '系列A', '证书', '3C'))).some((n) => n.endsWith('.pdf'))).toBe(true)
    // 不存在的子文件夹 → error
    await placeDelivery(
      ws,
      'ps-404',
      { id: 'ps-404', kind: 'productSet', files: ['d.jpg'], productSet: { name: '系列A', file_type: 'image', sub_folder: '不存在' } },
      { 'd.jpg': 'img' },
    )
    const bad = await exchange.processFile(path.join(ws, '交换区', 'ps-404.json'))
    expect(bad.status).toBe('error')
    expect(bad.error).toContain('不存在')
  })

  it('坏 JSON → error 回执（不崩溃），描述文件消费', async () => {
    const exchange = newExchange()
    const dir = path.join(ws, '交换区')
    await fsp.writeFile(path.join(dir, 'bad.json'), 'this is not json{{{')

    const receipt = await exchange.processFile(path.join(dir, 'bad.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('解析失败')
    await expect(fsp.stat(path.join(dir, 'bad.json'))).rejects.toThrow()
    expect((await readReceipt(ws, 'bad')).status).toBe('error')
  })

  it('超大描述文件（>1MB）→ error 回执，读前限大小不 readFile/parse（防 OOM）', async () => {
    const exchange = newExchange()
    const dir = path.join(ws, '交换区')
    // 合法 JSON（尾随空白可被 JSON.parse 接受）+ 超大体积：验证读前 stat 大小上限拦截
    const desc = { id: 'big', kind: 'invoice', files: ['f.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } }
    await fsp.writeFile(path.join(dir, 'big.json'), JSON.stringify(desc) + ' '.repeat(1024 * 1024 + 1))

    const receipt = await exchange.processFile(path.join(dir, 'big.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('大小')
    // 描述文件被消费（防反复报警），进程不崩
    await expect(fsp.stat(path.join(dir, 'big.json'))).rejects.toThrow()
    expect((await readReceipt(ws, 'big')).status).toBe('error')
  })

  it('id 与文件名不一致 / 未知 kind / 缺少字段段 → error 回执', async () => {
    const exchange = newExchange()
    const dir = path.join(ws, '交换区')
    // id 不一致
    await placeDelivery(ws, 'a-1', { id: 'other-id', kind: 'invoice', files: ['f.pdf'], invoice: { number: '1' } })
    expect((await exchange.processFile(path.join(dir, 'a-1.json'))).error).toContain('不一致')
    // 未知 kind
    await placeDelivery(ws, 'a-2', { id: 'a-2', kind: 'hack', files: ['f.pdf'] })
    expect((await exchange.processFile(path.join(dir, 'a-2.json'))).error).toContain('未知投递类型')
    // invoice 缺字段段（需文件本体存在，才能走到字段段校验）
    await placeDelivery(ws, 'a-3', { id: 'a-3', kind: 'invoice', files: ['f.pdf'] }, { 'f.pdf': 'x' })
    expect((await exchange.processFile(path.join(dir, 'a-3.json'))).error).toContain('invoice')
  })

  it('投递文件不存在 → error 回执，不归集', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inv-missing',
      { id: 'inv-missing', kind: 'invoice', files: ['gone.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inv-missing.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('不存在')
    expect(calls).toHaveLength(0)
    // 未归集：发票年份目录未创建（发票/ 根由 ensureWorkspaceDirs 常驻）
    await expect(fsp.stat(path.join(ws, '发票', '2026')).catch(() => null)).resolves.toBeNull()
  })

  it('重复 id → duplicate 回执，不重复归集、台账只建一次', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    const desc = {
      id: 'inv-dup',
      kind: 'invoice',
      files: ['f.pdf'],
      invoice: { number: '999', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' },
    }
    await placeDelivery(ws, 'inv-dup', desc, { 'f.pdf': 'v1' })

    const first = await exchange.processFile(path.join(ws, '交换区', 'inv-dup.json'))
    expect(first.status).toBe('ok')

    // 同一投递再次出现（重新投递或崩溃残留）：描述文件 + 文件本体回到交换区根
    await placeDelivery(ws, 'inv-dup', desc, { 'f.pdf': 'v2' })
    const second = await exchange.processFile(path.join(ws, '交换区', 'inv-dup.json'))

    expect(second.status).toBe('duplicate')
    expect(calls).toHaveLength(1) // 台账不重复建
    expect(await fsp.readdir(path.join(ws, '发票', '2026'))).toHaveLength(1) // 无 _1 副本
    expect((await readReceipt(ws, 'inv-dup')).status).toBe('duplicate') // 最近一次处理结果为 duplicate 回执
  })

  it('崩溃重入幂等：id 已簿记 + 描述文件仍在 → duplicate，不重复归集', async () => {
    const { calls, ledger } = makeLedger()
    const exchange = newExchange(ledger)
    const desc = {
      id: 'inv-crash',
      kind: 'invoice',
      files: ['f.pdf'],
      invoice: { number: '777', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' },
    }
    await placeDelivery(ws, 'inv-crash', desc, { 'f.pdf': 'x' })
    await exchange.processFile(path.join(ws, '交换区', 'inv-crash.json'))

    // 模拟崩溃于「簿记后、移描述前」：描述文件仍在交换区根
    await fsp.copyFile(path.join(ws, '交换区', '已处理', 'inv-crash.json'), path.join(ws, '交换区', 'inv-crash.json'))
    const again = await exchange.processFile(path.join(ws, '交换区', 'inv-crash.json'))

    expect(again.status).toBe('duplicate')
    expect(calls).toHaveLength(1)
    expect(await fsp.readdir(path.join(ws, '发票', '2026'))).toHaveLength(1)
  })

  it('台账查重失败（ledger 抛错）→ error 回执，不建记录，且已归档文件回滚（不留孤儿）', async () => {
    const { ledger } = makeLedger()
    ledger.createInvoice = async () => {
      throw new Error('发票号码 555 已存在（2026-08-01，文件 发票/2026/xxx.pdf）')
    }
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inv-dupnum',
      { id: 'inv-dupnum', kind: 'invoice', files: ['f.pdf'], invoice: { number: '555', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inv-dupnum.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('已存在')
    // 投递被消费，不反复重试
    await expect(fsp.stat(path.join(ws, '交换区', 'inv-dupnum.json'))).rejects.toThrow()
    expect((await readReceipt(ws, 'inv-dupnum')).status).toBe('error')
    // C3：台账写失败 → 归档区无残留（已归集副本回滚删除，账物一致）
    const leftovers = await fsp.readdir(path.join(ws, '发票', '2026')).catch(() => [] as string[])
    expect(leftovers.filter((n) => n.endsWith('.pdf'))).toHaveLength(0)
  })

  it('inbound 台账写失败 → error 回执 + 归档回滚（不留孤儿）', async () => {
    const { ledger } = makeLedger()
    ledger.createInbound = async () => {
      throw new Error('入库单编号 RK001 已存在')
    }
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inb-dup',
      { id: 'inb-dup', kind: 'inbound', files: ['x.pdf'], inbound: { id: 'RK001', date: '2026-07-15', supplier: '供应商X' } },
      { 'x.pdf': 'x' },
    )

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inb-dup.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('已存在')
    const leftovers = await fsp.readdir(path.join(ws, '入库', '2026')).catch(() => [] as string[])
    expect(leftovers.filter((n) => n.endsWith('.pdf'))).toHaveLength(0)
  })

  it('台账未接入（未注入 ledger）→ invoice/inbound 投递 error 回执，文件不落盘', async () => {
    const exchange = newExchange() // 无 ledger
    await placeDelivery(
      ws,
      'inv-nol',
      { id: 'inv-nol', kind: 'invoice', files: ['f.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )
    const receipt = await exchange.processFile(path.join(ws, '交换区', 'inv-nol.json'))
    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('未接入')
    await expect(fsp.stat(path.join(ws, '发票', '2026')).catch(() => null)).resolves.toBeNull()
    // inbound 同法
    await placeDelivery(
      ws,
      'inb-nol',
      { id: 'inb-nol', kind: 'inbound', files: ['x.pdf'], inbound: { id: 'R1', date: '2026-01-01', supplier: 's' } },
      { 'x.pdf': 'x' },
    )
    const receipt2 = await exchange.processFile(path.join(ws, '交换区', 'inb-nol.json'))
    expect(receipt2.status).toBe('error')
    expect(receipt2.error).toContain('未接入')
  })

  it('必填字段缺失（发票号码/金额/开票方）→ error 回执', async () => {
    const { ledger } = makeLedger()
    const exchange = newExchange(ledger)
    const dir = path.join(ws, '交换区')
    await placeDelivery(
      ws,
      'inv-bad1',
      { id: 'inv-bad1', kind: 'invoice', files: ['f.pdf'], invoice: { date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )
    expect((await exchange.processFile(path.join(dir, 'inv-bad1.json'))).error).toContain('发票号码')
    await placeDelivery(
      ws,
      'inv-bad2',
      { id: 'inv-bad2', kind: 'invoice', files: ['f.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 'NaN', seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )
    expect((await exchange.processFile(path.join(dir, 'inv-bad2.json'))).error).toContain('金额')
  })

  it('sweep 批量补扫：处理全部 *.json 描述，跳过文件本体与非 json', async () => {
    const { ledger } = makeLedger()
    const exchange = newExchange(ledger)
    // 两个投递 + 一个文件本体
    await placeDelivery(
      ws,
      's1',
      { id: 's1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'a.pdf': 'a' },
    )
    await placeDelivery(
      ws,
      's2',
      { id: 's2', kind: 'customer', files: ['b.pdf'], customer: { name: '张三', sub_folder: '其他' } },
      { 'b.pdf': 'b' },
    )
    await fsp.mkdir(path.join(ws, '客户', '张三', '其他'), { recursive: true })
    await fsp.writeFile(path.join(ws, '交换区', 'loose.pdf'), 'loose') // 非 json，不处理

    const count = await exchange.sweep()

    expect(count).toBe(2)
    expect((await readReceipt(ws, 's1')).status).toBe('ok')
    expect((await readReceipt(ws, 's2')).status).toBe('ok')
    // 文件本体保留在投递区？——s1 的 a.pdf 已随归零删除；loose.pdf 未被任何投递声明 → 保留
    await expect(fsp.stat(path.join(ws, '交换区', 'a.pdf'))).rejects.toThrow()
    await expect(fsp.stat(path.join(ws, '交换区', 'loose.pdf'))).resolves.toBeTruthy()
    // 幂等：重复 sweep 无新投递
    expect(await exchange.sweep()).toBe(0)
  })

  it('簿记滚动：超过 500 条截断最旧，保留最近', async () => {
    const { ledger } = makeLedger()
    const exchange = newExchange(ledger)
    // 预置 500 条簿记（old-0 最旧）
    const statePath = path.join(ws, '.qihefilemanager', 'exchange_state.json')
    const existing = Array.from({ length: 500 }, (_, i) => ({ id: `old-${i}`, at: '2026-01-01T00:00:00.000Z' }))
    await fsp.writeFile(statePath, JSON.stringify({ processed: existing }))

    await placeDelivery(
      ws,
      'new-1',
      { id: 'new-1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'a.pdf': 'a' },
    )
    await exchange.processFile(path.join(ws, '交换区', 'new-1.json'))

    const state = JSON.parse(await fsp.readFile(statePath, 'utf-8')) as { processed: { id: string }[] }
    expect(state.processed).toHaveLength(500)
    expect(state.processed[state.processed.length - 1].id).toBe('new-1')
    expect(state.processed.some((p) => p.id === 'old-0')).toBe(false) // 最旧被淘汰
    expect(state.processed.some((p) => p.id === 'old-1')).toBe(true)
  })

  it('start()/stop() 生命周期：启动立即补扫存量投递；stop 幂等；切换重建安全', async () => {
    const { ledger } = makeLedger()
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'boot-1',
      { id: 'boot-1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '1', date: '2026-01-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'a.pdf': 'a' },
    )

    // 未 start 时手动 sweep 也工作（测试环境可不依赖 watch）
    const count = await exchange.start()
    expect(count).toBe(1)
    expect((await readReceipt(ws, 'boot-1')).status).toBe('ok')
    // 重复 start（切换后重建）不抛错；已处理投递不重复处理
    const count2 = await exchange.start()
    expect(count2).toBe(0)
    // stop 幂等
    expect(() => exchange.stop()).not.toThrow()
    expect(() => exchange.stop()).not.toThrow()
  })

  it('真实 ledger：box.exchange → InvoicesService.create 投递 invoice → 台账记录 + ok 回执（账物闭环）', async () => {
    // box 为完整 BoxService：exchange 已装配真实 ledger sink（createInvoice → invoices.create，§6.2 三入口同函数）
    await placeDelivery(
      ws,
      'inv-real',
      {
        id: 'inv-real',
        kind: 'invoice',
        files: ['f.pdf'],
        invoice: { number: '20260811001', code: 'A', date: '2026-08-01', amount: 128.5, seller: '开票方A', buyer: '购方B', customer: '张三', due_date: '2026-09-01' },
      },
      { 'f.pdf': 'invoice-real' },
    )

    const receipt = await box.exchange.processFile(path.join(ws, '交换区', 'inv-real.json'))

    expect(receipt.status).toBe('ok')
    // 台账记录真实落库（必填校验/查重/日期归一化/账物路径校验全链路经 InvoicesService.create）
    const list = await box.invoices.list()
    expect(list).toHaveLength(1)
    const rec = list[0]
    expect(rec.number).toBe('20260811001')
    expect(rec.date).toBe('2026-08-01')
    expect(rec.amount).toBe(128.5)
    expect(rec.seller).toBe('开票方A')
    expect(rec.buyer).toBe('购方B')
    expect(rec.customer).toBe('张三')
    expect(rec.due_date).toBe('2026-09-01')
    expect(rec.status).toBe('待报销') // §6.3 流转起点
    expect(rec.file_path).toBe(receipt.target_paths[0])
    expect(rec.file_path).toMatch(/^发票\/2026\/.+\.pdf$/)
    // 账物一致：台账指向的归档文件真实存在
    await expect(fsp.stat(path.join(ws, rec.file_path))).resolves.toBeTruthy()
    // 回执落盘 + 投递区归零
    expect((await readReceipt(ws, 'inv-real')).status).toBe('ok')
    await expect(fsp.stat(path.join(ws, '交换区', 'f.pdf'))).rejects.toThrow()
  })

  it('真实 ledger 查重兜底：同号码再投递 → invoices.create 拒绝 → error 回执，台账不重复', async () => {
    await placeDelivery(
      ws,
      'inv-real',
      {
        id: 'inv-real',
        kind: 'invoice',
        files: ['f.pdf'],
        invoice: { number: '20260811002', date: '2026-08-02', amount: 50, seller: '开票方B', buyer: '购方A' },
      },
      { 'f.pdf': 'first' },
    )
    const first = await box.exchange.processFile(path.join(ws, '交换区', 'inv-real.json'))
    expect(first.status).toBe('ok')
    expect((await box.invoices.list())).toHaveLength(1)

    // 换 id 再投同一号码 → 命中查重（三入口同函数），error 回执且不建记录
    await placeDelivery(
      ws,
      'inv-real-dup',
      {
        id: 'inv-real-dup',
        kind: 'invoice',
        files: ['g.pdf'],
        invoice: { number: '20260811002', date: '2026-08-03', amount: 60, seller: '开票方B', buyer: '购方A' },
      },
      { 'g.pdf': 'dup' },
    )
    const dup = await box.exchange.processFile(path.join(ws, '交换区', 'inv-real-dup.json'))
    expect(dup.status).toBe('error')
    expect(dup.error).toContain('已存在')
    expect((await box.invoices.list())).toHaveLength(1)
    expect((await readReceipt(ws, 'inv-real-dup')).status).toBe('error')
  })
})
