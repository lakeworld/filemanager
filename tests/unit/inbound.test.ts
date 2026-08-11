/**
 * 入库单服务单测（v2.4.7 §7 / §3.4）
 * 覆盖：查重（创建/编辑两入口 + 排除自身）/ 必填校验 / 日期归一化 / 归档命名与冲突序号 /
 * 账物分离（默认不删文件、deleteFile 走回收站、文件缺失不炸）/ 损坏降级 / 相对路径归一化。
 */
import { describe, it, expect } from 'vitest'
import { WorkspaceService } from '../../src/main/core/workspace'
import { MetadataService } from '../../src/main/core/metadata'
import { TrashService } from '../../src/main/core/trash'
import { InboundService, type InboundCreateRequest } from '../../src/main/core/inbound'
import { FakeThumbs } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** 组装 InboundService（BoxService 聚合由整合步骤负责，此处直接注入 TrashService 以测 deleteFile） */
function build(home: string) {
  const workspace = new WorkspaceService(home)
  const metadata = new MetadataService(workspace)
  const thumbs = new FakeThumbs()
  const trash = new TrashService(workspace, metadata, thumbs)
  const inbound = new InboundService(workspace, trash)
  return { workspace, inbound, trash }
}

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-inbound-'))
}

/** 工作区外的源文件（UI 选本地文件场景） */
async function makeSourceFile(name = '入库单-001.pdf'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-inbound-src-'))
  const p = path.join(dir, name)
  await fsp.writeFile(p, 'pdf-bytes')
  return p
}

async function readStore(ws: string): Promise<{ records: Record<string, unknown> }> {
  return JSON.parse(await fsp.readFile(path.join(ws, '.qihefilemanager', 'inbound.json'), 'utf-8'))
}

function baseReq(overrides: Partial<InboundCreateRequest> = {}): InboundCreateRequest {
  return { id: 'IN-001', date: '2026-08-11', supplier: '深圳启禾科技有限公司', file_path: '入库/2026/入库单-001.pdf', ...overrides }
}

describe('InboundService（v2.4.7 §7 入库归档）', () => {
  it('create：归档文件 → 建记录（日期归一化 + 相对路径 / 分隔 + 文件已复制）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026/08/11')
    expect(rel).toBe('入库/2026/入库单-001.pdf')

    const rec = await inbound.create({
      id: 'IN-001',
      date: '2026/08/11',
      supplier: '  深圳启禾科技有限公司  ',
      product_set: '系列A',
      file_path: rel,
      amount: 1200,
      notes: '首批到货',
    })
    expect(rec.date).toBe('2026-08-11')
    expect(rec.file_path).toBe('入库/2026/入库单-001.pdf')
    expect(rec.supplier).toBe('深圳启禾科技有限公司')
    expect(rec.created_at).toBeTruthy()

    // 归档主体已复制到 入库/<YYYY>/，内容一致
    const archived = await fsp.readFile(path.join(ws, '入库', '2026', '入库单-001.pdf'), 'utf-8')
    expect(archived).toBe('pdf-bytes')

    // 台账落盘
    const store = await readStore(ws)
    expect(store.records['IN-001']).toMatchObject({
      id: 'IN-001',
      date: '2026-08-11',
      supplier: '深圳启禾科技有限公司',
      product_set: '系列A',
      file_path: '入库/2026/入库单-001.pdf',
      amount: 1200,
      notes: '首批到货',
    })
  })

  it('查重：同编号二次 create 拒绝，并提示已有记录摘要', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    await inbound.create(baseReq())
    await expect(inbound.create(baseReq())).rejects.toThrow(/已存在.*深圳启禾科技有限公司/)
    await expect(inbound.create(baseReq())).rejects.toThrow(/2026-08-11.*入库\/2026\/入库单-001\.pdf/)
  })

  it('必填校验：缺编号 / 供应商 / 文件路径 / 非法日期均拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)
    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026-08-11')

    await expect(inbound.create(baseReq({ id: '  ' }))).rejects.toThrow('单据编号不能为空')
    await expect(inbound.create(baseReq({ supplier: '  ' }))).rejects.toThrow('供应商不能为空')
    await expect(inbound.create(baseReq({ file_path: ' ' }))).rejects.toThrow('缺少归档文件路径')
    await expect(inbound.create(baseReq({ file_path: rel, date: 'not-a-date' }))).rejects.toThrow('入库日期格式无效')
    // file_path 越界（工作区外绝对路径）→ 拒绝
    const outside = await makeSourceFile()
    await expect(inbound.create(baseReq({ file_path: outside }))).rejects.toThrow('必须位于工作区内')
    // file_path 指向工作区内缺失文件 → 放行（账物分离：文件被删后记录仍可建/改，UI 灰显）
    const rec = await inbound.create(baseReq({ file_path: '入库/2026/已被手动删除.pdf' }))
    expect(rec.file_path).toBe('入库/2026/已被手动删除.pdf')
  })

  it('archiveFile：命名 sanitize + 冲突序号 _1/_2；源文件可来自工作区外', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const src = await makeSourceFile('入库单:A?001.pdf') // 非法字符应被 sanitize
    const rel1 = await inbound.archiveFile(src, '2026-08-11')
    expect(rel1).toBe('入库/2026/入库单_A_001.pdf')

    const rel2 = await inbound.archiveFile(src, '2026-08-11')
    expect(rel2).toBe('入库/2026/入库单_A_001_1.pdf')

    // 冲突序号在「当前 candidate」上追加（与 naming.ts resolveConflictName 有意保持的累积行为一致：base_1_2）
    const rel3 = await inbound.archiveFile(src, '2026-08-11')
    expect(rel3).toBe('入库/2026/入库单_A_001_1_2.pdf')

    // 不同年份分目录
    const rel4 = await inbound.archiveFile(src, '2027-01-02')
    expect(rel4).toBe('入库/2027/入库单_A_001.pdf')
  })

  it('update：字段更新 + 查重排除自身（同编号可更新）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    await inbound.create(baseReq())
    const rec = await inbound.update('IN-001', baseReq({ date: '2026-08-12', supplier: '改后供应商', amount: 999 }))
    expect(rec.supplier).toBe('改后供应商')
    expect(rec.date).toBe('2026-08-12')
    expect(rec.amount).toBe(999)
    expect(rec.updated_at).toBeTruthy()

    // 台账仅一条（未产生重复 key）
    const store = await readStore(ws)
    expect(Object.keys(store.records)).toHaveLength(1)
  })

  it('update：编号可改（key 迁移）；撞号其他记录仍拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    await inbound.create(baseReq({ id: 'IN-001' }))
    await inbound.create(baseReq({ id: 'IN-002' }))

    const rec = await inbound.update('IN-001', baseReq({ id: 'IN-009' }))
    expect(rec.id).toBe('IN-009')

    const store = await readStore(ws)
    expect(store.records['IN-001']).toBeUndefined()
    expect(store.records['IN-009']).toBeTruthy()

    // 撞号：IN-009 → IN-002
    await expect(inbound.update('IN-009', baseReq({ id: 'IN-002' }))).rejects.toThrow(/已存在/)
  })

  it('remove：账物分离——默认不删文件，记录删除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026-08-11')
    await inbound.create(baseReq({ file_path: rel }))

    await inbound.remove('IN-001')
    const store = await readStore(ws)
    expect(store.records['IN-001']).toBeUndefined()
    // 文件仍在（账物分离）
    await expect(fsp.stat(path.join(ws, '入库', '2026', '入库单-001.pdf'))).resolves.toBeTruthy()
  })

  it('remove(deleteFile)：文件走回收站（file 单条目），记录删除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026-08-11')
    await inbound.create(baseReq({ file_path: rel }))

    await inbound.remove('IN-001', { deleteFile: true })

    const store = await readStore(ws)
    expect(store.records['IN-001']).toBeUndefined()
    // 原文件已移入回收站
    await expect(fsp.stat(path.join(ws, '入库', '2026', '入库单-001.pdf'))).rejects.toThrow()
    const trashDir = path.join(ws, '.qihefilemanager', 'trash')
    const entries = await fsp.readdir(trashDir)
    expect(entries).toHaveLength(1)
    const dataDir = path.join(trashDir, entries[0], 'data')
    expect(await fsp.readFile(dataDir, 'utf-8')).toBe('pdf-bytes')
  })

  it('remove(deleteFile)：文件已缺失时只删记录，不炸', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    await inbound.create(baseReq()) // file_path 指向不存在的文件（模拟文件被手动删除）
    await expect(inbound.remove('IN-001', { deleteFile: true })).resolves.toBeUndefined()

    const store = await readStore(ws)
    expect(store.records['IN-001']).toBeUndefined()
  })

  it('create：file_path 传工作区内绝对路径 → 归一化为相对路径', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026-08-11')
    const abs = path.join(ws, ...rel.split('/'))
    const rec = await inbound.create(baseReq({ file_path: abs }))
    expect(rec.file_path).toBe(rel)
  })

  it('损坏的 inbound.json：备份原文件并降级为空库，不丢新写入', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    const storePath = path.join(ws, '.qihefilemanager', 'inbound.json')
    await fsp.writeFile(storePath, '{ 这不是合法 JSON', 'utf-8')

    expect(await inbound.list()).toEqual([])
    // 备份存在
    const dir = await fsp.readdir(path.join(ws, '.qihefilemanager'))
    expect(dir.some((n) => n.startsWith('inbound.json.corrupt-'))).toBe(true)

    // 降级后可正常写入
    const src = await makeSourceFile()
    const rel = await inbound.archiveFile(src, '2026-08-11')
    await inbound.create(baseReq({ file_path: rel }))
    const store = await readStore(ws)
    expect(store.records['IN-001']).toBeTruthy()
  })

  it('list：按入库日期降序（同日按创建序），并返回全量记录', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { workspace, inbound } = build(home)
    await workspace.create(ws)

    await inbound.create(baseReq({ id: 'IN-A', date: '2026-01-05' }))
    await inbound.create(baseReq({ id: 'IN-B', date: '2026-08-11' }))
    await inbound.create(baseReq({ id: 'IN-C', date: '2026-03-20' }))

    const list = await inbound.list()
    expect(list.map((r) => r.id)).toEqual(['IN-B', 'IN-C', 'IN-A'])
  })
})
