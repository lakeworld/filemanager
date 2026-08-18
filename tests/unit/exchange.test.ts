/**
 * 交换区投递服务单测（v2.4.7，PLAN §8）：
 * - 四种 kind（invoice/inbound/customer/productSet）投递 → 真实文件归集 → 回执
 * - 坏 JSON 拒绝、id 与文件名不一致、kind 未知、投递文件不存在 → error 回执
 * - 重复 id → duplicate 回执，不重复归集；崩溃重入幂等
 * - 客户/产品集目标不存在 → error 回执（不自动建目录）
 * - 台账 sink 查重失败 → error 回执；台账未接入 → error 回执且文件不落盘
 * - sweep 批量补扫（跳过非 json）；簿记 500 条滚动截断；start/stop 生命周期
 * - v2.5.3 找bug轮 D4：SKIPPED kind 标记判定（不依赖文案）、簿记 mutateJsonFile 锁内并发不丢 id、
 *   簿记失败（state 损坏）收尾回滚本次副本（customer/productSet 无台账路径）、双会话竞争不覆盖 ok 回执
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

/** 轮询等待条件（替代固定 setTimeout 等待，稳定无脆弱窗口；v2.5.3 T6-S4） */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
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

/** 构造记账 sink（记录调用参数；可注入失败行为）。v2.5.3（T6）：sink 接收显式 ws */
function makeLedger() {
  const calls: { kind: 'invoice' | 'inbound'; ws: string; payload: unknown; archived: string[] }[] = []
  const ledger: ExchangeLedgerSinks = {
    createInvoice: async (ws, d, archived) => {
      calls.push({ kind: 'invoice', ws, payload: d, archived })
    },
    createInbound: async (ws, d, archived) => {
      calls.push({ kind: 'inbound', ws, payload: d, archived })
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

  // —— v2.5.3 T6：交换区切换治理 ——

  it('队列中尚未开始的任务在 stop 后直接退出（跳过，不落盘不操作）', async () => {
    const { ledger } = makeLedger()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const ledgerCalls: string[] = []
    ledger.createInvoice = async (sinkWs, d, archived) => {
      ledgerCalls.push('invoice')
      await gate
    }
    const exchange = newExchange(ledger)
    await placeDelivery(ws, 'inv-first', { id: 'inv-first', kind: 'invoice', files: ['a.pdf'], invoice: { number: '1000', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'a.pdf': 'x' })
    await placeDelivery(ws, 'inv-queued', { id: 'inv-queued', kind: 'invoice', files: ['b.pdf'], invoice: { number: '1001', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'b.pdf': 'y' })

    // 第一个任务入队并开始（卡在台账挂起）；第二个任务排在队列后，尚未开始
    const first = exchange.processFile(path.join(ws, '交换区', 'inv-first.json'))
    await waitFor(() => ledgerCalls.length === 1) // 确定性：first 已走到台账挂起
    const queued = exchange.processFile(path.join(ws, '交换区', 'inv-queued.json'))
    exchange.stop() // 队列中尚未开始的 inv-queued 应直接退出
    releaseFirst()

    const r1 = await first
    const rq = await queued
    expect(r1.status).toBe('ok') // 已开始任务在捕获 ws 完整收尾
    expect(rq.status).toBe('error')
    expect(rq.error).toContain('工作区已切换')
    expect(ledgerCalls).toHaveLength(1) // 仅 first 调用台账

    // inv-queued 未被消费：描述仍在、无回执、源文件仍在
    await expect(fsp.stat(path.join(ws, '交换区', 'inv-queued.json'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, '交换区', 'b.pdf'))).resolves.toBeTruthy()
    const done = await fsp.readdir(path.join(ws, '交换区', '已处理')).catch(() => [] as string[])
    expect(done.filter((n) => n.startsWith('inv-queued'))).toHaveLength(0)
  })

  it('台账挂起期间切换工作区：已开始任务用捕获 ws 完整收尾，回滚也用捕获 ws（不误删新区文件）', async () => {
    let releaseLedger!: () => void
    const ledgerGate = new Promise<void>((resolve) => { releaseLedger = resolve })
    const calls: string[] = []
    const ledger = makeLedger().ledger
    ledger.createInvoice = async (sinkWs, d, archived) => {
      calls.push(`create@${sinkWs}`)
      await ledgerGate
      throw new Error('台账写入失败（模拟）') // 挂起后失败 → 触发回滚
    }
    const exchange = newExchange(ledger)
    await placeDelivery(ws, 'inv-slow', { id: 'inv-slow', kind: 'invoice', files: ['f.pdf'], invoice: { number: '999', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'f.pdf': 'x' })

    const processing = exchange.processFile(path.join(ws, '交换区', 'inv-slow.json')) // 入队捕获 ws（当前 ws）
    await waitFor(() => calls.length === 1) // 确定性：处理已走到台账挂起

    // 切换工作区（新 ws 上放同结构文件，验证回滚不会误删新区文件）
    const ws2 = await tmp()
    await box.workspace.create(ws2)
    exchange.stop()
    await fsp.mkdir(path.join(ws2, '发票', '2026'), { recursive: true })
    await fsp.writeFile(path.join(ws2, '发票', '2026', 'fake-user-file.pdf'), 'keep me')

    releaseLedger() // 台账完成：旧 ws 的归档副本已复制，此刻回滚失败
    const receipt = await processing
    expect(receipt.status).toBe('error') // 台账失败路径
    // 回滚只删旧 ws 归档副本，不影响新工作区的同名文件
    const oldLeftovers = await fsp.readdir(path.join(ws, '发票', '2026')).catch(() => [] as string[])
    expect(oldLeftovers.filter((n) => n.endsWith('.pdf'))).toHaveLength(0)
    const newLeftovers = await fsp.readdir(path.join(ws2, '发票', '2026')).catch(() => [] as string[])
    expect(newLeftovers).toContain('fake-user-file.pdf')
  })

  it('session 非当前时归档完成通知（onArchived）不发送', async () => {
    let releaseLedger!: () => void
    let ledgerCalled = false
    const ledgerGate = new Promise<void>((resolve) => { releaseLedger = resolve })
    const archivedEvents: string[][] = []
    const ledger = makeLedger().ledger
    ledger.createInvoice = async (sinkWs, d, archived) => {
      ledgerCalled = true
      await ledgerGate
    }
    ledger.onArchived = (archived) => archivedEvents.push(archived)
    const exchange = newExchange(ledger)
    await placeDelivery(ws, 'inv-notify', { id: 'inv-notify', kind: 'invoice', files: ['f.pdf'], invoice: { number: '777', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'f.pdf': 'x' })

    const processing = exchange.processFile(path.join(ws, '交换区', 'inv-notify.json'))
    await waitFor(() => ledgerCalled) // 确定性：台账已挂起
    exchange.stop() // 会话已过期
    releaseLedger()

    const receipt = await processing
    expect(receipt.status).toBe('ok') // 已开始任务在捕获 ws 完整收尾
    expect(archivedEvents).toHaveLength(0) // 但通知不发
  })

  // —— v2.5.3 T6-S1/S2/S4：旧 sweep 不补扫、跳过不计入、成功路径跨区收尾 ——

  it('sweep 在入队点捕获会话：stop 后未开始的旧 sweep 开始前直接退出，跳过任务不计入处理数（T6-S1/S2）', async () => {
    const { calls, ledger } = makeLedger()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    ledger.createInvoice = async (sinkWs, d, archived) => {
      calls.push({ kind: 'invoice', ws: sinkWs, payload: d, archived })
      await gate
    }
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'sweep-1',
      { id: 'sweep-1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '10', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'a.pdf': 'x' },
    )
    await placeDelivery(
      ws,
      'sweep-2',
      { id: 'sweep-2', kind: 'invoice', files: ['b.pdf'], invoice: { number: '11', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'b.pdf': 'y' },
    )

    // 第一个 sweep 入队并开始（sweep-1 卡在台账挂起）；第二个无参 sweep 在 stop 前入队（入队点捕获旧代会话）
    const first = exchange.sweep()
    await waitFor(() => calls.length === 1) // 确定性：sweep-1 已开始处理
    const second = exchange.sweep() // 入队点捕获 gen（仍为旧代）
    exchange.stop() // 换代：两个 sweep 的会话全部过期
    release()

    const c1 = await first
    const c2 = await second
    expect(c1).toBe(1) // sweep-1 已开始 → 在捕获 ws 完整收尾，计 1
    expect(c2).toBe(0) // sweep-2 未开始 → 直接退出，跳过任务不计入
    expect(calls).toHaveLength(1) // 仅 sweep-1 调用台账
    // sweep-2 的投递未被消费：描述仍在、无回执、源文件仍在
    await expect(fsp.stat(path.join(ws, '交换区', 'sweep-2.json'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, '交换区', 'b.pdf'))).resolves.toBeTruthy()
    const done = await fsp.readdir(path.join(ws, '交换区', '已处理')).catch(() => [] as string[])
    expect(done.filter((n) => n.startsWith('sweep-2'))).toHaveLength(0)
  })

  it('台账成功路径：处理中切区后收尾只写捕获 ws 的簿记/回执，不碰新区（T6-S4b）', async () => {
    let release!: () => void
    let ledgerCalled = false
    const gate = new Promise<void>((r) => { release = r })
    const archivedEvents: string[][] = []
    const ledger = makeLedger().ledger
    ledger.createInvoice = async (sinkWs, d, archived) => {
      ledgerCalled = true
      await gate // 成功路径：挂起后正常返回（不抛错）
    }
    ledger.onArchived = (archived) => archivedEvents.push(archived)
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'inv-sw',
      { id: 'inv-sw', kind: 'invoice', files: ['f.pdf'], invoice: { number: '321', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )

    const processing = exchange.processFile(path.join(ws, '交换区', 'inv-sw.json'))
    await waitFor(() => ledgerCalled) // 确定性：台账已挂起

    // 处理中切换工作区（新 ws 上无任何交换区活动）
    const ws2 = await tmp()
    await box.workspace.create(ws2)
    exchange.stop()
    release()

    const receipt = await processing
    expect(receipt.status).toBe('ok') // 已开始任务在捕获 ws 完整收尾
    // 簿记/回执/描述消费只发生在捕获的旧 ws
    const state1 = JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'exchange_state.json'), 'utf-8')) as { processed: { id: string }[] }
    expect(state1.processed.some((p) => p.id === 'inv-sw')).toBe(true)
    await expect(fsp.stat(path.join(ws, '交换区', '已处理', 'inv-sw.receipt.json'))).resolves.toBeTruthy()
    await expect(fsp.stat(path.join(ws, '交换区', 'inv-sw.json'))).rejects.toThrow()
    // 新 ws 无任何簿记/回执痕迹
    await expect(fsp.stat(path.join(ws2, '.qihefilemanager', 'exchange_state.json'))).rejects.toThrow()
    await expect(fsp.stat(path.join(ws2, '交换区', '已处理', 'inv-sw.receipt.json'))).rejects.toThrow()
    // 通知不发（session 非当前）
    expect(archivedEvents).toHaveLength(0)
  })

  // —— v2.5.3 找bug轮 D4：SKIPPED kind 判定 / 簿记锁内读改写 / 收尾补偿 / 双会话竞争加固 ——

  it('SKIPPED 回执携带专用 kind 标记（判定不依赖中止文案）', async () => {
    const { ledger } = makeLedger()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const ledgerCalls: string[] = []
    ledger.createInvoice = async (sinkWs, d, archived) => {
      ledgerCalls.push('invoice')
      await gate
    }
    const exchange = newExchange(ledger)
    await placeDelivery(ws, 'sk-1', { id: 'sk-1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '100', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'a.pdf': 'x' })
    await placeDelivery(ws, 'sk-2', { id: 'sk-2', kind: 'invoice', files: ['b.pdf'], invoice: { number: '101', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } }, { 'b.pdf': 'y' })

    // 第一个任务入队并开始（卡在台账挂起）；第二个任务排在队列后，stop 后尚未开始 → SKIPPED
    const first = exchange.processFile(path.join(ws, '交换区', 'sk-1.json'))
    await waitFor(() => ledgerCalls.length === 1)
    const queued = exchange.processFile(path.join(ws, '交换区', 'sk-2.json'))
    exchange.stop()
    releaseFirst()

    const r1 = await first
    const skipped = await queued
    expect(r1.status).toBe('ok')
    // 兼容既有语义：中止回执仍为 error + 中止文案
    expect(skipped.status).toBe('error')
    expect(skipped.error).toContain('工作区已切换')
    // D4：带去重用的专用 kind 标记，判定不靠固定文案
    expect((skipped as { kind?: string }).kind).toBe('skipped')
  })

  it('业务 error 回执文案与中止文案完全相同 → 不被误判为 SKIPPED（sweep 正常计数）', async () => {
    const ledger = makeLedger().ledger
    // 业务失败文案碰巧与中止文案逐字相同——旧实现（文案匹配）会误判为跳过不计入处理数
    ledger.createInvoice = async () => { throw new Error('工作区已切换，投递中止') }
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'tw-1',
      { id: 'tw-1', kind: 'invoice', files: ['a.pdf'], invoice: { number: '1', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'a.pdf': 'x' },
    )

    const count = await exchange.sweep()

    expect(count).toBe(1) // 作为业务 error 计入处理数
    const receipt = await readReceipt(ws, 'tw-1')
    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('工作区已切换')
  })

  it('并发簿记不丢 id：双实例同时处理 20 个投递，全部 id 入账（mutateJsonFile 锁内读改写）', async () => {
    const exA = newExchange(makeLedger().ledger)
    const exB = newExchange(makeLedger().ledger)
    const n = 10
    const descs: string[] = []
    for (let i = 0; i < n; i++) {
      const nameA = `并发客户A${i}`
      const nameB = `并发客户B${i}`
      await fsp.mkdir(path.join(ws, '客户', nameA, '报价'), { recursive: true })
      await fsp.mkdir(path.join(ws, '客户', nameB, '报价'), { recursive: true })
      await placeDelivery(ws, `cc-a${i}`, { id: `cc-a${i}`, kind: 'customer', files: [`src-a${i}.pdf`], customer: { name: nameA, sub_folder: '报价' } }, { [`src-a${i}.pdf`]: 'x' })
      await placeDelivery(ws, `cc-b${i}`, { id: `cc-b${i}`, kind: 'customer', files: [`src-b${i}.pdf`], customer: { name: nameB, sub_folder: '报价' } }, { [`src-b${i}.pdf`]: 'y' })
      descs.push(path.join(ws, '交换区', `cc-a${i}.json`), path.join(ws, '交换区', `cc-b${i}.json`))
    }
    // 两实例各处理一半、全部并发：同一 exchange_state.json 的簿记写相互交错
    const results = await Promise.all([
      ...descs.filter((_, idx) => idx % 2 === 0).map((d) => exA.processFile(d)),
      ...descs.filter((_, idx) => idx % 2 === 1).map((d) => exB.processFile(d)),
    ])
    expect(results.every((r) => r.status === 'ok')).toBe(true)

    const state = JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'exchange_state.json'), 'utf-8')) as { processed: { id: string }[] }
    for (let i = 0; i < n; i++) {
      expect(state.processed.some((p) => p.id === `cc-a${i}`), `并发簿记丢 id：cc-a${i}`).toBe(true)
      expect(state.processed.some((p) => p.id === `cc-b${i}`), `并发簿记丢 id：cc-b${i}`).toBe(true)
    }
  })

  it('簿记失败（exchange_state 损坏，D3 拒绝覆盖）→ ok 收尾中止：本次归档回滚、原文件保留、无带序号孤儿', async () => {
    const exchange = newExchange(makeLedger().ledger)
    const statePath = path.join(ws, '.qihefilemanager', 'exchange_state.json')
    // customer 投递（无台账查重兜底——必须靠收尾补偿回滚）
    await fsp.mkdir(path.join(ws, '客户', '客户甲', '报价'), { recursive: true })
    await placeDelivery(
      ws,
      'rb-cust',
      { id: 'rb-cust', kind: 'customer', files: ['a.pdf'], customer: { name: '客户甲', sub_folder: '报价' } },
      { 'a.pdf': 'x' },
    )
    await fsp.writeFile(statePath, '{ 损坏的簿记 !!!')

    const receipt = await exchange.processFile(path.join(ws, '交换区', 'rb-cust.json'))

    expect(receipt.status).toBe('error')
    expect(receipt.error).toContain('损坏') // 簿记失败原因如实进入 error 回执
    // 本次复制副本被回滚：归档目录无残留（也无 _1 带序号孤儿副本）
    expect((await fsp.readdir(path.join(ws, '客户', '客户甲', '报价'))).filter((n) => n.endsWith('.pdf'))).toHaveLength(0)
    // 原文件仍在源目录（removeSourceFiles 未执行）
    await expect(fsp.stat(path.join(ws, '交换区', 'a.pdf'))).resolves.toBeTruthy()
    // 描述已被消费（error 回执路径），不会形成补扫重复复制循环
    await expect(fsp.stat(path.join(ws, '交换区', 'rb-cust.json'))).rejects.toThrow()

    // productSet 同法复验（无台账路径必须回滚）
    await box.workspace.productSetCreate({ name: '系列X' })
    await fsp.mkdir(path.join(ws, '产品集', '系列X', '图包', '主图'), { recursive: true })
    await fsp.writeFile(statePath, '{ 再次损坏 !!!')
    await placeDelivery(
      ws,
      'rb-ps',
      { id: 'rb-ps', kind: 'productSet', files: ['b.jpg'], productSet: { name: '系列X', file_type: 'image', sub_folder: '主图' } },
      { 'b.jpg': 'img' },
    )
    const receiptPs = await exchange.processFile(path.join(ws, '交换区', 'rb-ps.json'))
    expect(receiptPs.status).toBe('error')
    expect((await fsp.readdir(path.join(ws, '产品集', '系列X', '图包', '主图'))).filter((n) => n.endsWith('.jpg'))).toHaveLength(0)
    await expect(fsp.stat(path.join(ws, '交换区', 'b.jpg'))).resolves.toBeTruthy()
  })

  it('双会话竞争（同 ws stop+start）：新 sweep 排到已被旧会话消费的描述 → 不写 error 回执覆盖 ok 回执', async () => {
    const ledger = makeLedger().ledger
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let ledgerCalled = false
    ledger.createInvoice = async () => { ledgerCalled = true; await gate }
    const exchange = newExchange(ledger)
    await placeDelivery(
      ws,
      'race-1',
      { id: 'race-1', kind: 'invoice', files: ['f.pdf'], invoice: { number: '42', date: '2026-08-01', amount: 1, seller: 'a', buyer: 'b' } },
      { 'f.pdf': 'x' },
    )

    // 旧会话（gen1）处理中：复制完成、台账挂起——描述仍在交换区根
    const p1 = exchange.processFile(path.join(ws, '交换区', 'race-1.json'))
    await waitFor(() => ledgerCalled)
    exchange.stop() // 换代
    const sweepP = exchange.start() // 新会话补扫：readdir 快照仍含 race-1 描述
    await new Promise((r) => setTimeout(r, 150)) // 确保新 sweep 已完成 readdir 并排入处理队列（描述仍未被消费）
    release() // 旧会话收尾：写 ok 回执 + 移描述 → 新 sweep 排到的文件已被消费

    await expect(p1).resolves.toMatchObject({ status: 'ok' })
    await expect(sweepP).resolves.toBeDefined() // 新 sweep 正常完成，不因 ENOENT 抛错

    // 关键断言：ok 回执未被 error 回执覆盖；描述已被消费
    expect((await readReceipt(ws, 'race-1')).status).toBe('ok')
    await expect(fsp.stat(path.join(ws, '交换区', 'race-1.json'))).rejects.toThrow()
    await expect(fsp.stat(path.join(ws, '交换区', '已处理', 'race-1.json'))).resolves.toBeTruthy()
  })
})
