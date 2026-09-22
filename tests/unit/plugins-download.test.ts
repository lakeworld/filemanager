/**
 * 官方索引形态下载单测（v2.6 批 2，宿主侧）：登录态 / 地址策略 / 逐字节 SHA-256 / 不落盘半包。
 *
 * 为什么这些用例必须存在：下载是**唯一一条把外部字节搬进宿主插件目录**的路径，
 * 三条硬判据都只能靠注入 fetch 钉死：
 * ① 未登录**不发起下载**（不是"下载了但拒绝安装"——那已经晚了）；
 * ② 校验不符 → 删包体 + 中文原因，**包体永不进安装管线**（「不落盘半包」的可验证形态）；
 * ③ 地址策略：https 或与云基址同源 http，其余（file:/data:/异源 http/垃圾串）一律拒绝。
 *
 * 覆盖：normalizeSha256 形状 / isTrustedDownloadUrl 矩阵 / 四条失败路径（含写入中断）的
 * 中文错误与目录零残留 / 成功路径的字节级一致（内容 + size + 返回路径）。
 */
import { describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  DOWNLOAD_ERRORS,
  assertTrustedDownloadUrl,
  downloadHttpError,
  downloadPluginPackage,
  isTrustedDownloadUrl,
  normalizeSha256,
} from '../../src/main/plugins/download'

const BASE = 'https://example.com/api'
const PAYLOAD = Buffer.from('qbox-fake-payload-'.repeat(64))
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

/** 每次用例一个临时目录（前缀进中央兜底清理，见 tests/unit/setup/tmpTracker.ts） */
async function tmpDestDir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-download-'))
}

const okResponse = (buf: Buffer): Response => new Response(new Uint8Array(buf) as unknown as BodyInit, { status: 200 })

describe('normalizeSha256：校验值形状（64 位十六进制，大小写不敏感）', () => {
  it('合法（含大写）归一为小写；其余一律 DOWNLOAD_BAD_SHA256', () => {
    expect(normalizeSha256('A'.repeat(64))).toBe('a'.repeat(64))
    for (const bad of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), undefined, 42]) {
      expect(() => normalizeSha256(bad as unknown)).toThrow(/DOWNLOAD_BAD_SHA256/)
    }
  })
})

describe('isTrustedDownloadUrl：https 放行 / 同源 http 放行 / 其余拒绝', () => {
  it('https 任意域放行（官方分发可走 CDN）；http 仅与云基址同源放行（自建/内网部署）', () => {
    expect(isTrustedDownloadUrl('https://cdn.example.com/pkg/cloud.qbox', BASE)).toBe(true)
    expect(isTrustedDownloadUrl('https://example.com/api/box/plugin/cloud.qbox', BASE)).toBe(true)
    // 自建/内网：基址本身就是 http → 同源 http 放行；异源 http 不放行（https 恒放行，见上）
    expect(isTrustedDownloadUrl('http://self.example.com/pkg/cloud.qbox', 'http://self.example.com/api')).toBe(true)
    expect(isTrustedDownloadUrl('http://self.example.com/pkg/cloud.qbox', 'http://other.example.com/api')).toBe(false)
    expect(isTrustedDownloadUrl('http://other.example.com/cloud.qbox', BASE)).toBe(false)
    expect(isTrustedDownloadUrl('file:///tmp/evil.qbox', BASE)).toBe(false)
    expect(isTrustedDownloadUrl('data:text/plain,hi', BASE)).toBe(false)
    expect(isTrustedDownloadUrl('not-a-url', BASE)).toBe(false)
    // 没配服务器时，http 一律不可信（没有可比的同源基准）
    expect(isTrustedDownloadUrl('http://example.com/x.qbox', '')).toBe(false)
  })

  it('assertTrustedDownloadUrl 失败时给中文原因并回显地址', () => {
    expect(() => assertTrustedDownloadUrl('file:///tmp/evil.qbox', BASE)).toThrow(
      /DOWNLOAD_URL_UNTRUSTED：插件下载地址不受信任（仅允许 https，或与云服务同源的 http）/,
    )
  })

  it('downloadHttpError：401/403 归登录、404 归「该版本可能尚未上传」、其余稍后重试', () => {
    expect(downloadHttpError(401)).toContain('DOWNLOAD_NOT_LOGGED_IN')
    expect(downloadHttpError(404)).toContain('HTTP 404')
    expect(downloadHttpError(404)).toContain('尚未上传')
    expect(downloadHttpError(500)).toContain('HTTP 500')
  })
})

describe('downloadPluginPackage：登录态 → 地址策略 → 逐字节 sha256 → 落盘', () => {
  it('未登录 → DOWNLOAD_NOT_LOGGED_IN，且**不发起下载**（fetch 零调用、目录零残留）', async () => {
    const destDir = await tmpDestDir()
    const fetchImpl = vi.fn()
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => null, fetchImpl },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: PAYLOAD_SHA, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_NOT_LOGGED_IN：下载官方插件需要登录/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('sha256 形状非法 / 地址不受信任 → 都在联网之前拒绝', async () => {
    const destDir = await tmpDestDir()
    const fetchImpl = vi.fn()
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: 'oops', destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_BAD_SHA256/)
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl },
        { downloadUrl: 'file:///tmp/evil.qbox', sha256: PAYLOAD_SHA, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_URL_UNTRUSTED/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('**核心判据**：sha256 不符 → 拒绝安装（中文原因）+ 已下载的包体删除，目录零残留', async () => {
    const destDir = await tmpDestDir()
    const fetchImpl = vi.fn(async () => okResponse(PAYLOAD))
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: 'b'.repeat(64), destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_HASH_MISMATCH：插件包校验失败——SHA-256 与官方索引不一致，已放弃安装/)
    // 不落盘半包：临时 .qbox 已删（校验失败绝不把包体交给安装管线）
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('成功：带 Bearer 下载、按字节写入临时 .qbox、返回路径与 size，内容逐字节一致', async () => {
    const destDir = await tmpDestDir()
    const fetchImpl = vi.fn(async () => okResponse(PAYLOAD))
    const r = await downloadPluginPackage(
      { baseUrl: BASE, getToken: () => 'jwt-abc', fetchImpl },
      { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: PAYLOAD_SHA.toUpperCase(), destDir },
    )
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc')
    expect(r.size).toBe(PAYLOAD.length)
    expect(r.filePath.startsWith(destDir)).toBe(true)
    expect(r.filePath.endsWith('.qbox')).toBe(true)
    const written = await fsp.readFile(r.filePath)
    expect(Buffer.compare(written, PAYLOAD)).toBe(0)
    expect(createHash('sha256').update(written).digest('hex')).toBe(PAYLOAD_SHA)
  })

  it('HTTP 404（该版本尚未上传）→ 中文原因，目录零残留', async () => {
    const destDir = await tmpDestDir()
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: PAYLOAD_SHA, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_FAILED：插件包不存在（HTTP 404）/)
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('无包体 / 写入中断 → 中文原因且目录零残留（写坏的半包不留）', async () => {
    const destDir = await tmpDestDir()
    const noBody = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl: noBody },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: PAYLOAD_SHA, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_FAILED：插件下载失败——服务端未返回包体/)

    const brokenStream = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error('socket closed')
              },
            }),
          },
        }) as unknown as Response,
    )
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl: brokenStream },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: PAYLOAD_SHA, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_FAILED：插件下载失败（写入中断：socket closed）/)
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('空包体（0 字节）同样拒绝——空文件不该被当成"下载成功"', async () => {
    const destDir = await tmpDestDir()
    const emptySha = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    const fetchImpl = vi.fn(async () => okResponse(Buffer.alloc(0)))
    await expect(
      downloadPluginPackage(
        { baseUrl: BASE, getToken: () => 'jwt', fetchImpl },
        { downloadUrl: 'https://example.com/p/cloud.qbox', sha256: emptySha, destDir },
      ),
    ).rejects.toThrow(/DOWNLOAD_FAILED：插件下载失败（包体为空）/)
    expect(await fsp.readdir(destDir)).toEqual([])
  })

  it('错误码常量齐备（渲染层按 CODE 决定引导路径，漏一个即引导失效）', () => {
    expect(Object.keys(DOWNLOAD_ERRORS).sort()).toEqual([
      'BAD_SHA256',
      'FAILED',
      'HASH_MISMATCH',
      'NOT_LOGGED_IN',
      'NO_BODY',
      'URL_UNTRUSTED',
    ])
  })
})