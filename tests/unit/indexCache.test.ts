import { describe, it, expect } from 'vitest'
import { WorkspaceIndex } from '../../src/main/core/indexCache'
import type { CompactItem } from '../../src/main/core/indexCache'
import { formatTime } from '../../src/main/core/workspace'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR, SUPPLIERS_DIR, QUOTES_DIR } from '../../src/main/core/paths'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-index-'))
}

/** 构造工作区产品集树：ws/产品集/<set>/图包|证书/<sub> */
async function buildWsTree(ws: string, sets: string[], imageSubs: string[], certSubs: string[]): Promise<void> {
  for (const s of sets) {
    for (const sub of imageSubs) {
      await fsp.mkdir(path.join(ws, PRODUCT_SETS_DIR, s, IMAGES_DIR, sub), { recursive: true })
    }
    for (const sub of certSubs) {
      await fsp.mkdir(path.join(ws, PRODUCT_SETS_DIR, s, CERTS_DIR, sub), { recursive: true })
    }
  }
}

describe('WorkspaceIndex（v2.4.x Everything 式精简索引）', () => {
  it('build 全量：遍历产品集树构建全部子目录，query 各目录命中零 listRaw', async () => {
    const ws = await tmp()
    await buildWsTree(ws, ['S1'], ['主图', '详情页'], ['3C'])
    const index = new WorkspaceIndex({ resolveThumb: (f) => `R:${path.basename(f)}` })
    let listRawCalls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      listRawCalls++
      return [['a.jpg', 1, 1700000000000, 'image', 0]]
    }
    const built = await index.build(ws, listRaw)
    expect(built).toBe(3) // 2 图包子目录 + 1 证书子目录
    expect(listRawCalls).toBe(3) // 每个子目录构建一次

    // 逐目录查询全部命中（不再调用 listRaw）
    const dirs = [
      path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图'),
      path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '详情页'),
      path.join(ws, PRODUCT_SETS_DIR, 'S1', CERTS_DIR, '3C'),
    ]
    for (const d of dirs) {
      const entries = await index.query(d, listRaw)
      expect(entries).toHaveLength(1)
      expect(entries[0].name).toBe('a.jpg')
      expect(entries[0].path).toBe(path.join(d, 'a.jpg'))
    }
    expect(listRawCalls).toBe(3) // 命中 → 未增加
  })

  it('build：供应商（两级）/ 报价（一级）区域纳入逐目录快照（v2.4.9 §6.2）', async () => {
    const ws = await tmp()
    // 供应商/<名>/<子文件夹> 与 报价/<YYYY>（其余区域目录不存在，readdir 为空不影响计数）
    await fsp.mkdir(path.join(ws, SUPPLIERS_DIR, '供应商A', '合同'), { recursive: true })
    await fsp.mkdir(path.join(ws, SUPPLIERS_DIR, '供应商A', '对账单'), { recursive: true })
    await fsp.mkdir(path.join(ws, SUPPLIERS_DIR, '供应商A', '往来文件'), { recursive: true })
    await fsp.mkdir(path.join(ws, QUOTES_DIR, '2026'), { recursive: true })
    const index = new WorkspaceIndex()
    let listRawCalls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      listRawCalls++
      return []
    }
    const built = await index.build(ws, listRaw)
    expect(built).toBe(4) // 供应商A 3 子文件夹 + 报价/2026
    expect(listRawCalls).toBe(4)

    // 命中查询零 listRaw
    const dir = path.join(ws, SUPPLIERS_DIR, '供应商A', '合同')
    expect(await index.query(dir, listRaw)).toEqual([])
    expect(listRawCalls).toBe(4)
  })

  it('query 命中零 listRaw；touch 目录 mtime 后签名变化 → 重建', async () => {
    const ws = await tmp()
    const dir = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    await fsp.mkdir(dir, { recursive: true })
    const index = new WorkspaceIndex()
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    expect(await index.query(dir, listRaw)).toEqual([])
    expect(calls).toBe(1)
    // 二次命中，零 listRaw
    expect(await index.query(dir, listRaw)).toEqual([])
    expect(calls).toBe(1)
    // 显式把目录 mtime 往后推（+5s，避开文件系统粒度差异）→ 签名变化 → 重建
    const st = await fsp.stat(dir)
    await fsp.utimes(dir, new Date(st.mtimeMs - 5000), new Date(st.mtimeMs + 5000))
    expect(await index.query(dir, listRaw)).toEqual([])
    expect(calls).toBe(2)
  })

  it('invalidate → dirty → 查询时重建（不即时扫描）', async () => {
    const ws = await tmp()
    const dir = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    await fsp.mkdir(dir, { recursive: true })
    const index = new WorkspaceIndex()
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    await index.query(dir, listRaw)
    expect(calls).toBe(1)
    index.invalidate(dir)
    expect(calls).toBe(1) // invalidate 不即时扫描
    await index.query(dir, listRaw)
    expect(calls).toBe(2) // 查询时重建
  })

  it('clear 同时清空 dirtyDirs 脏标记（v2.4.6：防脏标记滞留）；query 命中消费脏标记', async () => {
    const ws = await tmp()
    const dir = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    await fsp.mkdir(dir, { recursive: true })
    const index = new WorkspaceIndex()
    index.invalidate(dir)
    index.invalidate(path.join(ws, 'other'))
    expect(index.dirtyCount).toBe(2)
    index.clear()
    expect(index.dirtyCount).toBe(0)
    // query 命中脏目录后消费标记（既有行为锁定）
    const listRaw = async (): Promise<CompactItem[]> => []
    index.invalidate(dir)
    expect(index.dirtyCount).toBe(1)
    await index.query(dir, listRaw)
    expect(index.dirtyCount).toBe(0)
  })

  it('save → 新实例 load → query 命中（往返，不重扫）', async () => {
    const ws = await tmp()
    const dir = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    await fsp.mkdir(dir, { recursive: true })
    const index = new WorkspaceIndex()
    const listRaw = async (): Promise<CompactItem[]> => [['a.jpg', 10, 1700000000000, 'image', 1]]
    await index.query(dir, listRaw)
    const root = path.join(await tmp(), 'idx')
    await index.save(root)

    // 新实例 load 后 query 命中（签名一致 → 零 listRaw）
    const fresh = new WorkspaceIndex({ resolveThumb: (f) => `R:${path.basename(f)}` })
    expect(await fresh.load(root)).toBe(true)
    let freshCalls = 0
    const freshListRaw = async (): Promise<CompactItem[]> => {
      freshCalls++
      return []
    }
    const entries = await fresh.query(dir, freshListRaw)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('a.jpg')
    expect(entries[0].size).toBe(10)
    expect(entries[0].thumbnail_path).toBe('R:a.jpg')
    expect(freshCalls).toBe(0) // load 后命中
  })

  it('load：文件缺失 / 损坏 JSON / 版本不符 → false；部分损坏条目被过滤', async () => {
    const root = path.join(await tmp(), 'idx')
    const index = new WorkspaceIndex()
    expect(await index.load(root)).toBe(false) // 文件缺失
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(path.join(root, 'index.json'), 'not json{', 'utf-8')
    expect(await index.load(root)).toBe(false) // 损坏 JSON
    await fsp.writeFile(path.join(root, 'index.json'), JSON.stringify({ v: 999, dirs: {} }), 'utf-8')
    expect(await index.load(root)).toBe(false) // 版本不符
    // 部分损坏条目过滤，合法条目正常加载
    await fsp.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({
        v: 1,
        dirs: {
          bad: [0, ['x']],
          good: [1, [['a.jpg', 1, 2, 'image', 0]]],
        },
      }),
      'utf-8',
    )
    expect(await index.load(root)).toBe(true)
  })

  it('紧凑条目展开：path 拼接 / modified 格式 / thumbnail_path（resolveThumb 注入）', async () => {
    const ws = await tmp()
    const dir = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'pic.jpg'), 'x')
    const index = new WorkspaceIndex({ resolveThumb: (f) => `thumb:${path.basename(f)}` })
    const listRaw = async (d: string): Promise<CompactItem[]> => {
      const out: CompactItem[] = []
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        if (e.isDirectory() || e.name.startsWith('.')) continue
        const info = await fsp.stat(path.join(d, e.name))
        out.push([e.name, info.size, info.mtimeMs, 'image', 1])
      }
      return out
    }
    const entries = await index.query(dir, listRaw)
    expect(entries).toHaveLength(1)
    const fileStat = await fsp.stat(path.join(dir, 'pic.jpg'))
    expect(entries[0]).toEqual({
      name: 'pic.jpg',
      path: path.join(dir, 'pic.jpg'),
      size: fileStat.size,
      modified: formatTime(new Date(fileStat.mtimeMs)),
      file_type: 'image',
      thumbnail_path: 'thumb:pic.jpg',
    })
    // thumb=0 → thumbnail_path 空串
    const idx2 = new WorkspaceIndex({ resolveThumb: (f) => `thumb:${path.basename(f)}` })
    const listRaw2 = async (): Promise<CompactItem[]> => [['n.jpg', 1, fileStat.mtimeMs, 'image', 0]]
    const e2 = await idx2.query(dir, listRaw2)
    expect(e2[0].thumbnail_path).toBe('')
  })

  it('目录不存在 → [] 且不缓存（listRaw 不被调用）；目录出现后重建', async () => {
    const ws = await tmp()
    const missing = path.join(ws, 'not-exist')
    const index = new WorkspaceIndex()
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    expect(await index.query(missing, listRaw)).toEqual([])
    expect(await index.query(missing, listRaw)).toEqual([])
    expect(calls).toBe(0) // stat 失败直接返回空，跳过构建
    await fsp.mkdir(missing, { recursive: true })
    expect(await index.query(missing, listRaw)).toEqual([])
    expect(calls).toBe(1) // 目录出现 → 构建
  })

  it('LRU 淘汰最久未用条目（小 max 注入）', async () => {
    const root = await tmp()
    const dirs: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = path.join(root, `d${i}`)
      await fsp.mkdir(d, { recursive: true })
      dirs.push(d)
    }
    const index = new WorkspaceIndex({ max: 2 })
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    for (const d of dirs) await index.query(d, listRaw)
    expect(calls).toBe(3) // 插入第 3 个时淘汰 d0
    const before = calls
    await index.query(dirs[1], listRaw) // 仍在缓存 → 命中
    expect(calls).toBe(before)
    await index.query(dirs[0], listRaw) // 已被淘汰 → 重建
    expect(calls).toBe(before + 1)
  })

  it('build：不可读/非目录的类型目录跳过，返回成功构建数', async () => {
    const ws = await tmp()
    await fsp.mkdir(path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图'), { recursive: true })
    // 证书目录被替换为普通文件 → readdir 失败 → 跳过
    await fsp.writeFile(path.join(ws, PRODUCT_SETS_DIR, 'S1', CERTS_DIR), 'not a dir', 'utf-8')
    const index = new WorkspaceIndex()
    let calls = 0
    const listRaw = async (): Promise<CompactItem[]> => {
      calls++
      return []
    }
    const built = await index.build(ws, listRaw)
    expect(built).toBe(1)
    expect(calls).toBe(1)
  })

  it('validate：签名变化目录重建、消失目录移除，其余不动', async () => {
    const ws = await tmp()
    const dirA = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '主图')
    const dirB = path.join(ws, PRODUCT_SETS_DIR, 'S1', IMAGES_DIR, '详情页')
    await fsp.mkdir(dirA, { recursive: true })
    await fsp.mkdir(dirB, { recursive: true })
    const index = new WorkspaceIndex()
    const listRaw = async (): Promise<CompactItem[]> => [['x.jpg', 1, 1700000000000, 'image', 0]]
    await index.build(ws, listRaw)
    // touch dirA → 签名变化；删除 dirB
    const st = await fsp.stat(dirA)
    await fsp.utimes(dirA, new Date(st.mtimeMs - 5000), new Date(st.mtimeMs + 5000))
    await fsp.rm(dirB, { recursive: true, force: true })
    const changed = await index.validate(listRaw)
    expect(changed).toBe(2) // dirA 重建 + dirB 移除
    // dirA 快照已更新 → 命中；dirB 快照已移除 → 空列表
    const hitA = await index.query(dirA, listRaw)
    expect(hitA).toHaveLength(1)
    expect(await index.query(dirB, listRaw)).toEqual([])
  })
})
