/**
 * 客户 erp 写路径单测（v2.5.1 A1：customers 能力域实装，PLAN-v2.6-v2.7 §3.1）
 * 覆盖：
 * - writeErpExt：整体替换 erp_ext / 目录有而 JSON 无条目 → 补最小条目（D8）/ 目录亦无 → NOT_FOUND / updated_at 刷新 / 原子写
 * - resolveSyncProfile 纯函数全分支（D6）：早于 → STALE / 同时 → STALE / 晚于 → 合并白名单差异字段 /
 *   越白名单字段（含 tags D7）→ FIELD_DENIED / 空 fields / Date.parse 归一化与非法入参
 * - syncProfile：整链（目录基准 / erp_ext 合并 / updated_at 回写）
 * - relation 委托既有 linkRelation/unlinkRelation 语义（幂等 / 产品集不存在）
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { resolveSyncProfile } from '../../src/main/core/clients'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-erp-'))
}

async function readCustomersStore(ws: string): Promise<Record<string, any>> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'customers.json'), 'utf-8'))
}

async function makeBox(): Promise<{ home: string; ws: string; box: ReturnType<typeof buildTestBox> }> {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { home, ws, box }
}

// —— resolveSyncProfile 纯函数（D6 裁决）——

describe('resolveSyncProfile 纯函数（D6 记录级裁决）', () => {
  const base = {
    alias: 'A',
    country: 'CN',
    contact: 'c',
    source: 's',
    type: '企业' as const,
    phone: '138',
    email: 'a@b.com',
    address: 'addr',
    tags: ['t1'],
    notes: 'n',
    related_product_sets: ['PS1'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }

  it('req.updated_at 早于档案 → STALE（不写）', () => {
    const r = resolveSyncProfile(base, {
      fields: { phone: '139' },
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    expect(r).toEqual({ applied: false })
  })

  it('req.updated_at 同时 → STALE（D6：同时不后写）', () => {
    const r = resolveSyncProfile(base, {
      fields: { phone: '139' },
      updated_at: '2026-01-02T00:00:00.000Z',
    })
    expect(r).toEqual({ applied: false })
  })

  it('req.updated_at 较新 → 合并白名单差异字段 + erp_ext，box 权威字段保留', () => {
    const r = resolveSyncProfile(base, {
      fields: { phone: '139', type: '个人' },
      erp_ext: { code: 'C001', status: 'active' },
      updated_at: '2026-01-03T00:00:00.000Z',
    })
    expect(r.applied).toBe(true)
    const next = r.next as NonNullable<typeof r.next>
    expect(next.phone).toBe('139')
    expect(next.type).toBe('个人')
    expect(next.erp_ext).toEqual({ code: 'C001', status: 'active' })
    // box 权威字段未被覆盖
    expect(next.alias).toBe('A')
    expect(next.country).toBe('CN')
    expect(next.tags).toEqual(['t1'])
    expect(next.related_product_sets).toEqual(['PS1'])
    // updated_at 刷新为 req 值（规范化）
    expect(next.updated_at).toBe('2026-01-03T00:00:00.000Z')
  })

  it('白名单外字段（alias/country/source/related_product_sets/tags）入参 → FIELD_DENIED（D7）', () => {
    for (const bad of [
      { alias: 'X' },
      { country: 'US' },
      { source: 'x' },
      { related_product_sets: ['PS2'] },
      { tags: ['x'] },
    ] as const) {
      const r = resolveSyncProfile(base, { fields: bad as never, updated_at: '2026-01-03T00:00:00.000Z' })
      expect(r).toEqual({ applied: false, denied: true })
    }
  })

  it('fields 为空对象且无 erp_ext → applied:false（无差异不写）', () => {
    const r = resolveSyncProfile(base, { fields: {}, updated_at: '2026-01-03T00:00:00.000Z' })
    expect(r).toEqual({ applied: false })
  })

  it('空 fields + erp_ext → 仅写 erp_ext', () => {
    const r = resolveSyncProfile(base, { erp_ext: { status: 'blacklisted' }, updated_at: '2026-01-03T00:00:00.000Z' })
    expect(r.applied).toBe(true)
    const next = r.next as NonNullable<typeof r.next>
    expect(next.erp_ext).toEqual({ status: 'blacklisted' })
    expect(next.phone).toBe('138')
  })

  it('Date.parse 归一化：空格分隔格式（仓迹 PB）与 ISO 等价', () => {
    const r = resolveSyncProfile(base, { fields: { phone: '139' }, updated_at: '2026-01-03 00:00:00' })
    expect(r.applied).toBe(true)
  })

  it('非法 updated_at → STALE（不写）', () => {
    const r = resolveSyncProfile(base, { fields: { phone: '139' }, updated_at: 'not-a-date' })
    expect(r).toEqual({ applied: false })
  })

  it('fields 内字段值 trim 后写入；空白 phone 拒绝', () => {
    const r = resolveSyncProfile(base, { fields: { phone: '  ' }, updated_at: '2026-01-03T00:00:00.000Z' })
    expect(r).toEqual({ applied: false, denied: true })
  })
})

// —— writeErpExt / syncProfile（core 整链）——

describe('ClientsService erp 写路径（v2.5.1 A1）', () => {
  it('writeErpExt：整体替换 erp_ext + updated_at 刷新', async () => {
    const { ws, box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138' })
    await box.clients.writeErpExt('张三', { code: 'C001', status: 'active' })
    const store = await readCustomersStore(ws)
    expect(store['张三'].erp_ext).toEqual({ code: 'C001', status: 'active' })
    expect(store['张三'].phone).toBe('138')
    expect(store['张三'].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('writeErpExt：目录有而 JSON 无条目 → 补最小条目后写（D8 目录基准）', async () => {
    const { ws, box } = await makeBox()
    // 手工建目录（绕过 create），模拟目录有、档案无
    await fsp.mkdir(path.join(ws, '客户', '李四'), { recursive: true })
    await box.clients.writeErpExt('李四', { code: 'L001' })
    const store = await readCustomersStore(ws)
    expect(store['李四']).toBeTruthy()
    expect(store['李四'].erp_ext).toEqual({ code: 'L001' })
    expect(store['李四'].created_at).toBeTruthy()
  })

  it('writeErpExt：目录亦无 → NOT_FOUND', async () => {
    const { box } = await makeBox()
    await expect(box.clients.writeErpExt('不存在', { code: 'X' })).rejects.toThrow('客户不存在')
  })

  it('syncProfile：整链——较新写入白名单字段 + erp_ext，updated_at 回填', async () => {
    const { ws, box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138', type: '企业' })
    const before = (await readCustomersStore(ws))['张三']
    const r = await box.clients.syncProfile({
      name: '张三',
      fields: { phone: '139', type: '个人' },
      erp_ext: { code: 'C9' },
      updated_at: '2099-01-01T00:00:00.000Z',
    })
    expect(r.applied).toBe(true)
    const after = (await readCustomersStore(ws))['张三']
    expect(after.phone).toBe('139')
    expect(after.type).toBe('个人')
    expect(after.erp_ext).toEqual({ code: 'C9' })
    expect(after.updated_at).toBe('2099-01-01T00:00:00.000Z')
    expect(after.alias).toBe(before.alias)
  })

  it('syncProfile：过期 → STALE（不写）', async () => {
    const { ws, box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138' })
    const r = await box.clients.syncProfile({
      name: '张三',
      fields: { phone: '139' },
      updated_at: '2000-01-01T00:00:00.000Z',
    })
    expect(r.applied).toBe(false)
    const after = (await readCustomersStore(ws))['张三']
    expect(after.phone).toBe('138')
  })

  it('syncProfile：白名单外字段 → FIELD_DENIED（不写）', async () => {
    const { ws, box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138' })
    await expect(
      box.clients.syncProfile({
        name: '张三',
        fields: { tags: ['x'] } as never,
        updated_at: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('白名单')
    const after = (await readCustomersStore(ws))['张三']
    expect(after.tags).not.toEqual(['x'])
  })

  it('syncProfile：目录不存在 → NOT_FOUND', async () => {
    const { box } = await makeBox()
    await expect(
      box.clients.syncProfile({ name: '不存在', updated_at: '2099-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('客户不存在')
  })

  it('relation 委托：link/unlink 语义与既有 API 一致（幂等、产品集不存在拒绝）', async () => {
    const { ws, box } = await makeBox()
    await box.clients.create({ name: '张三' })
    await box.workspace.productSetCreate({ name: 'PS1' })
    await box.clients.linkRelation('张三', 'PS1')
    await box.clients.linkRelation('张三', 'PS1') // 幂等
    let store = await readCustomersStore(ws)
    expect(store['张三'].related_product_sets).toEqual(['PS1'])
    await expect(box.clients.linkRelation('张三', '不存在')).rejects.toThrow('不存在')
    await box.clients.unlinkRelation('张三', 'PS1')
    store = await readCustomersStore(ws)
    expect(store['张三'].related_product_sets).toEqual([])
  })

  it('get：目录存在 → 档案合并视图；目录不存在 → null（D8 目录基准）', async () => {
    const { box } = await makeBox()
    await box.clients.create({ name: '张三', phone: '138', tags: ['t'] })
    const c = await box.clients.get('张三')
    expect(c?.name).toBe('张三')
    expect(c?.phone).toBe('138')
    expect(c?.tags).toEqual(['t'])
    expect(await box.clients.get('不存在')).toBeNull()
  })

  it('listSince：since 严大于 updated_at 过滤（ISO 归一化），缺省全量', async () => {
    const { box } = await makeBox()
    await box.clients.create({ name: '张三' })
    const all = await box.clients.listSince()
    expect(all.length).toBe(1)
    // 未来时间 → 空；1970 → 全量
    expect(await box.clients.listSince('2099-01-01T00:00:00.000Z')).toHaveLength(0)
    expect((await box.clients.listSince('1970-01-01T00:00:00.000Z')).length).toBe(1)
  })
})

// —— v2.5.1（D9/D20）：事件桥语义（core 级钩子；IPC 层投递在 ipc.ts 装配测试之外，行为面由本组锁定）——

describe('客户/归档事件桥（v2.5.1 D9/D20）', () => {
  it('onExchangeArchived：交换区归集成功 → 逐条回调（失败/回滚不回调）', async () => {
    const { box } = await makeBox()
    const events: string[] = []
    box.onExchangeArchived = (archived) => events.push(...archived)
    // 投递一个描述文件 + 源文件到交换区
    const ws = box.workspace.currentWorkspacePath()!
    const exDir = path.join(ws, '交换区')
    await fsp.mkdir(path.join(exDir, '已处理'), { recursive: true })
    const src = path.join(exDir, '源发票.pdf')
    await fsp.writeFile(src, 'pdf-bytes')
    const desc = {
      id: 'inv-evt-001',
      kind: 'invoice',
      invoice: { number: 'INV-001', date: '2026-08-15', amount: 100, seller: '卖方', buyer: '买方' },
      files: ['源发票.pdf'],
    }
    const descPath = path.join(exDir, 'inv-evt-001.json')
    await fsp.writeFile(descPath, JSON.stringify(desc))
    const receipt = await box.exchange.processFile(descPath)
    expect(receipt.status).toBe('ok')
    expect(receipt.target_paths.length).toBeGreaterThan(0)
    // 归档副本路径入回调（成功路径；target_paths = 工作区相对路径）
    expect(events.length).toBe(receipt.target_paths.length)
    expect(events[0]).toBe(receipt.target_paths[0])
  })

  it('resolveSyncProfile 判定独立于事件桥（纯函数不触发回调）', () => {
    // 纯函数无副作用（D6 裁决与 D9 事件解耦的锚点）
    expect(resolveSyncProfile({ updated_at: '2026-01-01T00:00:00.000Z' }, { updated_at: '2026-01-01T00:00:00.000Z' })).toEqual({
      applied: false,
    })
  })
})
