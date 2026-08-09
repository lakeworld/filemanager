/**
 * 更新检查单测（v2.4.0）：手写版本比较 + checkUpdate 网络/解析/超时分支。
 * checkUpdate 通过 fetchImpl 注入网络实现，不依赖真实网络与 Electron。
 */
import { describe, expect, it, vi } from 'vitest'
import { checkUpdate, compareVersions } from '../../src/main/updater'

function mockFetchJson(data: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('版本比较（compareVersions）', () => {
  it('按 . 分段数值比较（支持 2.3.1 形式）', () => {
    expect(compareVersions('2.3.1', '2.3.0')).toBeGreaterThan(0)
    expect(compareVersions('2.3.0', '2.3.1')).toBeLessThan(0)
    expect(compareVersions('2.3.1', '2.3.1')).toBe(0)
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    // 缺段按 0 补齐
    expect(compareVersions('2.3', '2.3.0')).toBe(0)
    expect(compareVersions('2.3.1', '2.3')).toBeGreaterThan(0)
  })

  it('v 前缀与首尾空白容错', () => {
    expect(compareVersions('v2.3.1', '2.3.0')).toBeGreaterThan(0)
    expect(compareVersions(' 2.3.1 ', '2.3.1')).toBe(0)
    expect(compareVersions('v2.4.0', 'v2.3.9')).toBeGreaterThan(0)
  })
})

describe('检查更新（checkUpdate）', () => {
  it('远端版本更新 → 返回 UpdateInfo（v 前缀归一化）', async () => {
    const info = await checkUpdate(
      '2.3.1',
      mockFetchJson({
        version: 'v2.4.0',
        download_url: 'https://www.qihebook.cloud/file-manager',
        checksum: 'abc123',
        release_notes: '新功能上线',
      }),
    )
    expect(info).toEqual({
      version: '2.4.0',
      download_url: 'https://www.qihebook.cloud/file-manager',
      checksum: 'abc123',
      release_notes: '新功能上线',
    })
  })

  it('远端版本相等 / 更低 → 返回 null', async () => {
    expect(await checkUpdate('2.4.0', mockFetchJson({ version: '2.4.0', download_url: 'x' }))).toBeNull()
    expect(await checkUpdate('2.4.0', mockFetchJson({ version: '2.3.1', download_url: 'x' }))).toBeNull()
  })

  it('HTTP 非 2xx → 抛「检查更新失败」', async () => {
    await expect(checkUpdate('2.3.1', mockFetchJson({}, 500))).rejects.toThrow('检查更新失败')
  })

  it('返回格式非法（缺字段 / 非 JSON）→ 抛「检查更新失败」', async () => {
    await expect(checkUpdate('2.3.1', mockFetchJson({ foo: 1 }))).rejects.toThrow('检查更新失败')
    const bad = vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch
    await expect(checkUpdate('2.3.1', bad)).rejects.toThrow('检查更新失败')
  })

  it('网络异常 → 抛「检查更新失败：<原因>」', async () => {
    const netErr = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(checkUpdate('2.3.1', netErr)).rejects.toThrow('检查更新失败：ECONNREFUSED')
  })

  it('10s 超时 → 抛「检查更新失败：请求超时」', async () => {
    vi.useFakeTimers()
    try {
      // 永不返回的 fetch：仅在 abort 时 reject AbortError
      const never = vi.fn(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      ) as unknown as typeof fetch
      const p = checkUpdate('2.3.1', never)
      const assertion = expect(p).rejects.toThrow('检查更新失败：请求超时')
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
