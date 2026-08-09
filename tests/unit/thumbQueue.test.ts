/**
 * ThumbQueue 单测（v2.4.2 修复 2）：缩略图生成队列——浏览优先 / 代际作废 / 超时 / 上限。
 * 纯逻辑测试，不依赖 sharp / electron。
 */
import { describe, it, expect } from 'vitest'
import { ThumbQueue } from '../../src/main/thumbnail'

const resolveAfter = <T>(v: T, ms: number): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), ms))

describe('ThumbQueue（v2.4.2 修复 2）', () => {
  it('并发上限：同时最多 running 个任务', async () => {
    const q = new ThumbQueue<string>(2, 1000, 100)
    let running = 0
    let max = 0
    const tasks = Array.from({ length: 5 }, () =>
      q.enqueue(async () => {
        running++
        max = Math.max(max, running)
        await resolveAfter('ok', 30)
        running--
        return 'ok'
      }, 'background'),
    )
    await Promise.all(tasks)
    expect(max).toBe(2)
  })

  it('browse 优先：browse 任务插队到 background 之前执行', async () => {
    const q = new ThumbQueue<string>(1, 1000, 100)
    const order: string[] = []
    const bg = q.enqueue(async () => {
      order.push('bg')
      await resolveAfter('ok', 30)
      return 'ok'
    }, 'background')
    const bg2 = q.enqueue(async () => {
      order.push('bg2')
      return 'ok'
    }, 'background')
    const br = q.enqueue(async () => {
      order.push('browse')
      return 'ok'
    }, 'browse')
    await Promise.all([bg, bg2, br])
    expect(order).toEqual(['bg', 'browse', 'bg2'])
  })

  it('cancelPendingBrowse：作废排队中的 browse 任务（settle 空串），background 保留', async () => {
    const q = new ThumbQueue<string>(1, 1000, 100)
    let ran = 0
    const slow = q.enqueue(async () => {
      ran++
      await resolveAfter('done', 50)
      return 'done'
    }, 'background')
    const b1 = q.enqueue(async () => {
      ran++
      return 'b1'
    }, 'browse')
    const b2 = q.enqueue(async () => {
      ran++
      return 'b2'
    }, 'browse')
    const bg = q.enqueue(async () => {
      ran++
      return 'bg'
    }, 'background')

    expect(q.pendingCount).toBe(3)
    const cancelled = q.cancelPendingBrowse()
    expect(cancelled).toBe(2)
    expect(q.pendingCount).toBe(1)

    await slow
    const [r1, r2, r3] = await Promise.all([b1, b2, bg])
    expect(r1).toBe('') // 作废 → 空串（前端 loadId 守卫会丢弃）
    expect(r2).toBe('')
    expect(r3).toBe('bg') // background 保留并执行
    expect(ran).toBe(2) // 只真正执行了 slow 和 bg
  })

  it('超时：任务永不 settle → 按取消值收尾并释放槽位（防全局真死锁）', async () => {
    const q = new ThumbQueue<string>(1, 50, 100)
    const never = q.enqueue(() => new Promise<string>(() => {}), 'background')
    const after = q.enqueue(async () => 'after', 'background')
    expect(await never).toBe('')
    expect(await after).toBe('after')
  })

  it('队列上限：background 超限立即失败，browse 不受限', async () => {
    const q = new ThumbQueue<string>(1, 1000, 3)
    const slow = q.enqueue(async () => {
      await resolveAfter('x', 30)
      return 'slow'
    }, 'background')
    const e1 = q.enqueue(async () => 'e1', 'background')
    const e2 = q.enqueue(async () => 'e2', 'background')
    const e3 = q.enqueue(async () => 'e3', 'background')
    // 此时队列已满（3 个）→ 第 4 个 background 立即失败
    const e4 = q.enqueue(async () => 'e4', 'background')
    await Promise.all([slow, e1, e2, e3])
    expect(await e4).toBe('')
    // browse 不受上限影响
    const br = q.enqueue(async () => 'br', 'browse')
    expect(await br).toBe('br')
  })
})
