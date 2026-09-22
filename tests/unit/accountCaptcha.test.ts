/**
 * v2.5.9 A8（登录图形码 · 客户端先行）主进程侧单测。
 *
 * 全部依赖注入（fetch / 加解密 / 临时文件），不依赖 Electron——沿用 `account.test.ts` 的口径。
 * 这里钉的是**契约**：请求打去哪个路径、带哪两个头、注册重试用什么 username、失败文案从哪来。
 * 服务端真实行为不在本文件职责内（本版不切服务端，见内部设计文档 §一 A8）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountService, type AccountDeps } from '../../src/main/account'

const BASE = 'https://api.example.test/api'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function makeService(responder: (call: Call) => { status: number; json: unknown }): {
  svc: AccountService
  calls: Call[]
  accountFile: string
} {
  const accountFile = path.join(os.tmpdir(), `qihebox-a8-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const r = responder(call)
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  const deps: AccountDeps = {
    accountFile,
    baseUrl: BASE,
    encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
    decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString('utf8'),
    version: () => '2.5.9',
    log: () => {},
    fetchImpl,
  }
  return { svc: new AccountService(deps), calls, accountFile }
}

const captchaOk = (): { status: number; json: unknown } => ({
  status: 200,
  json: { code: 200, captcha_id: 'cap-77', image: 'data:image/png;base64,AAAA' },
})

describe('fetchCaptcha（A8 出图）', () => {
  it('打 GET {base}/captcha（不带 query = 登录桶），回 captchaId + data URL', async () => {
    const { svc, calls } = makeService(captchaOk)
    const r = await svc.fetchCaptcha()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r).toMatchObject({ captchaId: 'cap-77', image: 'data:image/png;base64,AAAA' })
    expect(calls[0].url).toBe(`${BASE}/captcha`)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers['X-Qihe-Client']).toBe('box')
  })

  it('反向实验：响应缺 image ⇒ 判失败并给人话（不能回一张空图让 UI 亮着）', async () => {
    const { svc } = makeService(() => ({ status: 200, json: { captcha_id: 'x' } }))
    const r = await svc.fetchCaptcha()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('验证码')
  })

  it('反向实验：500 ⇒ 中文兜底，不把 HTTP 状态码甩给用户', async () => {
    const { svc } = makeService(() => ({ status: 500, json: {} }))
    const r = await svc.fetchCaptcha()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('点击图片重试')
  })

  it('未配置服务器地址 ⇒ 明确说不可用（公开 CI 占位包就是这形态）', async () => {
    const bare = new AccountService({
      accountFile: path.join(os.tmpdir(), 'qihebox-a8-nobase.json'),
      baseUrl: '',
      encrypt: (x) => x,
      decrypt: (x) => x,
      version: () => '2.5.9',
      log: () => {},
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    })
    const r = await bare.fetchCaptcha()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('未配置服务器地址')
  })
})

describe('login 带码（A8 只做加法，不动既有语义）', () => {
  const loginResponder = (call: Call) =>
    call.url.endsWith('/auth-with-password') ? { status: 200, json: { token: 't', record: { id: 'u1', email: 'a@b.com' } } } : captchaOk()

  it('填了码 ⇒ 带 X-Captcha-Id / X-Captcha-Value，且 X-Qihe-Client: box 仍在', async () => {
    const { svc, calls } = makeService(loginResponder)
    const r = await svc.login('a@b.com', 'pw12345678', { id: 'cap-1', value: '9k2m' })
    expect(r.ok).toBe(true)
    const h = calls[0].headers
    expect(h['X-Captcha-Id']).toBe('cap-1')
    expect(h['X-Captcha-Value']).toBe('9k2m')
    expect(h['X-Qihe-Client']).toBe('box')
  })

  it('没填码 ⇒ 两个头都不出现（本版服务端仍豁免 box，空值头反而更容易被判失败）', async () => {
    const { svc, calls } = makeService(loginResponder)
    await svc.login('a@b.com', 'pw12345678')
    expect(calls[0].headers['X-Captcha-Id']).toBeUndefined()
    expect(calls[0].headers['X-Captcha-Value']).toBeUndefined()
  })

  it('反向实验：只填一半（有 id 无值）⇒ 同样不发头，不发半套', async () => {
    const { svc, calls } = makeService(loginResponder)
    await svc.login('a@b.com', 'pw12345678', { id: 'cap-1', value: '  ' })
    expect(calls[0].headers['X-Captcha-Id']).toBeUndefined()
  })
})

describe('register + 邮箱认证（A8 注册链）', () => {
  it('注册打 POST {base}/collections/users/records，username = 邮箱前缀、passwordConfirm 同值', async () => {
    const { svc, calls } = makeService(() => ({ status: 200, json: { id: 'u9' } }))
    const r = await svc.register('Zhang.San@example.com', 'pw12345678')
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe(`${BASE}/collections/users/records`)
    expect(calls[0].body).toMatchObject({
      email: 'Zhang.San@example.com',
      username: 'Zhang.San',
      passwordConfirm: 'pw12345678',
    })
  })

  it('用户名冲突 ⇒ 自动加随机后缀重试一次（用户只填了邮箱，不该为看不见的字段被打回）', async () => {
    let n = 0
    const { svc, calls } = makeService(() => {
      n += 1
      return n === 1
        ? { status: 400, json: { code: 400, message: 'username with value "zhang" already exists' } }
        : { status: 200, json: { id: 'u9' } }
    })
    const r = await svc.register('zhang@example.com', 'pw12345678')
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(2)
    const first = (calls[0].body as { username: string }).username
    const second = (calls[1].body as { username: string }).username
    expect(second).not.toBe(first)
    expect(second.startsWith(first)).toBe(true)
  })

  it('反向实验：非冲突类失败（邮箱已注册）⇒ 只发一次、文案中文化', async () => {
    const { svc, calls } = makeService(() => ({ status: 400, json: { code: 400, message: '验证失败，邮箱已注册。' } }))
    const r = await svc.register('dup@example.com', 'pw12345678')
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(1)
    if (!r.ok) expect(r.error).toContain('该邮箱已注册')
  })

  it('本地先挡明显错：邮箱形状 / 密码不足 8 位 ⇒ 一次请求都不发', async () => {
    const { svc, calls } = makeService(() => ({ status: 200, json: {} }))
    expect((await svc.register('not-an-email', 'pw12345678')).ok).toBe(false)
    expect((await svc.register('a@b.com', 'short')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('发码/验码路径与体（confirm 只认 6 位数字，客户端先校验）', async () => {
    const { svc, calls } = makeService(() => ({ status: 200, json: {} }))
    expect((await svc.requestEmailCode('a@b.com')).ok).toBe(true)
    expect(calls[0].url).toBe(`${BASE}/auth/email-verification/request`)
    expect(calls[0].body).toEqual({ email: 'a@b.com' })

    expect((await svc.confirmEmailCode('a@b.com', '123456')).ok).toBe(true)
    expect(calls[1].url).toBe(`${BASE}/auth/email-verification/confirm`)
    expect(calls[1].body).toEqual({ email: 'a@b.com', code: '123456' })

    const bad = await svc.confirmEmailCode('a@b.com', '12ab')
    expect(bad.ok).toBe(false)
    expect(calls).toHaveLength(2) // 反向实验：形状不对不发请求
  })

  it('反向实验：码错（服务端 invalid code）⇒ 文案引导重取，而不是甩原话', async () => {
    const { svc } = makeService(() => ({ status: 400, json: { code: 400, message: 'invalid verification code' } }))
    const r = await svc.confirmEmailCode('a@b.com', '111111')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('验证码错误或已过期')
  })
})

describe('图码是凭据类内容：不进日志（A8 隐私口径）', () => {
  let accountFile: string
  beforeEach(() => {
    accountFile = ''
  })
  afterEach(() => {
    if (accountFile && fs.existsSync(accountFile)) fs.rmSync(accountFile, { force: true })
  })

  it('fetchCaptcha 全程不调 deps.log（一次都不许）', async () => {
    const logSpy = vi.fn()
    const { svc } = makeService(captchaOk)
    // 换一份带 spy 的 deps 重建服务（makeService 里的 log 是空函数）
    const spyFile = path.join(os.tmpdir(), `qihebox-a8-log-${Date.now()}.json`)
    accountFile = spyFile
    const svc2 = new AccountService({
      accountFile: spyFile,
      baseUrl: BASE,
      encrypt: (s) => s,
      decrypt: (s) => s,
      version: () => '2.5.9',
      log: logSpy,
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify(captchaOk().json), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ) as unknown as typeof fetch,
    })
    const r = await svc2.fetchCaptcha()
    expect(r.ok).toBe(true)
    expect(logSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(spyFile)).toBe(false) // 不落盘
    void svc
  })
})