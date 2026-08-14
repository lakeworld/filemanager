/**
 * SharpThumbnailService 在途去重 pending 治理单测（审查 2026-08-14 P1-B1）：
 * - 取消后 pending 同步清理（不再泄漏），被取消文件再次 ensureThumbnail 重新生成（非空 URL）
 * - pending 上限（512）：超出淘汰最旧条目（Map 插入序）
 * 用 fake sharp（vi.mock）替代原生库：不 import electron / sharp，纯 node 直测。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SharpThumbnailService } from '../../src/main/thumbnail'
import { WorkspaceService } from '../../src/main/core/workspace'

/** fake sharp 门控状态（vi.hoisted 使 vi.mock 工厂可访问） */
const sharpMock = vi.hoisted(() => ({
  /** toFile 进入次数（= 已运行到生成末段的在途任务数） */
  entered: 0,
  /** 门控：放行前阻塞 toFile，用于占满并发槽位 */
  gate: Promise.resolve(),
}))

vi.mock('sharp', () => {
  const chain: Record<string, unknown> = {
    resize: () => chain,
    jpeg: () => chain,
    toFile: async () => {
      sharpMock.entered++
      await sharpMock.gate
    },
  }
  const sharp = Object.assign(vi.fn(() => chain), { cache: vi.fn() })
  return { default: sharp }
})

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-thumb-'))
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('SharpThumbnailService pending 治理（P1-B1）', () => {
  let ws: string
  let thumbsDir: string
  let svc: SharpThumbnailService

  beforeEach(async () => {
    ws = await tmp()
    thumbsDir = await tmp()
    const workspace = new WorkspaceService(await tmp())
    await workspace.create(ws)
    svc = new SharpThumbnailService(workspace, { userDataThumbsDir: thumbsDir })
    sharpMock.entered = 0
    sharpMock.gate = Promise.resolve()
  })

  it('取消后 pending 同步清理 + 被取消文件再次 ensureThumbnail 重新生成', async () => {
    // 门控占满 4 个并发槽位，让 browse 任务排队（cancel 只能作废排队中任务）
    let release!: () => void
    sharpMock.gate = new Promise<void>((r) => {
      release = r
    })

    const bgFiles = Array.from({ length: 4 }, (_, i) => path.join(ws, `bg-${i}.jpg`))
    for (const f of bgFiles) await fsp.writeFile(f, 'x')
    const bgPromises = bgFiles.map((f) => svc.ensureThumbnail(f, 'background'))

    // 等 4 个 background 任务全部运行到生成末段（占满槽位）
    await waitFor(() => sharpMock.entered === 4)
    expect(svc.pendingCount).toBe(4)

    // browse 任务排队（第 5 个，无空槽）
    const browseFile = path.join(ws, 'browse.jpg')
    await fsp.writeFile(browseFile, 'y')
    const browseP = svc.ensureThumbnail(browseFile, 'browse')
    await waitFor(() => svc.pendingCount === 5)

    // 作废排队中的 browse → 同步删除对应 pending key
    svc.cancelPendingBrowse()
    expect(svc.pendingCount).toBe(4)
    expect(await browseP).toBe('') // 被作废 → 空串（前端按失败处理）

    // 放行后台任务
    release()
    await Promise.all(bgPromises)

    // 被取消文件再次 ensureThumbnail → 重新生成，返回非空 URL（不再是已 settle 的空串）
    const again = await svc.ensureThumbnail(browseFile, 'browse')
    expect(again).toBeTruthy()
    expect(again.length).toBeGreaterThan(0)
  })

  it('pending 上限：超出 512 淘汰最旧条目，任务完成后全部清理', async () => {
    // 门控：让任务在生成末段挂起，保持 pending 不缩减
    let release!: () => void
    sharpMock.gate = new Promise<void>((r) => {
      release = r
    })

    const N = 513
    const promises: Promise<string>[] = []
    for (let i = 0; i < N; i++) {
      // 路径无需真实存在（isFresh 对不存在源返回 false，生成末段被门控拦下不读源）
      promises.push(svc.ensureThumbnail(path.join(ws, `cap-${i}.jpg`), 'browse'))
    }

    // 513 个在途去重条目 → 上限 512，最旧一条被淘汰
    await waitFor(() => svc.pendingCount === 512)
    expect(svc.pendingCount).toBe(512)

    release()
    await Promise.all(promises)
    // 全部 settle 后自清理（.finally），pending 归零
    expect(svc.pendingCount).toBe(0)
  })
})
