/**
 * 应用内更新（v2.6 批 4）：形态判据 + 完整性校验 + 下载/安装编排的单测。
 *
 * 与 `updater.test.ts`（checkUpdate 网络/解析/超时）分工：本文件只测「发现新版之后」那半条链。
 * 真实引擎（electron-updater）住 `src/main/updaterMain.ts`（只有它 import electron），
 * 本文件一律注入替身——单测环境既没有 electron 也没有更新面；真链证据归发布验收
 * （PLAN-2026-09-23 批 4 §四：2.5.x 装机 → 应用内检查 → 下载 → 校验 → 退出安装）。
 *
 * 门下三件事（每条都对应卡上一条验收）：
 *   ① 形态判据 deb / AppImage / NSIS 三分，deb 抛**可判别**的「不支持」（D-UP1 走直链分支）；
 *   ② 完整性校验不匹配 → 拒绝 + 删残包（半截/被改过的包不许交给安装器）；
 *   ③ 下载与安装的账目：没下载过不许安装、安装后清账（防双装）。
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  UPDATE_FEED_URL,
  UPDATE_UNSUPPORTED_CODE,
  UpdateChecksumMismatchError,
  UpdateUnsupportedError,
  canInstallInApp,
  parseExpectedDigest,
  replaceAppImage,
  resolveUpdateChannel,
  verifyDownloadedFile,
} from '../../src/main/core/updatePlan'
import type {
  DownloadedUpdate,
  UpdateChannel,
  UpdateEngine,
  UpdateProgress,
} from '../../src/main/core/updatePlan'
import { applyUpdate, downloadUpdate, updateCapability } from '../../src/main/updater'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const INFO = {
  version: '2.6.0',
  download_url: 'https://www.qihebook.cloud/file-manager',
  checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  release_notes: '测试用',
}

const sha256Hex = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex')
const sha512B64 = (buf: Buffer | string): string =>
  crypto.createHash('sha512').update(buf).digest('base64')

/** 造一个「已下载的更新包」临时文件（tmpTracker 兜底清理，无需自删） */
async function artifact(content = 'fake-installer-bytes'): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-upd-'))
  const file = path.join(dir, 'setup.bin')
  await fsp.writeFile(file, content)
  return file
}

interface FakeEngine extends UpdateEngine {
  download: ReturnType<
    typeof vi.fn<(onProgress: (progress: UpdateProgress) => void) => Promise<DownloadedUpdate>>
  >
  install: ReturnType<typeof vi.fn<(file: string) => void>>
}

/** 引擎替身：download 回报一条进度后返回「已落盘的文件 + 更新面申报的 sha512」 */
function fakeEngine(
  file: string,
  sha512: string,
  channel: UpdateChannel = 'appimage',
  version = INFO.version,
): FakeEngine {
  const download = vi.fn(
    async (onProgress: (progress: UpdateProgress) => void): Promise<DownloadedUpdate> => {
      onProgress({ phase: 'downloading', percent: 50, transferred: 5, total: 10, bytesPerSecond: 1 })
      return { file, sha512, version }
    },
  )
  const install = vi.fn((_file: string): void => undefined)
  return { channel, download, install }
}

// ── 跨项目接触点：feed URL 逐字符一致（erp 脚本 PUBLIC_UPDATES_URL / nginx location）──

describe('更新面地址（跨项目接触点）', () => {
  it('运行时 feed 常量 = 服务端匿名更新面（erp nginx location ^~ /updates/box/）', () => {
    // 逐字符钉死：改这里必须同时改 erp scripts/publish-box-installer.sh 的 PUBLIC_UPDATES_URL
    // 与 deploy/snippets/box-download-locations.conf，否则客户端取不到 feed（静默 404）
    expect(UPDATE_FEED_URL).toBe('https://www.qihebook.cloud/updates/box/')
  })

  it('electron-builder.yml 的 publish generic URL 与运行时常量同源（禁双源漂移）', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain(`url: ${UPDATE_FEED_URL}`)
    // provider 必须是 generic（feed 是扁平静态目录，非 GitHub/S3）
    expect(yml.slice(yml.indexOf('publish:'))).toContain('provider: generic')
  })
})

// ── 形态判据（D-UP1：deb 不自更新，走「提示 + 直链」）──

describe('更新形态判据（resolveUpdateChannel）', () => {
  it('Windows → nsis（完整自更新）', () => {
    expect(
      resolveUpdateChannel({ platform: 'win32', env: {}, isPackaged: true, packageType: null }),
    ).toBe('nsis')
  })

  it('AppImage（env.APPIMAGE 在位）→ appimage（判据与 electron-updater 同一把尺子）', () => {
    expect(
      resolveUpdateChannel({
        platform: 'linux',
        env: { APPIMAGE: '/home/u/启禾文件管理-2.5.9.AppImage' },
        isPackaged: true,
        packageType: null,
      }),
    ).toBe('appimage')
  })

  it('deb 包（electron-builder 写的 resources/package-type=deb）→ deb', () => {
    expect(
      resolveUpdateChannel({ platform: 'linux', env: {}, isPackaged: true, packageType: 'deb' }),
    ).toBe('deb')
  })

  it('已打包的 Linux 非 AppImage（读不到 package-type 时）→ deb 兜底', () => {
    // 本仓 Linux 只出 AppImage + deb 两个 target ⇒ 无 APPIMAGE 的安装版就是 deb
    expect(
      resolveUpdateChannel({ platform: 'linux', env: {}, isPackaged: true, packageType: null }),
    ).toBe('deb')
  })

  it('未打包实例（开发/预览）→ unsupported：不谎报成 deb，也不尝试自更新', () => {
    expect(
      resolveUpdateChannel({ platform: 'linux', env: {}, isPackaged: false, packageType: null }),
    ).toBe('unsupported')
    expect(
      resolveUpdateChannel({ platform: 'linux', env: {}, isPackaged: false, packageType: undefined }),
    ).toBe('unsupported')
  })

  it('非目标平台与本仓不发包的包型 → unsupported', () => {
    expect(
      resolveUpdateChannel({ platform: 'darwin', env: {}, isPackaged: true, packageType: null }),
    ).toBe('unsupported')
    // rpm / pacman：本仓不出这种包（electron-updater 有 DebUpdater，但更新面没有这些产物）
    expect(
      resolveUpdateChannel({ platform: 'linux', env: {}, isPackaged: true, packageType: 'rpm' }),
    ).toBe('unsupported')
  })

  it('canInstallInApp：只有 nsis / appimage 有「退出并安装」按钮', () => {
    const yes: UpdateChannel[] = ['nsis', 'appimage']
    const no: UpdateChannel[] = ['deb', 'unsupported']
    expect(yes.every(canInstallInApp)).toBe(true)
    expect(no.some(canInstallInApp)).toBe(false)
  })

  it('updateCapability（IPC 面）：把形态与「能不能装」一并给渲染层', async () => {
    for (const [channel, can] of [
      ['nsis', true],
      ['appimage', true],
      ['deb', false],
      ['unsupported', false],
    ] as Array<[UpdateChannel, boolean]>) {
      const cap = await updateCapability({ engine: fakeEngine('/nope', 'x', channel) })
      expect(cap).toEqual({ channel, canInstallInApp: can })
    }
  })
})

// ── 完整性校验（半截 / 被改过的包不许交给安装器）──

describe('更新包完整性校验（verifyDownloadedFile）', () => {
  it('期望值形态解析：sha256 hex / 带前缀 / sha512 base64 四种写法都认', () => {
    const hex = 'a'.repeat(64)
    expect(parseExpectedDigest(`sha256:${hex}`)).toEqual({ algo: 'sha256', value: hex })
    expect(parseExpectedDigest(hex)).toEqual({ algo: 'sha256', value: hex })
    const b64 = `${'A'.repeat(86)}==`
    expect(parseExpectedDigest(`sha512-${b64}`)).toEqual({ algo: 'sha512', value: b64 })
    expect(parseExpectedDigest(b64)).toEqual({ algo: 'sha512', value: b64 })
    // 认不出来的一律 null（不许「解析失败就当通过」）
    expect(parseExpectedDigest('')).toBeNull()
    expect(parseExpectedDigest('   ')).toBeNull()
    expect(parseExpectedDigest('sha256:not-a-hash')).toBeNull()
  })

  it('sha256 命中 → 静默通过（文件保留）', async () => {
    const file = await artifact('hello-update')
    await expect(
      verifyDownloadedFile(file, `sha256:${sha256Hex('hello-update')}`),
    ).resolves.toBeUndefined()
    expect(fs.existsSync(file)).toBe(true)
    await expect(verifyDownloadedFile(file, sha256Hex('hello-update'))).resolves.toBeUndefined()
  })

  it('sha512(base64) 命中 → 通过（更新面 latest*.yml 的申报口径）', async () => {
    const file = await artifact('hello-update')
    await expect(verifyDownloadedFile(file, sha512B64('hello-update'))).resolves.toBeUndefined()
    await expect(
      verifyDownloadedFile(file, `sha512-${sha512B64('hello-update')}`),
    ).resolves.toBeUndefined()
  })

  it('不匹配 → 抛可判别的错误**并删掉残包**（不留半截包等着被装）', async () => {
    const file = await artifact('hello-update')
    const wrong = sha256Hex('something-else')
    const err = await verifyDownloadedFile(file, wrong).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpdateChecksumMismatchError)
    expect((err as UpdateChecksumMismatchError).code).toBe('update-checksum-mismatch')
    expect((err as UpdateChecksumMismatchError).expected).toBe(wrong)
    expect((err as UpdateChecksumMismatchError).actual).toBe(sha256Hex('hello-update'))
    expect(fs.existsSync(file)).toBe(false)
  })

  it('文件不存在 / 期望值不可解析 → 如实报错（不静默放行）', async () => {
    const missing = path.join(os.tmpdir(), 'qihebox-upd-not-exist.bin')
    await expect(verifyDownloadedFile(missing, sha256Hex('x'))).rejects.toThrow('更新包读不到')
    const file = await artifact()
    await expect(verifyDownloadedFile(file, 'sha256:zzz')).rejects.toThrow('校验值不可解析')
    expect(fs.existsSync(file)).toBe(true) // 校验值本身没给对 → 不背删包的锅
  })
})

// ── 下载编排（deb 不下载、进度转发、校验失败不留账）──

describe('下载更新（downloadUpdate）', () => {
  it('deb / unsupported 形态 → 抛「不支持」且一次都不碰引擎（D-UP1 直链分支的判据）', async () => {
    for (const channel of ['deb', 'unsupported'] as UpdateChannel[]) {
      const engine = fakeEngine('/nope', 'x', channel)
      const err = await downloadUpdate(INFO, { engine }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UpdateUnsupportedError)
      expect((err as UpdateUnsupportedError).code).toBe(UPDATE_UNSUPPORTED_CODE)
      expect((err as UpdateUnsupportedError).channel).toBe(channel)
      expect(engine.download).not.toHaveBeenCalled()
      expect(engine.install).not.toHaveBeenCalled()
    }
  })

  it('nsis / appimage：下载 → 校验 → 返回落盘路径，进度逐条转发给渲染层', async () => {
    for (const channel of ['nsis', 'appimage'] as UpdateChannel[]) {
      const file = await artifact()
      const engine = fakeEngine(file, sha512B64('fake-installer-bytes'), channel)
      const seen: UpdateProgress[] = []
      const got = await downloadUpdate(INFO, { engine, onProgress: (p) => seen.push(p) })
      expect(got).toBe(file)
      expect(engine.download).toHaveBeenCalledTimes(1)
      expect(seen[0]).toEqual({
        phase: 'downloading',
        percent: 50,
        transferred: 5,
        total: 10,
        bytesPerSecond: 1,
      })
      // 哈希那一段也要给渲染层一个「在校验」的回声（人话：不是卡住了）
      expect(seen.some((p) => p.phase === 'verifying')).toBe(true)
    }
  })

  it('校验不匹配 → 抛错 + 残包已删 + 不留下「可安装」的账（再点安装会要求重新下载）', async () => {
    vi.resetModules() // 干净模块状态：本条要断言「账上确实什么都没留下」
    const fresh = await import('../../src/main/updater')
    const file = await artifact('half-downloaded')
    const engine = fakeEngine(file, sha512B64('完整包的哈希'))
    const err = await fresh.downloadUpdate(INFO, { engine }).catch((e: unknown) => e)
    // 跨模块实例（vi.resetModules 之后的那份）不认 instanceof，按 name/code 判判别性
    expect((err as { name?: string }).name).toBe('UpdateChecksumMismatchError')
    expect((err as { code?: string }).code).toBe('update-checksum-mismatch')
    expect(String(err)).toContain('更新包校验不通过')
    expect(fs.existsSync(file)).toBe(false)
    // 账上没有可安装的包：applyUpdate 必须先要求重新下载，而不是拿着残包去装
    const applyErr = await fresh.applyUpdate({ engine }).catch((e: unknown) => e)
    expect(String(applyErr)).toContain('请先下载')
    expect(engine.install).not.toHaveBeenCalled()
  })

  it('引擎返回的路径不存在（下载被半路清掉）→ 同样拒绝，不留可安装的账', async () => {
    vi.resetModules()
    const fresh = await import('../../src/main/updater')
    const engine = fakeEngine(path.join(os.tmpdir(), 'qihebox-upd-gone', 'setup.bin'), sha512B64('x'))
    const err = await fresh.downloadUpdate(INFO, { engine }).catch((e: unknown) => e)
    expect(String(err)).toContain('更新包读不到')
    await expect(fresh.applyUpdate({ engine })).rejects.toThrow('请先下载')
  })
})

// ── AppImage 落盘动作（原地同名覆盖：路径不变 = 自启项/快捷方式不悬空）──

describe('AppImage 原地替换（replaceAppImage）', () => {
  it('原地同名覆盖 + 给可执行位；暂存文件不残留', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-appimage-'))
    const target = path.join(dir, '启禾文件管理-2.5.9.AppImage')
    const from = path.join(dir, 'downloaded-new.bin')
    await fsp.writeFile(target, 'OLD-BYTE')
    await fsp.writeFile(from, 'NEW-BYTE')
    replaceAppImage(from, target)
    expect(await fsp.readFile(target, 'utf8')).toBe('NEW-BYTE')
    expect(fs.statSync(target).mode & 0o100).toBeTruthy() // 所有者可执行位（双击/自启能起来）
    expect(fs.existsSync(`${target}.qihe-new`)).toBe(false)
  })

  it('替换失败（目录不可写）→ 如实抛错，且**原文件保持可用**（不砖）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-appimage-ro-'))
    const target = path.join(dir, 'app.AppImage')
    const from = path.join(dir, 'new.bin')
    await fsp.writeFile(target, 'OLD-BYTE')
    await fsp.writeFile(from, 'NEW-BYTE')
    fs.chmodSync(dir, 0o500) // 目录只读：写暂存文件必失败
    try {
      expect(() => replaceAppImage(from, target)).toThrow('替换 AppImage 失败')
      expect(await fsp.readFile(target, 'utf8')).toBe('OLD-BYTE')
    } finally {
      fs.chmodSync(dir, 0o700) // 还原，交 tmpTracker 清理
    }
  })

  it('更新包不存在 → 报「更新包不存在」（不静默当成功）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-appimage-miss-'))
    const target = path.join(dir, 'app.AppImage')
    await fsp.writeFile(target, 'OLD-BYTE')
    expect(() => replaceAppImage(path.join(dir, 'nope.bin'), target)).toThrow('更新包不存在')
    expect(await fsp.readFile(target, 'utf8')).toBe('OLD-BYTE')
  })
})

// ── 安装编排（账目：没下载不许装；装完清账）──

describe('退出并安装（applyUpdate）', () => {
  it('从没下载过 → 如实报错且不碰引擎（零安装）', async () => {
    vi.resetModules() // 拿一份干净的模块状态（pending 为空）
    const fresh = await import('../../src/main/updater')
    const engine = fakeEngine('/nope', 'x')
    await expect(fresh.applyUpdate({ engine })).rejects.toThrow('请先下载')
    expect(engine.install).not.toHaveBeenCalled()
  })

  it('下载成功后 apply → 交引擎安装一次；再 apply 同一次不重复装', async () => {
    const file = await artifact()
    const engine = fakeEngine(file, sha512B64('fake-installer-bytes'))
    await downloadUpdate(INFO, { engine })
    await applyUpdate({ engine })
    expect(engine.install).toHaveBeenCalledTimes(1)
    // 安装已交出去（进程即将退出）⇒ 账清掉，第二次点击不许再装一遍
    await expect(applyUpdate({ engine })).rejects.toThrow('请先下载')
    expect(engine.install).toHaveBeenCalledTimes(1)
  })

  it('安装动作失败（如 AppImage 本体在只读目录）→ 账仍在，可原地重试而不必重下', async () => {
    const file = await artifact()
    const engine = fakeEngine(file, sha512B64('fake-installer-bytes'))
    engine.install.mockImplementationOnce(() => {
      throw new Error('替换 AppImage 失败：目录不可写')
    })
    await downloadUpdate(INFO, { engine })
    await expect(applyUpdate({ engine })).rejects.toThrow('替换 AppImage 失败')
    // 包还在账上：第二次点「退出并安装」直接把同一个已校验的包再交一次
    await applyUpdate({ engine })
    expect(engine.install).toHaveBeenCalledTimes(2)
  })

  it('已下载的包被外部清掉（缓存清理）→ 报「更新包已不存在」并要求重新下载', async () => {
    const file = await artifact()
    const engine = fakeEngine(file, sha512B64('fake-installer-bytes'), 'nsis')
    await downloadUpdate(INFO, { engine })
    await fsp.rm(file, { force: true })
    await expect(applyUpdate({ engine })).rejects.toThrow('更新包已不存在')
    expect(engine.install).not.toHaveBeenCalled()
    // 清账后再装仍是「要求重新下载」，不是永久报错的死状态
    await expect(applyUpdate({ engine })).rejects.toThrow('请先下载')
  })

  it('deb 形态即便账上有包也拒绝安装（形态判据在安装口同样生效）', async () => {
    const file = await artifact()
    const engine = fakeEngine(file, sha512B64('fake-installer-bytes'))
    await downloadUpdate(INFO, { engine })
    const debErr = await applyUpdate({ engine: fakeEngine(file, sha512B64('x'), 'deb') }).catch(
      (e: unknown) => e,
    )
    expect(debErr).toBeInstanceOf(UpdateUnsupportedError)
    expect(engine.install).not.toHaveBeenCalled()
  })
})