/**
 * protocol 插件 URL 单测（v2.5，P0，PLAN §4.3）：
 * 覆盖 qihebox://plugin/<id>/<relpath> 的三层防护与流式提供：
 * ① parsePluginUrl 纯函数——id 域名倒序 / relPath 拒绝 '..' / '.' / 空段 / %2e 编码逃逸 / 解码错误
 * ② resolvePluginAsset——realpath 前缀比对防符号链接逃逸（纯 node，不依赖 electron）
 * ③ registerQiheboxProtocol handler 端到端——vi.mock electron 捕获 protocol.handle 回调，
 *   以伪 Request 注入（node undici 拒绝非 http(s) scheme 构造，直接传对象规避），
 *   验证 200 流式（net.fetch 指向 pkg 内 file:// 路径）/ Range 206 / 400 / 404 / 405。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { PluginManifest } from '../../src/plugins/types'
import type { SecretStore } from '../../src/main/plugins/encryption'
import {
  parsePluginUrl,
  pluginFileUrl,
  resolvePluginAsset,
  registerQiheboxProtocol,
  workspaceFileUrl,
} from '../../src/main/protocol'

/** electron mock 状态：捕获 protocol.handle 回调、mock net.fetch 与 app.getPath（userData 由测试注入） */
const mockState = vi.hoisted(() => ({
  handler: null as ((req: Request) => Promise<Response>) | null,
  netFetch: vi.fn<(url: string) => Promise<Response>>(),
  userData: '',
}))

vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, fn: (req: Request) => Promise<Response>): void => {
      mockState.handler = fn
    },
  },
  net: {
    fetch: (url: string): Promise<Response> => mockState.netFetch(url),
  },
  app: {
    getPath: (): string => mockState.userData,
  },
}))

/** 伪 Request：node undici 的 Request 构造函数拒绝非 http(s) scheme，直接用对象 + 类型断言 */
function fakeRequest(url: string, opts: { method?: string; range?: string } = {}): Request {
  return {
    method: opts.method ?? 'GET',
    url,
    headers: {
      get: (name: string): string | null => {
        const lower = String(name).toLowerCase()
        return lower === 'range' ? (opts.range ?? null) : null
      },
    },
  } as unknown as Request
}

/** 构造已安装插件：pluginsRoot/<id>/pkg/<file>（与 installer 落盘结构一致，PLAN §4.2） */
async function makePkg(pluginsRoot: string, id: string, file: string, content: string): Promise<string> {
  const pkgRoot = path.join(pluginsRoot, id, 'pkg')
  await fsp.mkdir(path.join(pkgRoot, path.dirname(file)), { recursive: true })
  await fsp.writeFile(path.join(pkgRoot, file), content, 'utf-8')
  return pkgRoot
}

describe('pluginFileUrl / parsePluginUrl 往返', () => {
  it('构造 URL 与解析往返一致', () => {
    const url = pluginFileUrl('com.qihe.hello', 'renderer/pages/Main.js')
    expect(url).toBe('qihebox://plugin/com.qihe.hello/renderer/pages/Main.js')
    expect(parsePluginUrl(new URL(url).pathname)).toEqual({ id: 'com.qihe.hello', relPath: 'renderer/pages/Main.js' })
  })

  it('relPath 含空格/中文/反斜杠 → encode 归一后往返一致', () => {
    const url = pluginFileUrl('com.qihe.hello', 'renderer\\pages\\我的 页面.js')
    const parsed = parsePluginUrl(new URL(url).pathname)
    expect(parsed).toEqual({ id: 'com.qihe.hello', relPath: 'renderer/pages/我的 页面.js' })
    expect(parsed?.relPath.includes('\\')).toBe(false)
  })
})

describe('parsePluginUrl 校验（id / relPath 逃逸）', () => {
  it('合法 pathname → { id, relPath }', () => {
    expect(parsePluginUrl('/com.qihe.hello/renderer/pages/Main.js')).toEqual({
      id: 'com.qihe.hello',
      relPath: 'renderer/pages/Main.js',
    })
  })

  it('非法 id（非域名倒序：单段 / 空段 / 大写 / 无 relPath / 尾斜杠）→ null', () => {
    for (const p of [
      '/hello/x.js',
      '/com..qihe/x.js',
      '/Com.Qihe/x.js',
      '/com.qihe./x.js',
      '/.com/x.js',
      '/com.qihe.hello',
      '/com.qihe.hello/',
    ]) {
      expect(parsePluginUrl(p)).toBeNull()
    }
  })

  it("relPath 逃逸（'..' / '.' / 空段 / %2e 编码 / 解码错误）→ null", () => {
    for (const p of [
      '/com.qihe.hello/../x.js',
      '/com.qihe.hello/a/../x.js',
      '/com.qihe.hello/a/%2e%2e/x.js',
      '/com.qihe.hello/%2e/x.js',
      '/com.qihe.hello//x.js',
      '/com.qihe.hello/a/%zz',
    ]) {
      expect(parsePluginUrl(p)).toBeNull()
    }
  })

  it('非 / 开头 / 空串 → null', () => {
    expect(parsePluginUrl('com.qihe.hello/x.js')).toBeNull()
    expect(parsePluginUrl('')).toBeNull()
  })
})

describe('resolvePluginAsset 磁盘解析（realpath 前缀比对，防符号链接逃逸）', () => {
  let pkgRoot = ''
  let outsideFile = ''

  beforeEach(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-protocol-resolve-'))
    pkgRoot = path.join(dir, 'pkg')
    await fsp.mkdir(path.join(pkgRoot, 'renderer'), { recursive: true })
    await fsp.writeFile(path.join(pkgRoot, 'renderer', 'Main.js'), 'export default 1', 'utf-8')
    outsideFile = path.join(dir, 'secret.txt')
    await fsp.writeFile(outsideFile, 'secret', 'utf-8')
    await fsp.symlink(outsideFile, path.join(pkgRoot, 'renderer', 'evil.js'))
  })

  it('包内文件 → 返回 realpath', async () => {
    const r = await resolvePluginAsset(pkgRoot, 'renderer/Main.js')
    expect(r).toBe(await fsp.realpath(path.join(pkgRoot, 'renderer', 'Main.js')))
  })

  it('不存在文件 / pkg 根不存在 → null', async () => {
    expect(await resolvePluginAsset(pkgRoot, 'renderer/missing.js')).toBeNull()
    expect(await resolvePluginAsset(path.join(pkgRoot, 'nope'), 'x.js')).toBeNull()
  })

  it('符号链接逃逸到包外 → null（realpath 前缀比对拒绝）', async () => {
    expect(await resolvePluginAsset(pkgRoot, 'renderer/evil.js')).toBeNull()
  })
})

describe('registerQiheboxProtocol handler 端到端（mock electron）', () => {
  let pluginsRoot = ''
  const content = 'export default { name: "hello" }'

  beforeEach(async () => {
    mockState.handler = null
    mockState.netFetch.mockReset()
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-protocol-handler-'))
    pluginsRoot = path.join(mockState.userData, 'plugins')
    await makePkg(pluginsRoot, 'com.qihe.hello', 'renderer/pages/Main.js', content)
    registerQiheboxProtocol(
      // plugin 分支不触达 box（与工作区无关）；file 分支不在本测试范围
      { workspace: { currentWorkspacePath: () => null } } as never,
      undefined,
      () => pluginsRoot,
    )
  })

  async function get(url: string, opts: { method?: string; range?: string } = {}): Promise<Response> {
    if (!mockState.handler) throw new Error('handler 未注册')
    return mockState.handler(fakeRequest(url, opts))
  }

  it('GET 无 Range → 200 流式提供（net.fetch 指向 pkg 内 file:// 路径）', async () => {
    mockState.netFetch.mockResolvedValue(new Response('module-content', { headers: { 'Content-Type': 'text/javascript' } }))
    const resp = await get('qihebox://plugin/com.qihe.hello/renderer/pages/Main.js')
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('module-content')
    const fetchedUrl = mockState.netFetch.mock.calls[0][0] as string
    expect(fetchedUrl.startsWith('file://')).toBe(true)
    expect(fetchedUrl).toContain(path.join(pluginsRoot, 'com.qihe.hello', 'pkg', 'renderer', 'pages', 'Main.js'))
    // 插件包更新后立即生效，不命中浏览器旧缓存
    expect(resp.headers.get('Cache-Control')).toBe('no-store')
  })

  it('plugin 响应带 Content-Security-Policy 头且内容合理（兑现 §六 规则 5，限制内联脚本/外部域）', async () => {
    mockState.netFetch.mockResolvedValue(new Response('module-content', { headers: { 'Content-Type': 'text/javascript' } }))
    const resp = await get('qihebox://plugin/com.qihe.hello/renderer/pages/Main.js')
    const csp = resp.headers.get('Content-Security-Policy')
    expect(csp).toBeTruthy()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    // 有意义：禁内联脚本（不允许 script-src 'unsafe-inline'）与任意域（不允许 *）
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).not.toContain("script-src *")
    expect(csp).not.toContain('*')
    // hello 示例用内联 style 属性（h() 的 style 对象），须放行内联样式
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("connect-src 'self'")
  })

  it('GET 带 Range → 206 + Content-Range + 分段内容（真实读盘，不经 net.fetch）', async () => {
    const resp = await get('qihebox://plugin/com.qihe.hello/renderer/pages/Main.js', { range: 'bytes=0-4' })
    expect(resp.status).toBe(206)
    expect(resp.headers.get('Content-Range')).toBe(`bytes 0-4/${Buffer.byteLength(content)}`)
    expect(resp.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await resp.text()).toBe('expor')
    expect(mockState.netFetch).not.toHaveBeenCalled()
    // Range 分支同样带 CSP（serveFile 的 extraHeaders 在 baseHeaders 内，206/416 均覆盖）
    expect(resp.headers.get('Content-Security-Policy')).toContain("script-src 'self'")
  })

  it('非法 id → 400；不存在资源 / 未安装插件 → 404', async () => {
    expect((await get('qihebox://plugin/hello/x.js')).status).toBe(400)
    expect((await get('qihebox://plugin/com.qihe.hello/renderer/missing.js')).status).toBe(404)
    expect((await get('qihebox://plugin/com.qihe.no/x.js')).status).toBe(404)
  })

  it('符号链接逃逸 → 404（统一响应，不泄露包外存在性）', async () => {
    await fsp.writeFile(path.join(mockState.userData, 'outside.txt'), 'secret', 'utf-8')
    await fsp.symlink(
      path.join(mockState.userData, 'outside.txt'),
      path.join(pluginsRoot, 'com.qihe.hello', 'pkg', 'renderer', 'evil.js'),
    )
    expect((await get('qihebox://plugin/com.qihe.hello/renderer/evil.js')).status).toBe(404)
  })

  it('非 GET → 405', async () => {
    expect((await get('qihebox://plugin/com.qihe.hello/renderer/pages/Main.js', { method: 'POST' })).status).toBe(405)
  })
})

describe('registerQiheboxProtocol handler file 分支（本体文件预览不加 CSP，保持现状）', () => {
  let wsDir = ''
  let filePath = ''

  beforeEach(async () => {
    mockState.handler = null
    mockState.netFetch.mockReset()
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-protocol-file-'))
    wsDir = path.join(mockState.userData, 'ws')
    await fsp.mkdir(wsDir, { recursive: true })
    filePath = path.join(wsDir, 'note.txt')
    await fsp.writeFile(filePath, 'preview-content', 'utf-8')
    registerQiheboxProtocol(
      { workspace: { currentWorkspacePath: () => wsDir } } as never,
      undefined,
      undefined,
    )
  })

  async function get(url: string): Promise<Response> {
    if (!mockState.handler) throw new Error('handler 未注册')
    return mockState.handler(fakeRequest(url))
  }

  it('file 分支 200 流式提供且不带 Content-Security-Policy 头', async () => {
    mockState.netFetch.mockResolvedValue(new Response('preview-body', { headers: { 'Content-Type': 'text/plain' } }))
    const resp = await get(workspaceFileUrl(filePath))
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('preview-body')
    expect(resp.headers.get('Content-Security-Policy')).toBeNull()
  })
})

// v2.6 缺陷修复（官方目录免费用户看到裸报错）：加密插件渲染层取钥的三条结局必须**各带自己的原因码**。
// 旧实现把被拒折叠成 404（包内本无明文，回落找不到文件），渲染层只拿到 `TypeError: Failed to fetch`
// 一类裸错——免费/未登录用户看不出「这是要订阅/要登录」，更没有出路可点。
describe('registerQiheboxProtocol handler 加密插件取钥分支（mock electron）', () => {
  let pluginsRoot = ''
  const keyHex = 'b'.repeat(64)
  const PLAIN = 'export default { name: "enc-hello" }'
  const URL_ASSET = 'qihebox://plugin/com.qihe.enc/renderer/pages/Main.js'

  /** 密钥缓存手工播种（绕开网络：本用例只测协议层分流，取钥链路另有单测） */
  const store: SecretStore = {
    encrypt: (b) => 'raw:' + b.toString('base64'),
    decrypt: (s) => (s.startsWith('raw:') ? Buffer.from(s.slice(4), 'base64') : null),
  }

  beforeEach(async () => {
    mockState.handler = null
    mockState.netFetch.mockReset()
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-protocol-enc-'))
    pluginsRoot = path.join(mockState.userData, 'plugins')
    const { encryptForBundle } = await import('../../src/main/plugins/encryption')
    const enc = encryptForBundle(Buffer.from(PLAIN), keyHex)
    expect(enc).not.toBeNull()
    // 只落密文（与官方发布包实测形状一致：unzip -l 里只有 .enc，没有明文）
    const pkgRoot = await makePkg(pluginsRoot, 'com.qihe.enc', 'renderer/pages/Main.js.enc', '')
    await fsp.writeFile(path.join(pkgRoot, 'renderer', 'pages', 'Main.js.enc'), enc!)
  })

  function manifest(entitlement: 'login' | 'subscription'): PluginManifest {
    return {
      id: 'com.qihe.enc',
      version: '1.0.0',
      name: '加密示例',
      apiVersion: 3,
      kind: ['ipc'],
      enabled: true,
      encryption: { algo: 'aes-256-gcm', keyId: 'k1', entitlement },
    } as unknown as PluginManifest
  }

  function register(getToken: () => string | null, cachedKeyHex?: string): void {
    const cacheDir = path.join(mockState.userData, 'keys')
    if (cachedKeyHex) {
      fs.mkdirSync(cacheDir, { recursive: true })
      const encoded = store.encrypt(Buffer.from(cachedKeyHex, 'utf8'), 'qihebox-plugin-key')
      fs.writeFileSync(
        path.join(cacheDir, 'com.qihe.enc.key'),
        JSON.stringify({ key: encoded, fetchedAt: Date.now(), version: '1.0.0' }),
        'utf-8',
      )
    }
    registerQiheboxProtocol(
      { workspace: { currentWorkspacePath: () => null } } as never,
      undefined,
      () => pluginsRoot,
      { baseUrl: 'https://api.test.dev', getToken, cacheDir, secretStore: store, readManifest: () => manifest('subscription') },
    )
  }

  async function get(url: string): Promise<Response> {
    if (!mockState.handler) throw new Error('handler 未注册')
    return mockState.handler(fakeRequest(url))
  }

  it('未登录（本地短路，不发网络）→ 403 + 原因码 NOT_LOGGED_IN，正文带「登录」出路', async () => {
    register(() => null)
    const resp = await get(URL_ASSET)
    expect(resp.status).toBe(403)
    expect(resp.headers.get('X-Qihebox-Key-Failure')).toBe('NOT_LOGGED_IN')
    expect(resp.headers.get('Cache-Control')).toBe('no-store')
    expect((await resp.text()).includes('登录')).toBe(true)
    // 断言「不回落到明文」：明文从未存在，若回落则协议层会走磁盘解析 → 404
    expect(fs.existsSync(path.join(pluginsRoot, 'com.qihe.enc', 'pkg', 'renderer', 'pages', 'Main.js'))).toBe(false)
  })

  it('取到密钥 → 200 内存解密提供模块（明文不落盘、不经 net.fetch）', async () => {
    register(() => 'tok', keyHex)
    const resp = await get(URL_ASSET)
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('text/javascript')
    expect(await resp.text()).toBe(PLAIN)
    expect(mockState.netFetch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(pluginsRoot, 'com.qihe.enc', 'pkg', 'renderer', 'pages', 'Main.js'))).toBe(false)
  })

  it('拿到钥却解不开（缓存钥与密文不匹配）→ 403 + 原因码 TAMPERED（出路=重装）', async () => {
    register(() => 'tok', 'c'.repeat(64))
    const resp = await get(URL_ASSET)
    expect(resp.status).toBe(403)
    expect(resp.headers.get('X-Qihebox-Key-Failure')).toBe('TAMPERED')
    expect((await resp.text()).includes('重新安装')).toBe(true)
  })

  it('缺 .enc 伴生文件（清单声明加密但该模块未加密）→ 落回明文解析，仍走 404 而不是 403', async () => {
    await fsp.rm(path.join(pluginsRoot, 'com.qihe.enc', 'pkg', 'renderer', 'pages', 'Main.js.enc'))
    register(() => null)
    const resp = await get(URL_ASSET)
    expect(resp.status).toBe(404)
    expect(resp.headers.get('X-Qihebox-Key-Failure')).toBeNull()
  })
})

// v2.6.1（取钥上报口径阶段 2）：加密插件**渲染层模块**取钥时，上报的必须是**主入口**密文
// （`pkg/main/index.js.enc`）的 sha256——一版一钥覆盖整包，云端登记值也只有主入口这一项。
// 旧口径按「所请求模块」各算一份（renderer/Home.js.enc 自己的哈希）⇒ 只要主入口本会话还没激活过
// （密钥未进缓存），冷进插件页必被服务端判 TAMPERED、页面根本出不来。
describe('加密插件渲染层取钥：上报口径 = 主入口密文哈希（v2.6.1 阶段 2）', () => {
  let pluginsRoot = ''
  const keyHex = 'b'.repeat(64)
  const PLAIN = 'export default { name: "enc-scope" }'
  const ID = 'com.qihe.scope'
  const URL_ASSET = `qihebox://plugin/${ID}/renderer/pages/Main.js`

  const store: SecretStore = {
    encrypt: (b) => 'raw:' + b.toString('base64'),
    decrypt: (s) => (s.startsWith('raw:') ? Buffer.from(s.slice(4), 'base64') : null),
  }

  /** 落一个真形状加密包：主入口与渲染层模块各一份密文（两族哈希刻意不同）+ 返回两族现算哈希 */
  async function makeScopePkg(): Promise<{ mainHash: string; rendererHash: string }> {
    const { encryptForBundle } = await import('../../src/main/plugins/encryption')
    const pkgRoot = await makePkg(pluginsRoot, ID, 'renderer/pages/Main.js.enc', '')
    const mainEnc = encryptForBundle(Buffer.from('module.exports = { activate: async () => ({}) }'), keyHex)!
    const rendererEnc = encryptForBundle(Buffer.from(PLAIN), keyHex)!
    await fsp.mkdir(path.join(pkgRoot, 'main'), { recursive: true })
    await fsp.writeFile(path.join(pkgRoot, 'main', 'index.js.enc'), mainEnc)
    await fsp.writeFile(path.join(pkgRoot, 'renderer', 'pages', 'Main.js.enc'), rendererEnc)
    const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')
    return { mainHash: sha(mainEnc), rendererHash: sha(rendererEnc) }
  }

  function register(getToken: () => string | null, readManifest?: () => PluginManifest | null): void {
    registerQiheboxProtocol({ workspace: { currentWorkspacePath: () => null } } as never, undefined, () => pluginsRoot, {
      baseUrl: 'https://api.test.dev',
      getToken,
      cacheDir: path.join(mockState.userData, 'keys'),
      secretStore: store,
      readManifest:
        readManifest ??
        (() =>
          ({
            id: ID,
            version: '1.0.0',
            name: '加密范围示例',
            apiVersion: 1,
            kind: ['ipc'],
            enabled: true,
            encryption: { algo: 'aes-256-gcm', keyId: 'k1', entitlement: 'subscription' },
          }) as unknown as PluginManifest),
    })
  }

  async function get(url: string): Promise<Response> {
    if (!mockState.handler) throw new Error('handler 未注册')
    return mockState.handler(fakeRequest(url))
  }

  /** 替换全局 fetch（encryption 缺省取全局 fetch）：记录请求体并按服务端登记值规则裁决 */
  function stubFetch(sentBodies: Array<Record<string, unknown>>, verdict: () => Response): () => void {
    const orig = (globalThis as unknown as { fetch: typeof fetch }).fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return verdict()
    }) as unknown as typeof fetch
    return () => {
      ;(globalThis as unknown as { fetch: typeof fetch }).fetch = orig
    }
  }

  beforeEach(async () => {
    mockState.handler = null
    mockState.netFetch.mockReset()
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-protocol-scope-'))
    pluginsRoot = path.join(mockState.userData, 'plugins')
  })

  it('上报 cipher_sha256 恒等于 sha256(pkg/main/index.js.enc)，与所请求模块无关', async () => {
    const { mainHash, rendererHash } = await makeScopePkg()
    // 夹具自证：两族哈希确实不同（若相等，本用例测不出口径漂移）
    expect(mainHash).not.toBe(rendererHash)

    const sent: Array<Record<string, unknown>> = []
    const restore = stubFetch(sent, () => {
      // 复刻服务端登记规则：只认主入口哈希；不等即 TAMPERED（403）
      const body = sent[sent.length - 1]
      const ok = body.cipher_sha256 === mainHash
      return ok
        ? new Response(JSON.stringify({ code: 200, data: { key_hex: keyHex } }), { status: 200 })
        : new Response(JSON.stringify({ code: 'TAMPERED' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    })
    try {
      register(() => 'tok') // 无密钥缓存 → 冷渲染层入口
      const resp = await get(URL_ASSET)
      // 目标模块自身的哈希与登记值不等（旧口径）时这里必然 403 TAMPERED——
      // 本用例的诉求是：上报口径 = 主入口 ⇒ 正常取到钥并解出该模块（200）
      expect(resp.status).toBe(200)
      expect(await resp.text()).toBe(PLAIN)
    } finally {
      restore()
    }
    expect(sent).toHaveLength(1)
    expect(sent[0].plugin_id).toBe(ID)
    expect(sent[0].cipher_sha256).toBe(mainHash)
    expect(sent[0].cipher_sha256).not.toBe(rendererHash)
  })

  it('主入口密文缺失（半包/坏包）→ 上报空串，服务端 fail-closed 拒发钥（403），不回落到明文', async () => {
    const { rendererHash } = await makeScopePkg()
    await fsp.rm(path.join(pluginsRoot, ID, 'pkg', 'main', 'index.js.enc'))
    const sent: Array<Record<string, unknown>> = []
    const restore = stubFetch(sent, () =>
      new Response(JSON.stringify({ code: 'TAMPERED' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    )
    try {
      register(() => 'tok')
      const resp = await get(URL_ASSET)
      expect(resp.status).toBe(403)
      expect(resp.headers.get('X-Qihebox-Key-Failure')).toBe('TAMPERED')
    } finally {
      restore()
    }
    expect(sent[0].cipher_sha256).toBe('')
    expect(sent[0].cipher_sha256).not.toBe(rendererHash)
    // 明文从未存在：不回落（否则会走磁盘解析 → 404）
    expect(fs.existsSync(path.join(pluginsRoot, ID, 'pkg', 'renderer', 'pages', 'Main.js'))).toBe(false)
  })

  it('协议层与主入口激活走同一个 helper（结构钉：不许各自再算一份，防再次漂移）', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(here, '../..')
    const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
    const protocolSrc = read('src/main/protocol.ts')
    const loaderSrc = read('src/main/plugins/loader.ts')
    const encryptionSrc = read('src/main/plugins/encryption.ts')
    expect(encryptionSrc).toContain('export async function mainEntryCipherSha256')
    for (const [name, src] of [
      ['src/main/protocol.ts', protocolSrc],
      ['src/main/plugins/loader.ts', loaderSrc],
    ] as const) {
      expect(src, `${name} 须调用共用 helper`).toContain('mainEntryCipherSha256(')
      // 自带一份「对所请求文件现算哈希」的实现 = 口径又要漂（两套必然再分叉）
      expect(/\bsha256Hex\s*\(/.test(src), `${name} 不许自带密文哈希实现`).toBe(false)
    }
  })
})
