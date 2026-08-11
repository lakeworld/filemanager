import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const execFileP = promisify(execFile)

/**
 * 视频预览 seek 回归（v2.4.7）：qihebox://file/ 协议必须支持 <video> 拖动进度条。
 *
 * 背景（实测定位）：协议 Range 曾按 1MB 截断开放区间 bytes=N- 的 206 响应，
 * Chromium 媒体加载器将其视为「读到流尾」，moov 在文件尾部的大视频只拿到前 1MB
 * 即报 MEDIA_ERR_SRC_NOT_SUPPORTED（点击进度条无效/加载失败）。修复：Range 一律
 * 流式完整返回请求区间。
 *
 * 覆盖形态：
 * - seek-fast.mp4 / seek-tail.mp4：小文件（22KB）moov 头/尾
 * - big-tail.mp4：>1MB 且 moov 在文件尾（多数拍摄/录制视频形态，触发 bytes=N- 流式路径）
 *   ——大视频由 ffmpeg 在 beforeAll 动态生成（GitHub runner 与开发机均自带 ffmpeg），
 *     用完即删，不膨胀仓库；ffmpeg 不可用时自动跳过 big 用例。
 */
test.describe('视频预览 seek', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string
  let ffmpegAvailable = false
  let bigTailSize = 0

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-video-'))
    const r = await page.evaluate((dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(r.success).toBe(true)
    for (const name of ['seek-fast.mp4', 'seek-tail.mp4']) {
      await fsp.copyFile(path.join(ROOT, 'tests/e2e/fixtures', name), path.join(wsDir, name))
    }

    // 大视频：testsrc2 标准滤镜（所有 ffmpeg 版本可用，CI ubuntu 兼容；geq/random 在部分版本不兼容——
    // CI 实测 geq 生成失败），20s 1280x720 高画质保证任何编码器下稳定 >1MB；默认输出 moov 在文件尾
    // 评审 P2：ffmpeg 命令失败 → 环境缺依赖，允许 skip（打印原因便于排查）；产物 ≤1MB → 前提不成立 fail
    let ffmpegFailed = false
    try {
      await execFileP('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=duration=20:size=1280x720:rate=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p',
        path.join(wsDir, 'big-tail.mp4'),
      ], { timeout: 60000 })
      const st = await fsp.stat(path.join(wsDir, 'big-tail.mp4'))
      bigTailSize = st.size
      ffmpegAvailable = st.size > 1024 * 1024 // 必须 >1MB 才能触发流式路径
      if (st.size <= 1024 * 1024) {
        ffmpegFailed = true // 大视频前提不成立——核心回归用例不该静默消失
      }
    } catch (e) {
      // 打印失败原因（CI 上曾因滤镜不兼容静默 skip，加诊断便于定位）
      console.error('[video-seek] ffmpeg 生成大视频失败（用例将 skip）:', e instanceof Error ? e.message : String(e))
      ffmpegAvailable = false
    }
    expect(ffmpegFailed ? `ffmpeg 产物 ${bigTailSize}B ≤1MB，无法覆盖 Range 流式路径（需调整生成参数）` : '').toBe('')
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  const CASES: Array<{ name: string; seekTo: number; expectAt: number }> = [
    { name: 'seek-fast.mp4', seekTo: 1.2, expectAt: 0.9 }, // 2s 小视频
    { name: 'seek-tail.mp4', seekTo: 1.2, expectAt: 0.9 },
    { name: 'big-tail.mp4', seekTo: 1.8, expectAt: 1.5 }, // >1MB + moov 尾部（ffmpeg 生成）
  ]

  for (const { name, seekTo, expectAt } of CASES) {
    test(`${name} 拖动进度条后停留在目标位置`, async () => {
      test.skip(name === 'big-tail.mp4' && !ffmpegAvailable, 'ffmpeg 不可用，跳过 >1MB 大视频用例')
      const urlResult = await page.evaluate(
        (p) => (window as any).qihebox.files.workspaceUrl(p),
        path.join(wsDir, name),
      )
      expect(urlResult.success).toBe(true)

      const t = await page.evaluate(async ({ url, seekTo }) => {
        const v = document.createElement('video')
        v.muted = true
        v.preload = 'auto'
        v.src = url
        await new Promise<void>((res, rej) => {
          v.oncanplay = () => res()
          v.onerror = () => rej(new Error(`video error code=${v.error?.code}`))
          setTimeout(() => rej(new Error('canplay timeout')), 20000)
        })
        const dur = v.duration
        v.currentTime = seekTo
        await new Promise<void>((res, rej) => {
          v.onseeked = () => res()
          v.onerror = () => rej(new Error(`seek error code=${v.error?.code}`))
          setTimeout(() => rej(new Error('seek timeout')), 20000)
        })
        return { t: v.currentTime, dur }
      }, { url: urlResult.data, seekTo })

      expect(t.t).toBeGreaterThan(expectAt)
      expect(Number.isFinite(t.dur)).toBe(true)
    })
  }

  // v2.4.7 打磨补强（评审 P2）：协议 Range 响应断言——206/Content-Range/Content-Length 与 body
  // 一致（闭合/开放区间），越界返回 416。直接抓取网络响应，防止「Range 全被移除/全 200」类回归。
  test('协议 Range 响应：206 头体一致 + 416 越界', async () => {
    test.skip(!ffmpegAvailable, 'ffmpeg 不可用，跳过协议 Range 断言用例')
    const urlResult = await page.evaluate(
      (p) => (window as any).qihebox.files.workspaceUrl(p),
      path.join(wsDir, 'big-tail.mp4'),
    )
    const url = urlResult.data as string
    const size = bigTailSize

    const r = await page.evaluate(async ({ url, size }) => {
      const dec = new TextDecoder()
      const probe = async (range: string) => {
        const resp = await fetch(url, { headers: { Range: range } })
        const buf = new Uint8Array(await resp.arrayBuffer())
        return {
          status: resp.status,
          contentRange: resp.headers.get('content-range'),
          contentLength: resp.headers.get('content-length'),
          bodyLen: buf.byteLength,
          head: dec.decode(buf.slice(0, 8)),
        }
      }
      const open = await probe('bytes=0-') // 开放区间：流式完整返回
      const closed = await probe('bytes=0-999') // 闭合区间：完整返回请求区间
      const suffix = await probe('bytes=-15000') // 后缀区间
      const over = await probe(`bytes=${size}-`) // 越界：416
      return { open, closed, suffix, over, size }
    }, { url, size })

    // 开放区间 bytes=0-：206 且完整返回 0..size-1，Content-Range/Length 与 body 一致
    expect(r.open.status).toBe(206)
    expect(r.open.contentRange).toBe(`bytes 0-${size - 1}/${size}`)
    expect(Number(r.open.contentLength)).toBe(r.open.bodyLen)
    expect(r.open.bodyLen).toBe(size)
    expect(r.open.head.slice(4)).toBe('ftyp') // mp4 首 box 为 ftyp（前 4 字节为 box size，不固定）

    // 闭合区间：206，精确返回 1000 字节
    expect(r.closed.status).toBe(206)
    expect(r.closed.contentRange).toBe(`bytes 0-999/${size}`)
    expect(Number(r.closed.contentLength)).toBe(1000)
    expect(r.closed.bodyLen).toBe(1000)

    // 后缀区间：206，最后 15000 字节
    expect(r.suffix.status).toBe(206)
    expect(r.suffix.contentRange).toBe(`bytes ${size - 15000}-${size - 1}/${size}`)
    expect(r.suffix.bodyLen).toBe(15000)

    // 越界：416 + Content-Range: bytes */size
    expect(r.over.status).toBe(416)
    expect(r.over.contentRange).toBe(`bytes */${size}`)
    expect(r.over.bodyLen).toBe(0)
  })
})
