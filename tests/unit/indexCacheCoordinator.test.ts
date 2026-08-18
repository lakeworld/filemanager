/**
 * 工作区索引候选/代数提交（v2.5.3 T5）单测：
 * - forkForRebuild 只继承配置，不共享快照/脏标记容器
 * - replaceFrom 复制容器，过期 candidate 与全局索引无共享可变状态
 * - Coordinator 代数隔离：过期 session 不能提交、不能触碰 target、失效事件路由到当前 candidate
 */
import { describe, expect, it, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  WorkspaceIndex,
  WorkspaceIndexCoordinator,
  type WorkspaceIndexRebuildSession,
} from '../../src/main/core/indexCache'

let root = ''

/** 轮询等待条件（替代固定 setTimeout 等待，稳定无脆弱窗口） */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-idx-t5-'))
})

// 建一个可被 build() 扫描到叶子目录的工作区：ws/产品集/A/图包/主图/（空目录也可做快照）
async function makeLeaf(ws: string, set: string, sub: string): Promise<string> {
  const leaf = path.join(ws, '产品集', set, '图包', sub)
  await fsp.mkdir(leaf, { recursive: true })
  return leaf
}

function listRawStub(dir: string): Promise<import('../../src/main/core/indexCache').CompactItem[]> {
  return Promise.resolve([[path.basename(dir) + '.txt', 1, 1, 'other', 0]])
}

const snapsOf = (index: WorkspaceIndex): Map<string, unknown> =>
  (index as unknown as { snapshots: Map<string, unknown> }).snapshots
const dirtyOf = (index: WorkspaceIndex): Set<string> =>
  (index as unknown as { dirtyDirs: Set<string> }).dirtyDirs

describe('WorkspaceIndex.forkForRebuild / replaceFrom（v2.5.3 T5）', () => {
  it('fork 继承配置但快照与脏标记为空且不共享容器', async () => {
    const wsA = path.join(root, 'ws-a')
    const leafA = await makeLeaf(wsA, 'A', '主图')
    const target = new WorkspaceIndex({ max: 7, resolveThumb: () => 'thumb' })
    await target.build(wsA, listRawStub)
    target.invalidate(leafA)

    expect(snapsOf(target).size).toBeGreaterThan(0) // 前提：target 有快照

    const fork = target.forkForRebuild()
    expect((fork as unknown as { max: number }).max).toBe(7)
    expect((fork as unknown as { resolveThumb: () => string }).resolveThumb()).toBe('thumb')
    expect(snapsOf(fork).size).toBe(0) // 只复制配置，不复制数据
    expect(dirtyOf(fork).size).toBe(0)
    expect(snapsOf(target).size).toBeGreaterThan(0) // 不清空 target
  })

  it('replaceFrom 整体接管并复制容器（不共享 Map/Set）', async () => {
    const wsA = path.join(root, 'ws-a')
    const wsB = path.join(root, 'ws-b')
    await makeLeaf(wsA, 'A', '主图')
    await makeLeaf(wsB, 'B', '详情页')

    const target = new WorkspaceIndex()
    await target.build(wsA, listRawStub)
    const targetDirtyDir = path.join(wsA, '图包', '主图')
    target.invalidate(targetDirtyDir)

    const other = new WorkspaceIndex()
    await other.build(wsB, listRawStub)
    const otherDirtyDir = path.join(wsB, '图包', '详情页')
    other.invalidate(otherDirtyDir)

    target.replaceFrom(other)
    const oSnapshots = snapsOf(other)
    const oDirty = dirtyOf(other)
    const tSnapshots = snapsOf(target)
    const tDirty = dirtyOf(target)

    expect([...tSnapshots.keys()]).toEqual([...oSnapshots.keys()])
    // v2.5.3（T5-S2）：replaceFrom 合并且集——candidate 标记并入，target 自身仍有效的
    // 脏标记（epoch 已计数）不被提交抹掉（重建期间直写全局索引的失效靠此保留）
    expect(tDirty.has(otherDirtyDir)).toBe(true)
    expect(tDirty.has(targetDirtyDir)).toBe(true)
    expect(oDirty.has(targetDirtyDir)).toBe(false) // candidate 侧不受影响（容器已复制）

    // 复制容器：后续彼此修改互不影响
    const firstKey = [...oSnapshots.keys()][0]
    tSnapshots.delete(firstKey)
    expect(oSnapshots.has(firstKey)).toBe(true)
    tDirty.add('/new')
    expect(oDirty.has('/new')).toBe(false)
    expect(fs.readdirSync(root).length).toBeGreaterThan(0) // 不涉及真实 fs 副作用断言
  })
})

describe('WorkspaceIndexCoordinator（v2.5.3 T5）', () => {
  async function buildPair(withTargetData = true) {
    const wsA = path.join(root, 'ws-a')
    const leafA = await makeLeaf(wsA, 'A', '主图')
    const target = new WorkspaceIndex()
    if (withTargetData) {
      await target.build(wsA, listRawStub)
      target.invalidate(leafA)
    }
    const coordinator = new WorkspaceIndexCoordinator(target)
    return { target, coordinator, wsA }
  }

  it('commit 只在 session 仍为当前代时替换目标', async () => {
    const { target, coordinator, wsA } = await buildPair()
    const wsB = path.join(root, 'ws-b')
    await makeLeaf(wsB, 'B', '详情页')

    const s1 = coordinator.beginRebuild()
    await s1.candidate.build(wsB, listRawStub)
    expect(s1.isCurrent()).toBe(true)
    expect(s1.commit()).toBe(true)

    const keys = [...snapsOf(target).keys()]
    expect(keys.some((k) => k.startsWith(wsB))).toBe(true) // 已替换为新工作区快照
    expect(keys.some((k) => k.startsWith(wsA))).toBe(false)

    // 同一 session 重复提交幂等：generation 未变，再次替换同一候选仍成功
    expect(s1.commit()).toBe(true)
    expect([...snapsOf(target).keys()].some((k) => k.startsWith(wsB))).toBe(true)
  })

  it('过期 session 的 invalidate/commit 全部失效，不触碰 target', async () => {
    const { target, coordinator, wsA } = await buildPair()
    const wsB = path.join(root, 'ws-b')
    const leafB = await makeLeaf(wsB, 'B', '详情页')

    const s1 = coordinator.beginRebuild()
    await s1.candidate.build(wsB, listRawStub)

    const s2 = coordinator.beginRebuild() // 新一代 session 出现
    expect(s1.isCurrent()).toBe(false)
    expect(s2.isCurrent()).toBe(true)

    s1.invalidate(leafB)
    expect(dirtyOf(s1.candidate).has(leafB)).toBe(false) // 过期 session 的失效事件被忽略
    expect(s1.commit()).toBe(false)
    expect([...snapsOf(target).keys()].some((k) => k.startsWith(wsB))).toBe(false) // target 仍是旧代
    expect(dirtyOf(target).size).toBeGreaterThan(0) // 旧代数据未动

    const wsC = path.join(root, 'ws-c')
    await makeLeaf(wsC, 'C', '白底图')
    await s2.candidate.build(wsC, listRawStub)
    expect(s2.commit()).toBe(true)
    expect([...snapsOf(target).keys()].some((k) => k.startsWith(wsC))).toBe(true)
  })

  it('重建期间候选独立收集失效事件：build 前标记被处理清空，build 后新标记保留至提交', async () => {
    const { target, coordinator, wsA } = await buildPair()
    const wsB = path.join(root, 'ws-b')
    const leafB1 = await makeLeaf(wsB, 'B', '主图')
    const leafB2 = await makeLeaf(wsB, 'B', '详情页')

    const session = coordinator.beginRebuild()
    session.invalidate(leafB1)
    session.invalidate(leafB2)
    expect(dirtyOf(target).has(leafB1)).toBe(false) // 事件进候选而非 target
    expect(dirtyOf(session.candidate).size).toBe(2)

    await session.candidate.build(wsB, listRawStub)
    expect(dirtyOf(session.candidate).size).toBe(0) // build 已处理主图/详情页并清除标记

    // build 之后到达的失效事件（如重建期间的 fs.watch 事件）必须保留到提交
    const leafB3 = await makeLeaf(wsB, 'B', '白底图')
    session.invalidate(leafB3)
    expect(dirtyOf(session.candidate).has(leafB3)).toBe(true)

    expect(session.commit()).toBe(true)
    expect(dirtyOf(target).has(leafB3)).toBe(true) // 提交后新增失效事件保留，等待查询重建
    expect(dirtyOf(target).has(leafB1)).toBe(false) // 已处理过的目录不残留旧标记
  })

  it('generation 单调递增，beginRebuild 返回独立 session 对象', async () => {
    const { coordinator } = await buildPair()
    const a = coordinator.beginRebuild()
    const b = coordinator.beginRebuild()
    expect(a.generation).toBe(1)
    expect(b.generation).toBe(2)
    expect(a).not.toBe(b)
    expect(a.candidate).not.toBe(b.candidate)
  })

  it('WorkspaceIndexRebuildSession 形状与只读语义对齐接口', () => {
    const coordinator = new WorkspaceIndexCoordinator(new WorkspaceIndex())
    const session: WorkspaceIndexRebuildSession = coordinator.beginRebuild()
    expect(typeof session.isCurrent).toBe('function')
    expect(typeof session.invalidate).toBe('function')
    expect(typeof session.commit).toBe('function')
    expect(session.generation).toBe(1)
    expect(session.candidate).toBeInstanceOf(WorkspaceIndex)
  })

  // —— v2.5.3 T5-S2：每目录 revision——重建期间到达的失效事件必须保留到提交后 ——

  it('build 期间（挂在 listRaw 挂起点）经 session 注入的失效 → 提交后 target 仍带该标记', async () => {
    const target = new WorkspaceIndex()
    const coordinator = new WorkspaceIndexCoordinator(target)
    const wsB = path.join(root, 'ws-b')
    const leafB = await makeLeaf(wsB, 'B', '主图')

    const session = coordinator.beginRebuild()
    let reached = false
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const gated = async (dir: string) => {
      if (path.resolve(dir) === path.resolve(leafB)) {
        reached = true
        await gate // 挂起 build——模拟重建进行中
      }
      return listRawStub(dir)
    }
    const building = session.candidate.build(wsB, gated)
    await waitFor(() => reached) // 确定性：build 已进入 leafB 的 listRaw 挂起点
    session.invalidate(leafB) // 重建期间到达的失效事件 → 候选
    release()
    const built = await building
    expect(built).toBeGreaterThan(0)
    expect(dirtyOf(session.candidate).has(leafB)).toBe(true) // 期间新失效 → 标记保留
    expect(session.commit()).toBe(true)
    expect(dirtyOf(target).has(leafB)).toBe(true) // 提交后 target 仍带该标记，等待查询重建
  })

  it('build 期间直写全局索引的失效 → 提交合并且集后 target 仍带该标记', async () => {
    const target = new WorkspaceIndex()
    const coordinator = new WorkspaceIndexCoordinator(target)
    const wsB = path.join(root, 'ws-b')
    const leafB = await makeLeaf(wsB, 'B', '主图')

    const session = coordinator.beginRebuild()
    let reached = false
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const gated = async (dir: string) => {
      if (path.resolve(dir) === path.resolve(leafB)) {
        reached = true
        await gate
      }
      return listRawStub(dir)
    }
    const building = session.candidate.build(wsB, gated)
    await waitFor(() => reached)
    target.invalidate(leafB) // 重建期间直写全局索引（如 files/交换区路径）
    release()
    await building
    expect(dirtyOf(session.candidate).has(leafB)).toBe(false) // 候选侧无失效 → 标记被 build 消费
    expect(session.commit()).toBe(true)
    expect(dirtyOf(target).has(leafB)).toBe(true) // 直写失效随提交合并且集保留，不被 replaceFrom 抹掉
  })

  it('load() 不清除重建期间到达的脏标记（候选合入后保留仍有效的标记）', async () => {
    const target = new WorkspaceIndex()
    const coordinator = new WorkspaceIndexCoordinator(target)
    const wsB = path.join(root, 'ws-b')
    const leafB = await makeLeaf(wsB, 'B', '主图')

    const session = coordinator.beginRebuild()
    await session.candidate.build(wsB, listRawStub)
    const idxRoot = path.join(root, 'idx')
    await session.candidate.save(idxRoot)
    session.invalidate(leafB) // load 前到达的失效事件
    const loaded = await session.candidate.load(idxRoot) // 重新读盘：标记不得被清掉
    expect(loaded).toBe(true)
    expect(dirtyOf(session.candidate).has(leafB)).toBe(true)
    expect(session.commit()).toBe(true)
    expect(dirtyOf(target).has(leafB)).toBe(true)
  })
})