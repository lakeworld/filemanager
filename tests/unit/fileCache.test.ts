import { describe, it, expect } from 'vitest'
import { FileListCache } from '../../src/main/core/scanCache'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-cache-'))
}

describe('FileListCache（v2.4.x 文件列表缓存）', () => {
  it('命中：build 只执行一次，第二次 get 直接返回缓存', async () => {
    const dir = await tmp()
    const cache = new FileListCache<string>()
    let calls = 0
    const build = async (): Promise<string[]> => {
      calls++
      return ['a.jpg', 'b.png']
    }
    const first = await cache.get(dir, build)
    expect(first).toEqual(['a.jpg', 'b.png'])
    expect(calls).toBe(1)
    const second = await cache.get(dir, build)
    expect(second).toEqual(['a.jpg', 'b.png'])
    expect(calls).toBe(1) // 未重复构建
  })

  it('invalidate 后重建', async () => {
    const dir = await tmp()
    const cache = new FileListCache<string>()
    let data = ['a.jpg']
    const build = async (): Promise<string[]> => [...data]
    await cache.get(dir, build)
    data = ['a.jpg', 'b.png'] // 模拟磁盘内容变化
    // 未失效 → 命中旧缓存
    expect(await cache.get(dir, build)).toEqual(['a.jpg'])
    // 显式失效 → 重建
    cache.invalidate(dir)
    expect(await cache.get(dir, build)).toEqual(['a.jpg', 'b.png'])
  })

  it('目录 mtime 变化（touch）→ 签名变化 → 重建', async () => {
    const dir = await tmp()
    const cache = new FileListCache<string>()
    let calls = 0
    const build = async (): Promise<string[]> => {
      calls++
      return ['x.jpg']
    }
    await cache.get(dir, build)
    expect(calls).toBe(1)
    // 显式把目录 mtime 往后推（+5s，避开文件系统粒度差异）
    const st = await fsp.stat(dir)
    await fsp.utimes(dir, new Date(st.mtimeMs - 5000), new Date(st.mtimeMs + 5000))
    expect(await cache.get(dir, build)).toEqual(['x.jpg'])
    expect(calls).toBe(2) // mtime 变化 → 重建
  })

  it('目录不存在 → 返回空数组且不缓存（build 不被调用）', async () => {
    const dir = path.join(await tmp(), 'not-exist')
    const cache = new FileListCache<string>()
    let calls = 0
    const build = async (): Promise<string[]> => {
      calls++
      return ['y.jpg']
    }
    expect(await cache.get(dir, build)).toEqual([])
    expect(await cache.get(dir, build)).toEqual([])
    expect(calls).toBe(0) // 每次 stat 失败直接返回空，跳过构建
  })

  it('LRU 上限淘汰最久未用条目', async () => {
    const root = await tmp()
    // 填满 512 上限后插入第 513 个 → 淘汰最旧的 d0
    const n = 513
    const dirs: string[] = []
    for (let i = 0; i < n; i++) {
      dirs.push(path.join(root, `d${i}`))
      await fsp.mkdir(dirs[i], { recursive: true })
    }
    const cache = new FileListCache<string>()
    let calls = 0
    const build = async (): Promise<string[]> => {
      calls++
      return []
    }
    for (const d of dirs) await cache.get(d, build)
    expect(calls).toBe(n) // 插入第 513 个时淘汰 d0，总构建 513 次
    // d1..d512 仍在缓存（命中不重建）
    const before = calls
    await cache.get(dirs[1], build)
    expect(calls).toBe(before)
    // d0 已被淘汰 → 重建
    await cache.get(dirs[0], build)
    expect(calls).toBe(before + 1)
  })

  it('inflight：并发 get 共享同一次构建', async () => {
    const dir = await tmp()
    const cache = new FileListCache<string>()
    let calls = 0
    const build = async (): Promise<string[]> => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return ['z.jpg']
    }
    const results = await Promise.all([cache.get(dir, build), cache.get(dir, build), cache.get(dir, build)])
    expect(results).toEqual([['z.jpg'], ['z.jpg'], ['z.jpg']])
    expect(calls).toBe(1) // 并发去重
  })
})
