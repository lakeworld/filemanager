/**
 * v2.5.7 协议增量单测（会话卡 P1）：invoice/inbound 只读域、cloudFetch 宿主代签、share.getThumb。
 * 覆盖（五增量各有用例，配合 apiSurface 基线再生）：
 * - invoice 域：list 全量 / since 增量过滤 / get / 门控 PERMISSION_DENIED
 * - inbound 域：同 invoice
 * - cloudFetch：相对路径强制 / 前缀白名单 / 未登录拒绝 / 代签头注入 / body 序列化 / 未配置服务器
 * - getThumb：薄壳透传（256/2048/变体）
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createPluginHost, HostEventBus } from '../../src/main/plugins/host'
import { buildTestBox } from './helpers'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-host-v257-'))
}

interface AdapterSet {
  invoices?: { list(since?: string): Promise<unknown[]>; get(n: string): Promise<unknown> }
  invoiceAccess?: boolean
  inbounds?: { list(since?: string): Promise<unknown[]>; get(id: string): Promise<unknown> }
  cloudFetchImpl?: { baseUrl: string; fetchImpl?: typeof fetch }
  accountAccess?: boolean
  account?: { getToken(): string | null; isLoggedIn(): boolean }
}

async function makeDeps(overrides: AdapterSet = {}) {
  const home = await tmp()
  const wsDir = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(wsDir)
  return {
    deps: {
      pluginId: 'com.qihe.v257',
      ipcPrefix: 'v257',
      stateDir: path.join(home, 'state'),
      bus: new HostEventBus(),
      log: () => {},
      workspace: { currentPath: () => wsDir, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer: () => {},
      account: overrides.account ?? { getToken: () => null, isLoggedIn: () => false },
      accountAccess: overrides.accountAccess ?? false,
      cloudFetchImpl: overrides.cloudFetchImpl ?? { baseUrl: '' },
      customers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
        relation: { link: async () => {}, unlink: async () => {} },
      },
      customersAccess: overrides.invoiceAccess ?? true,
      suppliers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
      },
      suppliersAccess: false,
      quotes: { list: async () => [], get: async () => null },
      invoices: overrides.invoices ?? { list: async () => [], get: async () => null },
      inbounds: overrides.inbounds ?? { list: async () => [], get: async () => null },
      share: {
        listProductSets: async () => [],
        listCustomers: async () => [],
        listTree: async () => [],
        getMetadata: async () => ({ tags: [], notes: '' }),
        statFile: async () => ({ size: 0, mtime: '' }),
        readFileChunk: async () => new Uint8Array(0),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'exists' as const,
        ensureCustomer: async () => 'exists' as const,
        ensureSubfolder: async () => {},
        mergePulledMetadata: async () => ({ conflicts: [] }),
        getThumb: async () => 'qihebox://thumb/x',
      },
      shareAccess: true,
    },
    wsDir,
    box,
  }
}

/** 执行后返回错误 code（成功 → undefined）；无 code 的裸异常 → 'NO_CODE' */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
}

// —— v2.5.7（协议增量 E1）：invoice 只读域 ——

describe('host.invoice 只读域（v2.5.7 E1）', () => {
  it('门控：permissions.customers !== true → list/get 均抛 PERMISSION_DENIED', async () => {
    const { deps } = await makeDeps({ invoiceAccess: false })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as { invoice: { list(): Promise<unknown>; get(n: string): Promise<unknown> } }
    expect(await codeOf(h.invoice.list())).toBe('PERMISSION_DENIED')
    expect(await codeOf(h.invoice.get('NO1'))).toBe('PERMISSION_DENIED')
  })

  it('list：全量透传适配器（无 since 参数不裁剪）', async () => {
    const { deps } = await makeDeps({
      invoices: { list: async () => [{ number: 'NO1' }], get: async () => null },
    })
    const inst = await createPluginHost(deps as never)
    const r = await (inst.host as unknown as { invoice: { list(): Promise<unknown[]> } }).invoice.list()
    expect(r).toEqual([{ number: 'NO1' }])
  })

  it('list(since)：经适配器透传（适配器负责过滤，薄壳不过滤）', async () => {
    let sinceArg: string | undefined
    const { deps } = await makeDeps({
      invoices: {
        list: async (since?: string) => {
          sinceArg = since
          return since ? [{ number: 'new' }] : [{ number: 'all' }]
        },
        get: async () => null,
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as { invoice: { list(s?: string): Promise<unknown[]> } }
    expect(await h.invoice.list('2026-01-01T00:00:00.000Z')).toEqual([{ number: 'new' }])
    expect(sinceArg).toBe('2026-01-01T00:00:00.000Z')
  })

  it('get：透传适配器返回值；不存在（null）原样返回', async () => {
    const { deps } = await makeDeps({
      invoices: { list: async () => [], get: async (n: string) => (n === 'NO1' ? { number: 'NO1' } : null) },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as { invoice: { get(n: string): Promise<unknown> } }
    expect(await h.invoice.get('NO1')).toEqual({ number: 'NO1' })
    expect(await h.invoice.get('MISS')).toBeNull()
  })
})

// —— v2.5.7（协议增量 E2）：inbound 只读域 ——

describe('host.inbound 只读域（v2.5.7 E2）', () => {
  it('门控：permissions.customers !== true → list/get 均抛 PERMISSION_DENIED', async () => {
    const { deps } = await makeDeps({ invoiceAccess: false })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as { inbound: { list(): Promise<unknown>; get(id: string): Promise<unknown> } }
    expect(await codeOf(h.inbound.list())).toBe('PERMISSION_DENIED')
    expect(await codeOf(h.inbound.get('RK1'))).toBe('PERMISSION_DENIED')
  })

  it('list/get：透传适配器（全量 + 单条查重主键）', async () => {
    const { deps } = await makeDeps({
      inbounds: {
        list: async () => [{ id: 'RK1' }],
        get: async (id: string) => (id === 'RK1' ? { id: 'RK1' } : null),
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as { inbound: { list(): Promise<unknown[]>; get(id: string): Promise<unknown> } }
    expect(await h.inbound.list()).toEqual([{ id: 'RK1' }])
    expect(await h.inbound.get('RK1')).toEqual({ id: 'RK1' })
    expect(await h.inbound.get('MISS')).toBeNull()
  })
})

// —— v2.5.7（F4a）：cloudFetch 宿主代签 ——

describe('host.account.cloudFetch（v2.5.7 F4a）', () => {
  interface CloudHost {
    account: {
      cloudFetch(path: string, init?: unknown): Promise<Response>
      getToken(): string | null
      isLoggedIn(): boolean
    }
  }

  it('未登录（getToken null / isLoggedIn false）→ NOT_LOGGED_IN', async () => {
    const { deps } = await makeDeps({ accountAccess: true })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    expect(await codeOf(h.account.cloudFetch('/api/box/me'))).toBe('NOT_LOGGED_IN')
  })

  it('路径非相对（不 / 开头 / 绝对 URL）→ INVALID_NAME', async () => {
    const { deps } = await makeDeps({
      accountAccess: true,
      account: { getToken: () => 'jwt', isLoggedIn: () => true },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    expect(await codeOf(h.account.cloudFetch('api/box/me'))).toBe('INVALID_NAME')
    expect(await codeOf(h.account.cloudFetch('https://evil.example/x'))).toBe('INVALID_NAME')
  })

  it('前缀白名单：非 /api/box/* 与 /api/ai/* → NOT_ALLOWED', async () => {
    const { deps } = await makeDeps({
      accountAccess: true,
      account: { getToken: () => 'jwt', isLoggedIn: () => true },
      cloudFetchImpl: {
        baseUrl: 'https://api.example.com',
        fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    expect(await codeOf(h.account.cloudFetch('/api/admin/me'))).toBe('NOT_ALLOWED')
    expect(await codeOf(h.account.cloudFetch('/collections/users'))).toBe('NOT_ALLOWED')
    expect(await codeOf(h.account.cloudFetch('/api/box/me'))).toBeUndefined()
    expect(await codeOf(h.account.cloudFetch('/api/ai/v1/chat/completions'))).toBeUndefined()
  })

  it('代签头注入：Authorization + X-Qihe-Client 覆盖同名用户头；体为 JSON 字符串；baseUrl 拼接', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const { deps } = await makeDeps({
      accountAccess: true,
      account: { getToken: () => 'jwt-x', isLoggedIn: () => true },
      cloudFetchImpl: { baseUrl: 'https://api.example.com', fetchImpl: fakeFetch },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    await h.account.cloudFetch('/api/box/me', {
      method: 'POST',
      headers: { authorization: 'Bearer user-provided', 'x-qihe-client': 'evil', 'x-extra': '1' },
      body: { a: 1 },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://api.example.com/api/box/me')
    const headers = (seen[0].init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer jwt-x') // 宿主覆盖用户同名头
    expect(headers['x-qihe-client']).toBe('box')
    expect(headers['x-extra']).toBe('1') // 非同名用户头保留
    expect(seen[0].init?.body).toBe(JSON.stringify({ a: 1 }))
    expect(seen[0].init?.method).toBe('POST')
  })

  it('baseUrl 以 /api 结尾 + path 以 /api/ 开头 → 双段剥除（防 /api/api 401）', async () => {
    // 真实根因（2026-08-30 设备面板 401）：resolveApiBase() 返回 `…/api`（供 account.login 拼
    // /collections/...），而 cloudFetch path 以 /api/box/ 开头 → 原先拼成 …/api/api/box/me 双段。
    const seen: { url: string }[] = []
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      seen.push({ url: String(input) })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const { deps } = await makeDeps({
      accountAccess: true,
      account: { getToken: () => 'jwt-x', isLoggedIn: () => true },
      cloudFetchImpl: { baseUrl: 'https://api.example.com/api', fetchImpl: fakeFetch },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    await h.account.cloudFetch('/api/box/me', {})
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://api.example.com/api/box/me')
    // 不变式：URL 中 `/api/` 路径段只出现一次（baseUrl 尾 /api 已剥除，无 /api/api 双段）
    expect(seen[0].url.match(/\/api\//g)).toHaveLength(1)
  })

  it('未配置服务器地址（baseUrl=""）→ NO_SERVER', async () => {    const { deps } = await makeDeps({
      accountAccess: true,
      account: { getToken: () => 'jwt', isLoggedIn: () => true },
      cloudFetchImpl: { baseUrl: '' },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    expect(await codeOf(h.account.cloudFetch('/api/box/me'))).toBe('NO_SERVER')
  })

  it('permissions.account !== true → PERMISSION_DENIED（空实现门控）', async () => {
    const { deps } = await makeDeps({ accountAccess: false })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CloudHost
    expect(await codeOf(h.account.cloudFetch('/api/box/me'))).toBe('PERMISSION_DENIED')
    expect(h.account.getToken()).toBeNull() // getToken 保留（只增不删），门控下恒 null
    expect(h.account.isLoggedIn()).toBe(false)
  })
})

// —— v2.5.7（协议增量 E4）：share.getThumb 薄壳透传 ——

describe('host.share.getThumb（v2.5.7 E4）', () => {
  it('透传适配器返回值（256/2048 参数原样）；门控走 share 位', async () => {
    const seen: { rel: string; size?: number }[] = []
    const home = await tmp()
    const wsDir = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(wsDir)
    const inst = await createPluginHost({
      pluginId: 'com.qihe.v257',
      ipcPrefix: 'v257',
      stateDir: path.join(home, 'state'),
      bus: new HostEventBus(),
      log: () => {},
      workspace: { currentPath: () => wsDir, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer: () => {},
      account: { getToken: () => null, isLoggedIn: () => false },
      accountAccess: false,
      cloudFetchImpl: { baseUrl: '' },
      customers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
        relation: { link: async () => {}, unlink: async () => {} },
      },
      customersAccess: false,
      suppliers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
      },
      suppliersAccess: false,
      quotes: { list: async () => [], get: async () => null },
      invoices: { list: async () => [], get: async () => null },
      inbounds: { list: async () => [], get: async () => null },
      share: {
        listProductSets: async () => [],
        listCustomers: async () => [],
        listTree: async () => [],
        getMetadata: async () => ({ tags: [], notes: '' }),
        statFile: async () => ({ size: 0, mtime: '' }),
        readFileChunk: async () => new Uint8Array(0),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'exists' as const,
        ensureCustomer: async () => 'exists' as const,
        ensureSubfolder: async () => {},
        mergePulledMetadata: async () => ({ conflicts: [] }),
        getThumb: async (rel: string, size?: 256 | 2048) => {
          seen.push({ rel, size })
          return size === 2048 ? 'qihebox://thumb/big' : 'qihebox://thumb/small'
        },
      },
      shareAccess: true,
    } as never)
    const h = inst.host as unknown as { share: { getThumb(r: string, s?: number): Promise<string> } }
    expect(await h.share.getThumb('产品集/A/图包/a.png', 256)).toBe('qihebox://thumb/small')
    expect(await h.share.getThumb('产品集/A/图包/b.png', 2048)).toBe('qihebox://thumb/big')
    expect(await h.share.getThumb('产品集/A/图包/c.png')).toBe('qihebox://thumb/small')
    expect(seen).toEqual([
      { rel: '产品集/A/图包/a.png', size: 256 },
      { rel: '产品集/A/图包/b.png', size: 2048 },
      { rel: '产品集/A/图包/c.png', size: undefined },
    ])
  })

  it('门控：permissions.share !== true → PERMISSION_DENIED', async () => {
    const home = await tmp()
    const wsDir = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(wsDir)
    const inst = await createPluginHost({
      pluginId: 'com.qihe.v257',
      ipcPrefix: 'v257',
      stateDir: path.join(home, 'state'),
      bus: new HostEventBus(),
      log: () => {},
      workspace: { currentPath: () => wsDir, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer: () => {},
      account: { getToken: () => null, isLoggedIn: () => false },
      accountAccess: false,
      cloudFetchImpl: { baseUrl: '' },
      customers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
        relation: { link: async () => {}, unlink: async () => {} },
      },
      customersAccess: false,
      suppliers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
      },
      suppliersAccess: false,
      quotes: { list: async () => [], get: async () => null },
      invoices: { list: async () => [], get: async () => null },
      inbounds: { list: async () => [], get: async () => null },
      share: {
        listProductSets: async () => [],
        listCustomers: async () => [],
        listTree: async () => [],
        getMetadata: async () => ({ tags: [], notes: '' }),
        statFile: async () => ({ size: 0, mtime: '' }),
        readFileChunk: async () => new Uint8Array(0),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'exists' as const,
        ensureCustomer: async () => 'exists' as const,
        ensureSubfolder: async () => {},
        mergePulledMetadata: async () => ({ conflicts: [] }),
        getThumb: async () => '',
      },
      shareAccess: false,
    } as never)
    const h = inst.host as unknown as { share: { getThumb(r: string): Promise<string> } }
    expect(await codeOf(h.share.getThumb('产品集/A/图包/a.png'))).toBe('PERMISSION_DENIED')
  })
})
