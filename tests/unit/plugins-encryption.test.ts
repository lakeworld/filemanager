/**
 * F5b 加密插件密钥生命周期与解密单测（v2.5.7 线程 F5b）。
 * encryption.ts 纯 TS（不 import electron），node 直测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ENC_MAGIC,
  KEY_GRACE_PERIOD_MS,
  encryptForBundle,
  decryptEnc,
  getPluginKey,
  fetchKeyOnline,
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
