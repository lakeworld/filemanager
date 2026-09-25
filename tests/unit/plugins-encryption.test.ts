/**
 * F5b 加密插件密钥生命周期与解密单测（v2.5.7 线程 F5b）。
 * encryption.ts 纯 TS（不 import electron），node 直测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  ENC_MAGIC,
  KEY_GRACE_PERIOD_MS,
  encryptForBundle,
  decryptEnc,
  getPluginKey,
  getPluginKeyResult,
  fetchKeyOnline,
  fetchKeyOnlineResult,
  mainEntryCipherSha256,
  pluginKeyFailureText,
  type KeyDeps,
  type SecretStore,
} from '../../src/main/plugins/encryption'
import type { PluginManifest } from '../../src/plugins/types'

let tmpDir: string

function baseManifest(over = {}): PluginManifest {
  return {
    id: 'com.qihe.test',
    name: 'Test',
    version: '1.0.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc'],
    ipcPrefix: 'test',
    encryption: { algo: 'aes-256-gcm', keyId: 'k1', entitlement: 'login' },
    ...over,
  } as PluginManifest
}

function makeDeps(over: Partial<KeyDeps> = {}): KeyDeps {
  const logs: string[] = []
  const deps: KeyDeps = {
    baseUrl: 'https://api.test.dev',
    getToken: () => 'tok-1',
    cacheDir: path.join(tmpDir, 'keys'),
    secretStore: {
      encrypt: (b) => 'enc:' + b.toString('base64'),
      decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64') : null),
    } as SecretStore,
    log: (_lv, m) => logs.push(m),
    ...over,
  }
  ;(deps as unknown as { __logs: string[] }).__logs = logs
  return deps
}

describe('encryption 加解密', () => {
  it('encryptForBundle/decryptEnc 往返一致（AES-256-GCM + magic/iv/tag 布局）', () => {
    const key = 'a'.repeat(64) // 32 字节 hex
    const src = Buffer.from('export const activate = () => {}')
    const enc = encryptForBundle(src, key)!
    expect(enc.subarray(0, 6).toString('utf8')).toBe(ENC_MAGIC)
    expect(enc.length).toBeGreaterThan(6 + 12 + 16)
    // 密文不含明文
    expect(enc.includes(src)).toBe(false)
    const dec = decryptEnc(enc, key)!
    expect(dec.toString('utf8')).toBe(src.toString('utf8'))
  })

  it('错误密钥解不开（GCM tag 校验失败 → null，fail-closed）', () => {
    const key = 'a'.repeat(64)
    const otherKey = 'b'.repeat(64)
    const enc = encryptForBundle(Buffer.from('secret payload'), key)!
    expect(decryptEnc(enc, otherKey)).toBeNull()
  })

  it('非 QHENC1 魔数与畸形输入 → null', () => {
    expect(decryptEnc(Buffer.from('not-a-magic'), 'a'.repeat(64))).toBeNull()
    expect(decryptEnc(Buffer.alloc(40), 'a'.repeat(64))).toBeNull()
  })
})

describe('getPluginKey 缓存与在线取钥', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-enc-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('首次在线取钥成功 → 写缓存；二次命中缓存（不发网络）', async () => {
    const deps = makeDeps()
    let calls = 0
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls++
      expect(url).toBe('https://api.test.dev/api/box/plugin-key')
      const body = JSON.parse(init!.body as string)
      expect(body.plugin_id).toBe('com.qihe.test')
      expect(body.cipher_sha256).toBe('sha-abc')
      return new Response(JSON.stringify({ code: 200, data: { key_hex: 'abcd', algo: 'aes-256-gcm' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const k1 = await getPluginKey(deps, baseManifest(), 'sha-abc', fetchImpl as unknown as typeof fetch)
    expect(k1).toBe('abcd')
    expect(calls).toBe(1)
    // 缓存命中：不再发请求
    const k2 = await getPluginKey(deps, baseManifest(), 'sha-abc', fetchImpl as unknown as typeof fetch)
    expect(k2).toBe('abcd')
    expect(calls).toBe(1)
    // 缓存文件存在且非明文
    const cachePath = path.join(tmpDir, 'keys', 'com.qihe.test.key')
    expect(fs.existsSync(cachePath)).toBe(true)
    expect(fs.readFileSync(cachePath, 'utf8')).not.toContain('abcd')
  })

  it('缓存过期 → 重新在线取钥', async () => {
    const deps = makeDeps()
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls++
      return new Response(JSON.stringify({ code: 200, data: { key_hex: 'ef00' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await getPluginKey(deps, baseManifest(), '', fetchImpl as unknown as typeof fetch)
    expect(calls).toBe(1)
    // 篡改缓存 fetchedAt 为过期
    const cachePath = path.join(tmpDir, 'keys', 'com.qihe.test.key')
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    raw.fetchedAt = Date.now() - KEY_GRACE_PERIOD_MS - 1000
    fs.writeFileSync(cachePath, JSON.stringify(raw))
    await getPluginKey(deps, baseManifest(), '', fetchImpl as unknown as typeof fetch)
    expect(calls).toBe(2)
  })

  it('baseUrl 已含 /api → 取钥 URL 剥一段，无 /api/api 双段（批 2.5 P0-1）', async () => {
    // 复现（现网五重证据）：build/server.json 的 apiBase = `https://www.qihebook.cloud/api`（已含 /api），
    // 而本模块拼 `${baseUrl}/api/box/plugin-key` → 实际打 /api/api/… 落 SPA 兜底 200 text/html、
    // 真路由 /api/box/plugin-key 无凭据 401 ⇒ 加密插件永远取不到钥（fail-closed 永不加载）。
    const deps = makeDeps({ baseUrl: 'https://www.qihebook.cloud/api' })
    let seen = ''
    const fetchImpl = async (url: string): Promise<Response> => {
      seen = url
      return new Response(JSON.stringify({ code: 200, data: { key_hex: 'k' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await fetchKeyOnline(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
    expect(seen).toBe('https://www.qihebook.cloud/api/box/plugin-key')
    expect(seen.includes('/api/api/')).toBe(false)
    // 不带 /api 的 baseUrl 不受影响（单段保持）
    let seen2 = ''
    const deps2 = makeDeps({ baseUrl: 'https://api.test.dev' })
    await fetchKeyOnline(deps2, baseManifest(), 'sha', (async (url: string) => {
      seen2 = url
      return new Response(JSON.stringify({ code: 200, data: { key_hex: 'k' } }), { status: 200 })
    }) as unknown as typeof fetch)
    expect(seen2).toBe('https://api.test.dev/api/box/plugin-key')
  })

  it('密钥缓存绑版本：同版命中缓存；插件更新（版本变化）→ 旧缓存失效重新取钥（批 2.5 P1-2）', async () => {
    // 复现：服务端按 (plugin_id, version) 发钥，覆盖安装后密文换新钥；
    // 旧缓存只按 id 命中（不比对版本）⇒ 7 天宽限内拿旧钥解新密文 → GCM 失败 → fail-closed。
    const deps = makeDeps()
    let calls = 0
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls++
      const body = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ code: 200, data: { key_hex: body.version === '2.0.0' ? 'newkey' : 'oldkey' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const k1 = await getPluginKey(deps, baseManifest(), 'sha-1', fetchImpl as unknown as typeof fetch)
    expect(k1).toBe('oldkey')
    expect(calls).toBe(1)
    // 同版本：命中缓存（不发网络）
    await getPluginKey(deps, baseManifest(), 'sha-1', fetchImpl as unknown as typeof fetch)
    expect(calls).toBe(1)
    // 覆盖安装（1.0.0 → 2.0.0）：旧缓存必须失效 → 重新取钥拿新钥
    const k2 = await getPluginKey(deps, baseManifest({ version: '2.0.0' }), 'sha-2', fetchImpl as unknown as typeof fetch)
    expect(k2).toBe('newkey')
    expect(calls).toBe(2)
    // 新缓存落盘含 version（后续宽限也锁版本）
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'keys', 'com.qihe.test.key'), 'utf8'))
    expect(raw.version).toBe('2.0.0')
    // 版本不符 + 在线失败 → 严格 fail-closed（不回落旧钥）
    const k3 = await getPluginKey(
      deps,
      baseManifest({ version: '3.0.0' }),
      'sha-3',
      (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    )
    expect(k3).toBeNull()
  })

  it('在线拒绝（403/失败）且无缓存 → null', async () => {
    const deps = makeDeps()
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 'SUBSCRIPTION_REQUIRED', message: 'no sub' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    const k = await getPluginKey(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
    expect(k).toBeNull()
  })

  it('未登录 → 不取钥返回 null（加密插件需登录）', async () => {
    const deps = makeDeps({ getToken: () => null })
    let called = false
    const fetchImpl = async (): Promise<Response> => {
      called = true
      return new Response('{}', { status: 200 })
    }
    const k = await getPluginKey(deps, baseManifest(), '', fetchImpl as unknown as typeof fetch)
    expect(k).toBeNull()
    expect(called).toBe(false)
  })

  it('无 encryption 块 → null（不对明文插件做任何取钥）', async () => {
    const deps = makeDeps()
    const manifest = baseManifest() as PluginManifest
    delete manifest.encryption
    const k = await getPluginKey(deps, manifest, 'sha')
    expect(k).toBeNull()
  })
})

describe('mainEntryCipherSha256（取钥上报口径唯一出处，v2.6.1 阶段 2）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-enc-scope-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('恒取 <pkg>/main/index.js.enc 的 sha256（与包内其他 .enc 无关）；缺失 → 空串不 throw', async () => {
    const pkg = path.join(tmpDir, 'pkg')
    fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
    fs.mkdirSync(path.join(pkg, 'renderer'), { recursive: true })
    const main = Buffer.from('main-cipher-bytes')
    const renderer = Buffer.from('renderer-cipher-bytes')
    fs.writeFileSync(path.join(pkg, 'main', 'index.js.enc'), main)
    fs.writeFileSync(path.join(pkg, 'renderer', 'Home.js.enc'), renderer)
    const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

    expect(await mainEntryCipherSha256(pkg)).toBe(sha(main))
    expect(await mainEntryCipherSha256(pkg)).not.toBe(sha(renderer))
    // 主入口密文缺失（半包/坏包）→ 空串（服务端按 fail-closed 拒发钥，不回落明文）
    fs.rmSync(path.join(pkg, 'main', 'index.js.enc'))
    expect(await mainEntryCipherSha256(pkg)).toBe('')
    // pkg 根不存在同样空串
    expect(await mainEntryCipherSha256(path.join(tmpDir, 'nope'))).toBe('')
  })
})

describe('fetchKeyOnline 网络行为', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-enc-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('网络异常 → null（不抛，锁加载路径）', async () => {
    const deps = makeDeps()
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('ECONNREFUSED')
    }
    const k = await fetchKeyOnline(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
    expect(k).toBeNull()
  })

  it('非 200 拒绝体 → null', async () => {
    const deps = makeDeps()
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 'TAMPERED' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    const k = await fetchKeyOnline(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
    expect(k).toBeNull()
  })

  it('成功发钥携带密文 sha256（防调包比对在服务端）', async () => {
    const deps = makeDeps()
    let sentBody = ''
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      sentBody = init!.body as string
      return new Response(JSON.stringify({ code: 200, data: { key_hex: 'k' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    await fetchKeyOnline(deps, baseManifest(), 'sha-xyz', fetchImpl as unknown as typeof fetch)
    expect(JSON.parse(sentBody).cipher_sha256).toBe('sha-xyz')
    expect(JSON.parse(sentBody).plugin_id).toBe('com.qihe.test')
  })
})

/**
 * v2.6 批 7（2.6 放行审查轮 2 跨仓契约对账缺口①）：服务端 `/api/box/plugin-key` 的 6 种非 200 结局
 * 各有出路，宿主此前一律折叠成 null + 一行 warn，用户装上订阅档插件后只有报错、没有出路。
 * 本组三件事：① code → (原因, 出路) 纯函数映射逐码不折叠；② 失败原因原样带出（code/HTTP 状态）；
 * ③ fail-closed 一字不变（拿不到钥就 null，且不写缓存）。
 */
describe('取钥失败原因与出路（审查轮 2 缺口①）', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-enc-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 服务端 6 种非 200 结局（box_plugin_key.go）：code → 期望的「原因关键词 / 出路关键词」 */
  const SERVER_CODES: Array<{ code: string; status: number; text: string; guidance: string }> = [
    { code: 'SUBSCRIPTION_REQUIRED', status: 403, text: '需要订阅', guidance: '订阅 VIP' },
    { code: 'PLUGIN_KEY_NOT_FOUND', status: 404, text: '未在云端登记', guidance: '联系插件发布方' },
    { code: 'PLUGIN_KEY_MISSING', status: 404, text: '密钥缺失', guidance: '联系插件发布方' },
    { code: 'TAMPERED', status: 403, text: '与云端登记不一致', guidance: '重新安装' },
    { code: 'ENTITLEMENT_UNKNOWN', status: 403, text: '门槛云端无法识别', guidance: '联系插件发布方' },
    { code: 'INTERNAL', status: 500, text: '临时故障', guidance: '稍后重试' },
  ]

  it('六种服务端 code：原因与出路逐码不同（不折叠成一句通用话）', () => {
    const seen = new Set<string>()
    for (const c of SERVER_CODES) {
      const t = pluginKeyFailureText({ code: c.code, httpStatus: c.status })
      expect(t.text, c.code).toContain(c.text)
      expect(t.guidance, c.code).toContain(c.guidance)
      seen.add(t.text)
    }
    // 六条原因互不相同（折叠回归会立刻让这条红）
    expect(seen.size).toBe(SERVER_CODES.length)
    // 订阅档要指到应用内既有入口（去哪开），不是自创入口
    const sub = pluginKeyFailureText({ code: 'SUBSCRIPTION_REQUIRED', httpStatus: 403 })
    expect(sub.guidance).toContain('启禾云')
    expect(sub.guidance).toContain('订阅 VIP')
  })

  it('宿主侧码 + 未知 code + 网络异常：各有归因，未知码走通用文案', () => {
    expect(pluginKeyFailureText({ code: 'NETWORK' }).guidance).toContain('检查网络')
    expect(pluginKeyFailureText({ code: 'NETWORK' }).text).toContain('网络')
    expect(pluginKeyFailureText({ code: 'NOT_LOGGED_IN' }).guidance).toContain('登录')
    expect(pluginKeyFailureText({ code: 'HTTP_ERROR', httpStatus: 500 }).text).toContain('HTTP 500')
    expect(pluginKeyFailureText({ code: 'HTTP_ERROR', httpStatus: 401 }).guidance).toContain('重新登录')
    expect(pluginKeyFailureText({ code: 'BAD_RESPONSE' }).guidance).toContain('重试')
    expect(pluginKeyFailureText({ code: 'DECRYPT_FAILED' }).text).toContain('解密失败')
    // 未知 code（服务端将来新增）：通用文案 + 原文可见 + 可重试
    const unknown = pluginKeyFailureText({ code: 'BRAND_NEW_CODE', httpStatus: 418 })
    expect(unknown.text).toContain('BRAND_NEW_CODE')
    expect(unknown.guidance).toContain('重试')
  })

  it('文案零商务口径（公开仓红线：禁用词表在文案里一字不出现）', () => {
    // 禁用词在源码里拆开拼——本文件自身也不许出现这些字（否则公开面禁词自查 grep 会把自己扫出来）
    const banned = ['价' + '格', '收' + '费', '计' + '价', '定' + '价', '付' + '费', '抽' + '成']
    const blob = [...SERVER_CODES.map((c) => c.code), 'NETWORK', 'NOT_LOGGED_IN', 'HTTP_ERROR', 'BAD_RESPONSE', 'DECRYPT_FAILED', 'UNKNOWN_X']
      .map((code) => {
        const t = pluginKeyFailureText({ code, httpStatus: 403 })
        return `${t.text}｜${t.guidance}`
      })
      .join('\n')
    for (const w of banned) expect(blob.includes(w), w).toBe(false)
  })

  it('六种服务端 code 原样带出（code + HTTP 状态不丢），且 fail-closed 不变（不写缓存）', async () => {
    for (const c of SERVER_CODES) {
      const deps = makeDeps()
      const fetchImpl = async (): Promise<Response> =>
        new Response(JSON.stringify({ code: c.code, message: 'server says' }), {
          status: c.status,
          headers: { 'Content-Type': 'application/json' },
        })
      const r = await getPluginKeyResult(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
      expect(r.keyHex, c.code).toBeNull() // fail-closed：拿不到钥
      expect(r.failure?.code, c.code).toBe(c.code) // code 原样（不折叠成 null/通用码）
      expect(r.failure?.httpStatus, c.code).toBe(c.status)
      expect(r.failure?.serverMessage, c.code).toBe('server says')
      // 旧入口（既有调用方）语义一字不变：null
      const k = await getPluginKey(deps, baseManifest(), 'sha', fetchImpl as unknown as typeof fetch)
      expect(k, c.code).toBeNull()
      // 失败不写缓存（下次触发重新取钥，订阅生效后即可自愈）
      expect(fs.existsSync(path.join(tmpDir, 'keys', 'com.qihe.test.key')), c.code).toBe(false)
    }
  })

  it('网络异常 / 未登录 / 2xx 形状不对：归因正确（不误报成服务端拒绝码）', async () => {
    const net = await fetchKeyOnlineResult(
      makeDeps(),
      baseManifest(),
      'sha',
      (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    )
    expect(net.keyHex).toBeNull()
    expect(net.failure?.code).toBe('NETWORK')
    // 未登录：不发请求
    let called = false
    const noToken = await getPluginKeyResult(
      makeDeps({ getToken: () => null }),
      baseManifest(),
      'sha',
      (async () => {
        called = true
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    )
    expect(noToken.failure?.code).toBe('NOT_LOGGED_IN')
    expect(called).toBe(false)
    // 200 但无 key_hex → BAD_RESPONSE（回包形状问题，不是服务端拒绝）
    const badShape = await fetchKeyOnlineResult(
      makeDeps(),
      baseManifest(),
      'sha',
      (async () => new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 })) as unknown as typeof fetch,
    )
    expect(badShape.failure?.code).toBe('BAD_RESPONSE')
    // 非 2xx 且回包无可用 code（数字码不算 code）→ HTTP_ERROR + 状态
    const bare = await fetchKeyOnlineResult(
      makeDeps(),
      baseManifest(),
      'sha',
      (async () => new Response(JSON.stringify({ code: '500' }), { status: 502 })) as unknown as typeof fetch,
    )
    expect(bare.failure?.code).toBe('HTTP_ERROR')
    expect(bare.failure?.httpStatus).toBe(502)
    // 未识别的大写 code 原样透传（日志留原文、映射走通用文案）
    const unknownCode = await fetchKeyOnlineResult(
      makeDeps(),
      baseManifest(),
      'sha',
      (async () => new Response(JSON.stringify({ code: 'NEW_SERVER_CODE' }), { status: 400 })) as unknown as typeof fetch,
    )
    expect(unknownCode.failure?.code).toBe('NEW_SERVER_CODE')
  })

  it('成功取钥不带 failure；命中缓存也不带（对照失败路径必有 failure）', async () => {
    const deps = makeDeps()
    const ok = async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 200, data: { key_hex: 'k9' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const r1 = await getPluginKeyResult(deps, baseManifest(), 'sha', ok as unknown as typeof fetch)
    expect(r1).toEqual({ keyHex: 'k9' })
    const r2 = await getPluginKeyResult(deps, baseManifest(), 'sha', ok as unknown as typeof fetch)
    expect(r2).toEqual({ keyHex: 'k9' })
  })
})
