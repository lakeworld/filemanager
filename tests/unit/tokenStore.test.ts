/**
 * 登录 token 落盘编解码单测（2.6 安全收口批，2026-09-23）。
 *
 * 钉住的契约（缺陷来历：v2.5.5 `39d1e36` 把一条 Linux 实测做成全平台无条件明文降级）：
 *  - safeStorage 可用 → 必须落 `enc:` 密文，且密文里看不到明文（真过一道 safeStorage，不是 base64 冒充）；
 *  - safeStorage 不可用 / 探测抛错 / 加密抛错 → 降级 `raw:` 且**不抛**（Linux 无 keyring 仍能登录，v2.5.5 原意）；
 *  - 迁移：存量 `raw:` 文件照常读出登录态，下一次落盘自动升级成 `enc:`（读侧不回写、不制造启动期写盘竞态）；
 *  - fail-closed：`enc:` 解不开（keyring 消失）或前缀不认识 → 空串 ⇒ 按未登录，绝不抛、不猜明文。
 *
 * 打桩手法沿用本仓既有 safeStorage 夹具（`tests/unit/secret-store.test.ts` 同一条路：
 * `vi.hoisted` + `vi.mock('electron')`），不另起体系。装配层 `src/main/index.ts` import electron 无法
 * node 直测，故接线用源包含断言（同 `plugins-host.test.ts` 的既有口径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { isEncryptionAvailable, encryptString, decryptString } = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}))
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable, encryptString, decryptString },
}))

import { encryptToken, decryptToken } from '../../src/main/tokenStore'
import { AccountService, type AccountDeps } from '../../src/main/account'

/** 假密码本：异或只是「让密文确实不等于明文」的可逆替身——真加密由 Electron safeStorage 负责 */
const XOR = 0x5a
function fakeCipher(input: string | Buffer): Buffer {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XOR
  return out
}

/** 装成「keyring 在位」：encrypt/decrypt 走假密码本且互逆 */
function stubKeyringAvailable(): void {
  isEncryptionAvailable.mockReturnValue(true)
  encryptString.mockImplementation((plain: string) => fakeCipher(plain))
  decryptString.mockImplementation((b: Buffer) => fakeCipher(b).toString('utf8'))
}

/** 装成「没有 keyring」：探测为 false，且已落盘的 enc: 必然解不开（真 safeStorage 就是这个行为） */
function stubKeyringMissing(): void {
  isEncryptionAvailable.mockReturnValue(false)
  decryptString.mockImplementation(() => {
    throw new Error('no keyring: cannot decrypt')
  })
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = 'jwt-token-abc'

describe('tokenStore（2.6 安全收口：能加密就加密，不可用才降级）', () => {
  beforeEach(() => {
    isEncryptionAvailable.mockReset()
    encryptString.mockReset()
    decryptString.mockReset()
  })

  it('safeStorage 可用 → 落 enc: 密文，roundtrip 保真且不泄漏明文', () => {
    stubKeyringAvailable()
    const encoded = encryptToken(TOKEN)
    expect(encoded.startsWith('enc:')).toBe(true)
    expect(encoded).not.toContain(TOKEN)
    // 密文不是「明文 base64」冒充——必须真过 safeStorage 一手
    expect(Buffer.from(encoded.slice(4), 'base64').toString('utf8')).not.toBe(TOKEN)
    expect(encryptString).toHaveBeenCalledWith(TOKEN)
    expect(decryptToken(encoded)).toBe(TOKEN)
  })

  it('safeStorage 不可用（Linux 无 keyring）→ 降级 raw: 且不抛，roundtrip 保真', () => {
    stubKeyringMissing()
    const encoded = encryptToken(TOKEN)
    expect(encoded).toBe('raw:' + TOKEN)
    expect(encryptString).not.toHaveBeenCalled()
    expect(decryptToken(encoded)).toBe(TOKEN)
  })

  it('isEncryptionAvailable() 自己抛错 → 不抛，降级 raw:', () => {
    isEncryptionAvailable.mockImplementation(() => {
      throw new Error('keyring 探测失败')
    })
    expect(encryptToken(TOKEN)).toBe('raw:' + TOKEN)
  })

  it('可用性判真但 encryptString 抛错 → 不抛，降级 raw:（Electron 31 basic_text 实测形态）', () => {
    isEncryptionAvailable.mockReturnValue(true)
    encryptString.mockImplementation(() => {
      throw new Error('encryptString unavailable')
    })
    expect(encryptToken(TOKEN)).toBe('raw:' + TOKEN)
  })

  it('enc: 解不开（keyring 消失）→ 空串按未登录，不抛（fail-closed）', () => {
    stubKeyringAvailable()
    const encoded = encryptToken(TOKEN)
    decryptString.mockImplementation(() => {
      throw new Error('keyring 已换机/丢失')
    })
    expect(decryptToken(encoded)).toBe('')
  })

  it('未知前缀 / 空串 → 空串（不认识就不猜明文）', () => {
    stubKeyringAvailable()
    expect(decryptToken(TOKEN)).toBe('')
    expect(decryptToken('')).toBe('')
    expect(decryptToken('plain:' + TOKEN)).toBe('')
  })

  // —— 迁移口径（v2.5.5 存量明文文件 → 2.6 起自动升级）——

  it('迁移：登录落盘的 raw: 文件，keyring 恢复后照常读出登录态，下次落盘升级为 enc:', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tokenstore-'))
    const accountFile = path.join(dir, 'account.json')
    const fetchOk = vi.fn(async () =>
      new Response(JSON.stringify({ token: TOKEN, record: { id: 'user-1', email: 'a@b.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const baseDeps = (): AccountDeps => ({
      accountFile,
      baseUrl: 'https://api.example.test',
      encrypt: encryptToken,
      decrypt: decryptToken,
      version: () => '2.6.0',
      log: () => {},
      fetchImpl: fetchOk,
    })

    // ① 无 keyring 环境登录 ⇒ 磁盘上是明文 raw:（v2.5.5 的降级形态，也是存量文件的形状）
    stubKeyringMissing()
    const offline = new AccountService(baseDeps())
    expect((await offline.login('a@b.com', 'pw')).ok).toBe(true)
    offline.stopHeartbeat()
    const rawOnDisk = JSON.parse(fs.readFileSync(accountFile, 'utf8')) as { token: string }
    expect(rawOnDisk.token).toBe('raw:' + TOKEN)

    // ② keyring 恢复：旧 raw: 文件必须照常登录（不因升级而把老用户踢下线），且读侧不回写
    stubKeyringAvailable()
    const restored = new AccountService(baseDeps())
    expect(restored.status().loggedIn).toBe(true)
    expect(restored.getToken()).toBe(TOKEN)
    expect((fs.readFileSync(accountFile, 'utf8') as string).includes('raw:' + TOKEN)).toBe(true)
    restored.stopHeartbeat()

    // ③ 下一次落盘（重新登录）自动升级为 enc:，明文从此不落盘
    const relaunch = new AccountService(baseDeps())
    expect((await relaunch.login('a@b.com', 'pw')).ok).toBe(true)
    relaunch.stopHeartbeat()
    const upgraded = JSON.parse(fs.readFileSync(accountFile, 'utf8')) as { token: string }
    expect(upgraded.token.startsWith('enc:')).toBe(true)
    expect(upgraded.token).not.toContain(TOKEN)
    expect(decryptToken(upgraded.token)).toBe(TOKEN)
  })

  it('迁移：升级成 enc: 后遇到 keyring 消失，按未登录而不是崩或退回读明文', async () => {
    stubKeyringAvailable()
    const encoded = encryptToken(TOKEN)
    stubKeyringMissing()
    // 降级只影响「新写入」，已落盘的 enc: 无 keyring 就是读不出来 ⇒ 空串 ⇒ AccountService 判未登录
    expect(decryptToken(encoded)).toBe('')
  })

  it('装配层接线：index.ts 从 tokenStore 注入 encrypt/decrypt，且不残留无条件明文降级', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf-8')
    expect(indexSrc).toContain("import { encryptToken, decryptToken } from './tokenStore'")
    expect(indexSrc).toContain('encrypt: encryptToken')
    expect(indexSrc).toContain('decrypt: decryptToken')
    // 旧缺陷形态：装配层自己内联一份 token 编解码（v2.5.5 就是这么写的），改一处漏一处
    expect(indexSrc).not.toMatch(/function\s+encryptToken\b/)
    expect(indexSrc).not.toMatch(/function\s+decryptToken\b/)
  })
})
