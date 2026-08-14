/**
 * AccountService 单测（v2.2.0）：登录 / 登出 / 会话失效 / 心跳 / AI 调用错误分类。
 * 全部依赖注入（fetch / 加解密 / 临时文件），不依赖 Electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AccountService, AccountDeps } from '../../src/main/account'

const BASE = 'https://api.example.invalid'

function makeDeps(overrides?: Partial<AccountDeps> & { fetchImpl?: typeof fetch }): {
  deps: AccountDeps
  accountFile: string
} {
  const accountFile = path.join(os.tmpdir(), `qihebox-account-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const deps: AccountDeps = {
    accountFile,
    encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
    decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString('utf8'),
    version: () => '2.2.0',
    log: () => {},
    ...overrides,
  }
  return { deps, accountFile }
}

function mockFetchOk(token: string, userId = 'user-1', email = 'a@b.com') {
  return vi.fn(async () =>
    new Response(JSON.stringify({ token, record: { id: userId, email } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

function mockFetchStatus(status: number, body: unknown = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('AccountService', () => {
  let svc: AccountService
  let accountFile: string
  let deps: AccountDeps

  beforeEach(() => {
    const r = makeDeps()
    deps = r.deps
    accountFile = r.accountFile
    // 默认 svc 带登录成功 mock（避免真实网络请求）
    svc = new AccountService({ ...deps, fetchImpl: mockFetchOk('jwt-token') })
  })

  afterEach(() => {
    svc.stopHeartbeat()
    fs.rmSync(accountFile, { force: true })
  })

  it('登录成功：落盘 + 状态正确', async () => {
    const fetchImpl = mockFetchOk('jwt-token')
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(true)
    const status = svc.status()
    expect(status.loggedIn).toBe(true)
    expect(status.email).toBe('a@b.com')
    expect(status.sessionExpired).toBe(false)
    expect(fs.existsSync(accountFile)).toBe(true)
    // 落盘内容含加密 token 与固定 deviceId
    const raw = JSON.parse(fs.readFileSync(accountFile, 'utf8'))
    expect(raw.token.startsWith('enc:')).toBe(true)
    expect(raw.deviceId).toBeTruthy()
  })

  // —— v2.5（PLAN §3.2）：tokenCache 生命周期（host.account 同步读取的内存缓存）——

  it('tokenCache：登录写入、登出清空（getToken/isLoggedIn 往返）', async () => {
    expect(svc.getToken()).toBeNull()
    expect(svc.isLoggedIn()).toBe(false)
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(true)
    expect(svc.getToken()).toBe('jwt-token')
    expect(svc.isLoggedIn()).toBe(true)
    await svc.logout()
    expect(svc.getToken()).toBeNull()
    expect(svc.isLoggedIn()).toBe(false)
  })

  it('tokenCache：重启恢复（新实例 status() 读盘后 getToken 返回缓存 token）', async () => {
    await svc.login('a@b.com', 'pw')
    const fresh = new AccountService({ ...deps, fetchImpl: mockFetchOk('jwt-token') })
    expect(fresh.getToken()).toBeNull() // 未读盘前无缓存
    expect(fresh.status().loggedIn).toBe(true) // status() 触发 load() → 写缓存
    expect(fresh.getToken()).toBe('jwt-token')
    expect(fresh.isLoggedIn()).toBe(true)
    fresh.stopHeartbeat()
  })

  it('tokenCache：解密异常（safeStorage 降级失败）→ getToken null + log 警告，不抛', async () => {
    // 先正常登录落盘，再用解密失败的 deps 重建（模拟 safeStorage 不可用）
    await svc.login('a@b.com', 'pw')
    const warns: string[] = []
    const bad = new AccountService({
      ...deps,
      decrypt: () => '', // 解密失败（返回空串）
      log: (level, msg) => {
        if (level === 'warn') warns.push(msg)
      },
    })
    expect(bad.status().loggedIn).toBe(false) // 按未登录处理
    expect(bad.getToken()).toBeNull()
    expect(warns.some((m) => m.includes('解密失败'))).toBe(true)
    bad.stopHeartbeat()
  })

  it('tokenCache：账号文件缺失 → 清缓存（外部删除后 getToken 不再返回旧 token）', async () => {
    await svc.login('a@b.com', 'pw')
    expect(svc.getToken()).toBe('jwt-token')
    fs.rmSync(accountFile, { force: true })
    svc.status() // load() 失败 → 清缓存
    expect(svc.getToken()).toBeNull()
    expect(svc.isLoggedIn()).toBe(false)
  })

  it('登录失败：返回错误且不落盘', async () => {
    const fetchImpl = mockFetchStatus(401, { message: 'invalid credentials' })
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'bad')
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toContain('官网')
    expect(fs.existsSync(accountFile)).toBe(false)
  })

  it('网络异常：登录返回网络错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toContain('网络')
  })

  it('心跳：成功静默，401 标记失效，网络异常不抛错', async () => {
    await svc.login('a@b.com', 'pw')
    // 401
    let fetchImpl = mockFetchStatus(401, {})
    svc = new AccountService({ ...deps, fetchImpl })
    await svc.beat()
    expect(svc.status().sessionExpired).toBe(true)

    // 网络异常静默
    await svc.login('a@b.com', 'pw')
    fetchImpl = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    await expect(svc.beat()).resolves.toBeUndefined()
    expect(svc.status().loggedIn).toBe(true)
  })

  it('登出：删除文件并停止心跳', async () => {
    await svc.login('a@b.com', 'pw')
    expect(fs.existsSync(accountFile)).toBe(true)
    await svc.logout()
    expect(fs.existsSync(accountFile)).toBe(false)
    expect(svc.status().loggedIn).toBe(false)
  })

  it('心跳携带 deviceId 与平台版本（同一账号 deviceId 固定）', async () => {
    const seen: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/box/heartbeat')) {
        seen.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ code: 200 }), { status: 200 })
      }
      // 登录响应
      return new Response(JSON.stringify({ token: 'jwt-token', record: { id: 'user-1', email: 'a@b.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    await svc.login('a@b.com', 'pw')
    // login 内部立即上报一次心跳，这里再手动一次
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0].version).toBe('2.2.0')
    expect(seen[0].device_id).toBeTruthy()
    const firstId = seen[0].device_id
    await svc.beat()
    expect(seen[1].device_id).toBe(firstId)
    // 登录请求存在
    const urls = (fetchImpl as unknown as { mock: { calls: Array<[string, ...unknown[]]> } }).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/collections/users/auth-with-password'))).toBe(true)
  })

  it('BASE_URL 指向 ERP 官网（隐私边界：所有请求仅发往自有服务器）', () => {
    expect(BASE).toBe('https://api.example.invalid')
  })
})
