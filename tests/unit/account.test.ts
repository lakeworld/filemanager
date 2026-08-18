/**
 * AccountService 单测（v2.2.0）：登录 / 登出 / 会话失效 / 心跳 / AI 调用错误分类。
 * 全部依赖注入（fetch / 加解密 / 临时文件），不依赖 Electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { AccountService, AccountDeps } from '../../src/main/account'

const BASE = 'https://api.example.test'

function makeDeps(overrides?: Partial<AccountDeps> & { fetchImpl?: typeof fetch }): {
  deps: AccountDeps
  accountFile: string
} {
  const accountFile = path.join(os.tmpdir(), `qihebox-account-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const deps: AccountDeps = {
    accountFile,
    baseUrl: BASE,
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

  it('登录失败：返回服务端 message 透传且不落盘（v2.5.1 登录增强）', async () => {
    const fetchImpl = mockFetchStatus(401, { message: 'invalid credentials' })
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'bad')
    expect(r.ok).toBe(false)
    // D9：401+message → 透传服务端 message（不再笼统引导官网）
    expect((r as { error?: string }).error).toBe('invalid credentials')
    expect(fs.existsSync(accountFile)).toBe(false)
  })

  it('登录失败：400 + message（凭据错误）→ 透传（v2.5.1 登录增强）', async () => {
    const fetchImpl = mockFetchStatus(400, { message: '邮箱或密码错误.' })
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'bad')
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toBe('邮箱或密码错误.')
  })

  it('登录失败：非 JSON 响应体 → 兜底文案（v2.5.1 登录增强）', async () => {
    const fetchImpl = vi.fn(async () => new Response('Internal Server Error', { status: 500 })) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toBe('登录失败，请稍后重试')
  })

  it('登录失败：429 限流 → 固定文案（忽略 body message）（v2.5.1 登录增强）', async () => {
    const fetchImpl = mockFetchStatus(429, { message: 'too many requests' })
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toBe('登录过于频繁，请稍后再试')
  })

  it('登录失败：500 + message → 透传且限长 200 字符（v2.5.1 登录增强）', async () => {
    const fetchImpl = mockFetchStatus(500, { message: 'x'.repeat(300) })
    svc = new AccountService({ ...deps, fetchImpl })
    const r = await svc.login('a@b.com', 'pw')
    expect(r.ok).toBe(false)
    const err = (r as { error?: string }).error ?? ''
    expect(err.length).toBe(200)
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
    // login 内部立即上报一次心跳（单飞：在途时新 beat 跳过）；等它完成后手动再打一次
    await new Promise((r) => setTimeout(r, 10))
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

  it('baseUrl 可配置：登录请求发往注入的服务器地址（公开仓不写死真实地址）', async () => {
    const fetchImpl = mockFetchOk('jwt-token')
    svc = new AccountService({ ...deps, fetchImpl })
    await svc.login('a@b.com', 'pw')
    const urls = (fetchImpl as unknown as { mock: { calls: Array<[string, ...unknown[]]> } }).mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.startsWith(BASE) && u.includes('/collections/users/auth-with-password'))).toBe(true)
    expect(BASE).not.toContain('qihebook.cloud')
  })

  // —— v2.5.3 T4：登录/心跳稳定性 ——

  it('登录超时：fetch 挂起时按 loginTimeoutMs 返回超时文案且不留部分状态（T4）', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl, loginTimeoutMs: 50 })
    const started = Date.now()
    const r = await svc.login('a@b.com', 'pw')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toBe('登录超时，请检查网络后重试')
    expect(fs.existsSync(accountFile)).toBe(false)
    expect(svc.getToken()).toBeNull()
    expect(svc.isLoggedIn()).toBe(false)
  })

  it('心跳单飞：在途时新 tick 直接跳过，不并发重复上报（T4）', async () => {
    // 预置已登录账号文件（绕过 login 附带的首拍心跳）
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    let resolveBeat!: (value: Response) => void
    let beatCalls = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/box/heartbeat')) {
        beatCalls += 1
        return await new Promise<Response>((resolve) => { resolveBeat = resolve })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    svc.status() // 读盘 + 缓存
    const first = svc.beat()
    const second = svc.beat() // 在途 → 应跳过
    await new Promise((r) => setTimeout(r, 10))
    expect(beatCalls).toBe(1)
    resolveBeat(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    await first
    await second
    expect(beatCalls).toBe(1) // 单飞：全程仅一次上报
  })

  it('旧会话迟到心跳不得覆盖新会话（sessionGen 隔离）', async () => {
    let slowBeatResolve!: (value: Response) => void
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/box/heartbeat')) {
        return await new Promise<Response>((resolve) => { slowBeatResolve = resolve })
      }
      // 登录响应
      return new Response(JSON.stringify({ token: 'jwt-token', record: { id: 'user-1', email: 'a@b.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl, heartbeatTimeoutMs: 5000 })
    await svc.login('a@b.com', 'pw') // gen1：首拍心跳挂起（deferred）

    await svc.login('a@b.com', 'pw') // gen2：新会话，heartbeat 在途 → 首拍跳过
    expect(svc.getToken()).toBe('jwt-token')

    // 放行旧会话（gen1）心跳，并以 401 响应——不得标记 sessionExpired
    slowBeatResolve(new Response(JSON.stringify({ message: 'expired' }), { status: 401 }))
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.status().sessionExpired).toBe(false)
  })

  it('落盘失败：登录返回失败且不写缓存、不启动心跳（T4）', async () => {
    // accountFile 父路径是文件 → mkdir -p 失败 → 原子写失败
    const blocker = path.join(os.tmpdir(), `qihebox-account-blocker-${Date.now()}.tmp`)
    fs.writeFileSync(blocker, 'x')
    try {
      const badFile = path.join(blocker, 'account.json')
      const fetchImpl = mockFetchOk('jwt-token')
      svc = new AccountService({ ...deps, accountFile: badFile, fetchImpl })
      const r = await svc.login('a@b.com', 'pw')
      expect(r.ok).toBe(false)
      expect((r as { error?: string }).error).toContain('保存')
      expect(svc.getToken()).toBeNull()
      expect(svc.isLoggedIn()).toBe(false)
      expect(svc.status().loggedIn).toBe(false)
    } finally {
      fs.rmSync(blocker, { force: true })
    }
  })

  it('登出：中止在途心跳并原子移除文件；移除失败不阻塞内存登出（T4）', async () => {
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    let resolveBeat!: (value: Response) => void
    let beatSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      // C1a：mock 记录 signal 对象——登出后必须能断言其已被 abort
      beatSignal = init?.signal
      return await new Promise<Response>((resolve) => { resolveBeat = resolve })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl })
    svc.status()
    const pending = svc.beat() // 在途心跳（挂起）
    await new Promise((r) => setTimeout(r, 5))

    await svc.logout() // 应中止在途心跳
    expect(fs.existsSync(accountFile)).toBe(false)
    expect(svc.getToken()).toBeNull()
    expect(svc.isLoggedIn()).toBe(false)
    // C1a：logout 必须 abort 在途心跳（此前 mock 忽略 signal，该行为零断言）
    expect(beatSignal?.aborted).toBe(true)

    // 释放挂起响应，避免悬挂（mock 忽略 abort，需手动放行；真实 fetch 会以 AbortError 拒绝）
    resolveBeat(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    await pending
  })

  it('登出：移除文件失败时错误被记录且内存登出仍完成（T4，A1 修复）', async () => {
    // 直接持有 deps 引用：测试中途改 accountFile 指向删除必失败的目标、并接管日志收集
    const r = makeDeps()
    const logs: string[] = []
    r.deps.log = (level, msg) => logs.push(msg)
    r.deps.fetchImpl = mockFetchOk('jwt-token')
    svc = new AccountService(r.deps)
    accountFile = r.accountFile
    await svc.login('a@b.com', 'pw')
    expect(svc.isLoggedIn()).toBe(true)

    // 让 fsp.rm 失败：accountFile 指向一个非空目录（rm force 只吞 ENOENT，不吞 EISDIR/ENOTEMPTY）
    const dirBlocker = path.join(os.tmpdir(), `qihebox-account-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(dirBlocker)
    fs.writeFileSync(path.join(dirBlocker, 'keep.txt'), 'x')
    try {
      r.deps.accountFile = dirBlocker
      await svc.logout()
      // 内存登出不受移除失败影响
      expect(svc.getToken()).toBeNull()
      expect(svc.isLoggedIn()).toBe(false)
      expect(svc.status().loggedIn).toBe(false)
      // 错误被记录——A1 修复（remove() 不再吞错）后外层 catch 才可达
      expect(logs.some((m) => m.includes('移除账号文件失败'))).toBe(true)
    } finally {
      fs.rmSync(dirBlocker, { recursive: true, force: true })
    }
  })

  it('心跳超时：fetch 挂起时按 heartbeatTimeoutMs 超时，超时后单飞复位可再次 beat（T4）', async () => {
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    let beatCalls = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/box/heartbeat')) {
        beatCalls += 1
        return await new Promise<Response>(() => {}) // 挂起（模拟卡死网络），仅靠超时兜底
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl, heartbeatTimeoutMs: 50 })
    svc.status() // 读盘 + 缓存
    const started = Date.now()
    await svc.beat()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(beatCalls).toBe(1)
    // 超时后 beatInFlight 必须在 finally 复位：再次 beat 应发出新请求（而非被单飞跳过）
    const second = Date.now()
    await svc.beat()
    expect(Date.now() - second).toBeLessThan(2000)
    expect(beatCalls).toBe(2)
  })

  // —— v2.5.3 P1-6：心跳 401 会话过期 → 事件广播（onSessionExpired 回调） ——

  it('心跳 401：首次置位 sessionExpired 并触发 onSessionExpired 广播（P1-6）', async () => {
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    const onSessionExpired = vi.fn()
    svc = new AccountService({ ...deps, fetchImpl: mockFetchStatus(401, {}), onSessionExpired })
    svc.status() // 读盘 + 缓存
    await svc.beat()
    expect(svc.status().sessionExpired).toBe(true)
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
    // 广播携带当前完整登录态（照 status() 形状，渲染层可直接 setAccountStatus）
    expect(onSessionExpired.mock.calls[0][0]).toMatchObject({
      loggedIn: true,
      email: 'a@b.com',
      sessionExpired: true,
    })
  })

  it('心跳非 401（服务端错误）：sessionExpired 不置位、不广播（P1-6）', async () => {
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    const onSessionExpired = vi.fn()
    svc = new AccountService({ ...deps, fetchImpl: mockFetchStatus(500, {}), onSessionExpired })
    svc.status()
    await svc.beat()
    expect(svc.status().sessionExpired).toBe(false)
    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('心跳 401 重复：已过期态不重复广播（过渡保护，P1-6）', async () => {
    fs.writeFileSync(
      accountFile,
      JSON.stringify({ token: `enc:${Buffer.from('jwt-token').toString('base64')}`, userId: 'user-1', email: 'a@b.com', deviceId: 'dev-1' }),
    )
    const onSessionExpired = vi.fn()
    svc = new AccountService({ ...deps, fetchImpl: mockFetchStatus(401, {}), onSessionExpired })
    svc.status()
    await svc.beat()
    await svc.beat() // 第二次 401：已过期 → 不再广播
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
    expect(svc.status().sessionExpired).toBe(true)
  })

  it('重新登录后再次 401：过期态复位后广播恢复生效（P1-6）', async () => {
    const onSessionExpired = vi.fn()
    // 登录接口 200 + token，心跳接口 401（同一 fetchImpl 按 URL 分流）
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/box/heartbeat')) {
        return new Response(JSON.stringify({}), { status: 401 })
      }
      return new Response(JSON.stringify({ token: 'jwt-token', record: { id: 'user-1', email: 'a@b.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    svc = new AccountService({ ...deps, fetchImpl, onSessionExpired })
    await svc.login('a@b.com', 'pw')
    await new Promise((r) => setTimeout(r, 10)) // 等 login 内首拍心跳（401）落地
    expect(svc.status().sessionExpired).toBe(true)
    expect(onSessionExpired).toHaveBeenCalledTimes(1)

    // 重新登录（同一服务实例）：过期态复位
    await svc.login('a@b.com', 'pw')
    expect(svc.status().sessionExpired).toBe(false)
    await new Promise((r) => setTimeout(r, 10)) // 等新会话首拍心跳（401）→ 广播恢复生效
    expect(svc.status().sessionExpired).toBe(true)
    expect(onSessionExpired).toHaveBeenCalledTimes(2)
  })
})
