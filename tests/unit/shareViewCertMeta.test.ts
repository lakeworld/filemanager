/**
 * D8 单测（v2.6 批7）：share 域元数据扩证书两字段 cert_type / expiry_date（读写各一扩 + 合并口径 + 单测）。
 * 覆盖：
 * - mergeTextField（notes/cert_type/expiry_date 共用口径）：本地空采纳远端 / 不同保本地+冲突 / 相同不冲突
 * - mergeCertMeta 四态：本地空采纳远端、本地非空不同保本地+冲突、相同不冲突、远端缺字段不动本地
 * - expiry_date 归一化（2027/1/5 → 2027-01-05；不可解析原样）——复用 metadata 侧既有归一化，未写第二套
 * - getMetadata 形状含两字段（空态 / 有值态 / 产品集根恒空串）
 * - mergePulledMetadata 端到端（store 落值 + 冲突清单）；产品集根路径不受影响（照旧 tags/notes，无证书字段）
 * 消费方：写进 expiry_date 后由 box 原生证书到期提醒 dashboard.checkExpiringCerts 消费（本文件不测提醒侧）。
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { ShareViewService, mergeTextField, mergeCertMeta } from '../../src/main/core/shareView'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-share-cert-'))
}

async function makeBox(): Promise<{ ws: string; box: ReturnType<typeof buildTestBox> }> {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { ws, box }
}

/** 在工作区内造一个文件（产品集内），返回绝对路径 */
async function makeFile(ws: string, rel: string): Promise<string> {
  const abs = path.join(ws, ...rel.split('/'))
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, 'x')
  return abs
}

// —— mergeTextField：notes / cert_type / expiry_date 共用口径 ——

describe('mergeTextField（D8 共用单字段口径）', () => {
  it('本地空 → 采纳远端；相同 → 保持；本地非空且不同 → 保留本地 + 冲突', () => {
    expect(mergeTextField('', '远端')).toEqual({ value: '远端', conflict: false })
    expect(mergeTextField('same', 'same')).toEqual({ value: 'same', conflict: false })
    expect(mergeTextField('本地', '远端')).toEqual({ value: '本地', conflict: true })
    // 两侧 trim（与 store 写入口径一致）
    expect(mergeTextField('  ', ' 远端 ')).toEqual({ value: '远端', conflict: false })
  })
})

// —— mergeCertMeta：四态 ——

describe('mergeCertMeta（D8 证书两字段合并）', () => {
  it('本地空 → 采纳远端（两字段各自判定）', () => {
    expect(mergeCertMeta({ cert_type: '', expiry_date: '' }, { cert_type: 'CE', expiry_date: '2027-01-05' })).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: false,
    })
    // 逐字段独立：cert_type 本地有值保本地，expiry_date 本地空采纳远端
    expect(mergeCertMeta({ cert_type: 'FCC', expiry_date: '' }, { cert_type: 'CE', expiry_date: '2027-01-05' })).toEqual({
      cert_type: 'FCC',
      expiry_date: '2027-01-05',
      conflict: true,
    })
  })

  it('本地非空且不同 → 保留本地 + conflict', () => {
    expect(mergeCertMeta({ cert_type: 'CE', expiry_date: '2027-01-05' }, { cert_type: 'FCC', expiry_date: '2028-03-09' })).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: true,
    })
  })

  it('相同 → 不冲突（expiry_date 归一化后比较：同一天不同写法不算差异）', () => {
    expect(mergeCertMeta({ cert_type: 'CE', expiry_date: '2027-01-05' }, { cert_type: 'CE', expiry_date: '2027/1/5' })).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: false,
    })
    expect(mergeCertMeta({ cert_type: 'CE', expiry_date: '2027-01-05' }, { cert_type: ' CE ', expiry_date: '2027-01-05' })).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: false,
    })
  })

  it('远端缺字段（undefined）→ 不改动本地、不计冲突（显式空串才走「本地空采纳远端」）', () => {
    expect(mergeCertMeta({ cert_type: 'CE', expiry_date: '2027-01-05' }, {})).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: false,
    })
    // 只给一个字段：另一个照旧不动
    expect(mergeCertMeta({ cert_type: 'CE', expiry_date: '2027-01-05' }, { expiry_date: '2027-02-06' })).toEqual({
      cert_type: 'CE',
      expiry_date: '2027-01-05',
      conflict: true,
    })
  })

  it('expiry_date 归一化：远端可解析 → YYYY-MM-DD；不可解析 → 原样', () => {
    expect(mergeCertMeta({}, { expiry_date: '2027/1/5' }).expiry_date).toBe('2027-01-05')
    expect(mergeCertMeta({}, { expiry_date: '2027.1.5' }).expiry_date).toBe('2027-01-05')
    expect(mergeCertMeta({}, { expiry_date: '待定' }).expiry_date).toBe('待定')
  })
})

// —— ShareViewService：读路径形状 ——

describe('getMetadata（D8 读路径扩两字段）', () => {
  it('文件级：空态回空串，有值态回 store 值；产品集根恒空串', async () => {
    const { ws, box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['ps'], notes: 'ps-note' })
    const file = await makeFile(ws, '产品集/PS1/证书/sku/ce.pdf')
    const svc = new ShareViewService(box)

    // 空态：无元数据记录 → 四字段全空（形状恒含证书两字段）
    expect(await svc.getMetadata('产品集/PS1/证书/sku/ce.pdf')).toEqual({
      tags: [],
      notes: '',
      cert_type: '',
      expiry_date: '',
    })

    // 有值态
    await box.metadata.update({ file_path: file, tags: ['t'], notes: 'n', cert_type: 'CE', expiry_date: '2027/1/5' })
    expect(await svc.getMetadata('产品集/PS1/证书/sku/ce.pdf')).toEqual({
      tags: ['t'],
      notes: 'n',
      cert_type: 'CE',
      expiry_date: '2027-01-05', // store 侧归一化
    })

    // 产品集根：证书两字段恒空串（产品集根不是证书载体）
    expect(await svc.getMetadata('产品集/PS1')).toEqual({
      tags: ['ps'],
      notes: 'ps-note',
      cert_type: '',
      expiry_date: '',
    })
  })
})

// —— ShareViewService：写路径（合并 + 冲突清单 + 两级粒度） ——

describe('mergePulledMetadata（D8 写路径扩两字段）', () => {
  it('文件级：本地空采纳远端两字段，expiry_date 归一化后落 store', async () => {
    const { ws, box } = await makeBox()
    const file = await makeFile(ws, '产品集/PS1/证书/ce.pdf')
    const svc = new ShareViewService(box)

    const r = await svc.mergePulledMetadata([
      { path: '产品集/PS1/证书/ce.pdf', tags: [], notes: '', cert_type: 'CE', expiry_date: '2027/1/5' },
    ])
    expect(r.conflicts).toEqual([])
    const meta = await box.metadata.get(file)
    expect(meta.cert_type).toBe('CE')
    expect(meta.expiry_date).toBe('2027-01-05')
    // 回读路径同源
    expect((await svc.getMetadata('产品集/PS1/证书/ce.pdf')).expiry_date).toBe('2027-01-05')
  })

  it('文件级：本地非空且不同 → 保本地并计入冲突清单（证书字段也计）', async () => {
    const { ws, box } = await makeBox()
    const file = await makeFile(ws, '产品集/PS1/证书/ce.pdf')
    await box.metadata.update({ file_path: file, tags: [], notes: '', cert_type: 'CE', expiry_date: '2027-01-05' })
    const svc = new ShareViewService(box)

    // 仅证书字段冲突（tags/notes 本地空 → 采纳远端，不冲突）
    const r = await svc.mergePulledMetadata([
      { path: '产品集/PS1/证书/ce.pdf', tags: [], notes: '', cert_type: 'FCC', expiry_date: '2028-03-09' },
    ])
    expect(r.conflicts).toContain('产品集/PS1/证书/ce.pdf')
    const meta = await box.metadata.get(file)
    expect(meta.cert_type).toBe('CE')
    expect(meta.expiry_date).toBe('2027-01-05')
  })

  it('文件级：远端缺证书字段 → 本地不动、不计冲突；不可解析日期原样保留', async () => {
    const { ws, box } = await makeBox()
    const file = await makeFile(ws, '产品集/PS1/证书/ce.pdf')
    await box.metadata.update({ file_path: file, tags: [], notes: '', cert_type: 'CE', expiry_date: '2027-01-05' })
    const svc = new ShareViewService(box)

    // 旧版对端不表态证书字段（tags/notes 相同 → 零冲突）
    const r1 = await svc.mergePulledMetadata([{ path: '产品集/PS1/证书/ce.pdf', tags: [], notes: '' }])
    expect(r1.conflicts).toEqual([])
    const meta = await box.metadata.get(file)
    expect(meta.cert_type).toBe('CE')
    expect(meta.expiry_date).toBe('2027-01-05')

    // 不可解析日期（本地空）→ 采纳远端原文落 store（与 metadata.update 口径一致：解析失败原样保留）
    const file2 = await makeFile(ws, '产品集/PS1/证书/other.pdf')
    const r2 = await svc.mergePulledMetadata([
      { path: '产品集/PS1/证书/other.pdf', tags: [], notes: '', expiry_date: '待定' },
    ])
    expect(r2.conflicts).toEqual([])
    expect((await box.metadata.get(file2)).expiry_date).toBe('待定')

    // 不可解析远端 + 本地非空 → 仍按「不同 → 保本地 + 冲突」处理（不可解析不当成"同值"）
    const r3 = await svc.mergePulledMetadata([
      { path: '产品集/PS1/证书/ce.pdf', tags: [], notes: '', expiry_date: '待定' },
    ])
    expect(r3.conflicts).toContain('产品集/PS1/证书/ce.pdf')
    expect((await box.metadata.get(file)).expiry_date).toBe('2027-01-05')
  })

  it('产品集根路径不受影响：照旧只落 tags/notes，证书字段不落、不记冲突', async () => {
    const { box } = await makeBox()
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['ps'], notes: '' })
    const svc = new ShareViewService(box)

    const r = await svc.mergePulledMetadata([
      { path: '产品集/PS1', tags: ['ps2'], notes: 'ps-remote', cert_type: 'CE', expiry_date: '2027-01-05' },
    ])
    expect(r.conflicts).toEqual([]) // 产品集根不是证书载体 ⇒ 缺落点不算"说不拢"
    const psExtra = await box.workspace.loadProductSetsInfo()
    expect(psExtra['PS1'].tags).toEqual(['ps', 'ps2'])
    expect(psExtra['PS1'].notes).toBe('ps-remote')
    expect('cert_type' in psExtra['PS1']).toBe(false)
    expect('expiry_date' in psExtra['PS1']).toBe(false)
  })
})