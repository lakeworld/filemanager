/**
 * 官方插件内容密钥获取与内存解密（v2.5.7 线程 F5b）。
 *
 * 生命周期：
 *  1. 激活加密插件 → 查本地密钥缓存（secretStore 加密落盘，Linux 无 keyring 退化 base64
 *     ——与 account.ts raw: 同口径）→ 命中且未过 7 天宽限 → 用；
 *  2. 缓存未命中/过期 → 在线取钥（erp POST /api/box/plugin-key，Bearer JWT + 密文 sha256
 *     比对防调包）→ 写缓存；
 *  3. 网络失败且缓存过期 → 拒绝加载（锁云端入口；本地非云端功能不受影响）。
 *
 * 明文不落盘：解密后的 bundle 只在内存（Module._compile / Response body），进程退出即消。
 * 诚实口径（Kerckhoffs）：解密逻辑公开（box 开源），安全依赖密钥服务端化与取钥审计——
 * 打补丁的自编译宿主可在加载时转储明文，防的是静态提取与无账号分发，不防付费用户主动破解。
 *
 * 本模块不 import electron（纯 TS，可在 node 直测）；密钥落盘加密走 secretStore 注入
 * （装配层传 safeStorage 封装，node 单测传 fake）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { PluginManifest } from '../../plugins/types'

/** 离线宽限（与线程 C 拍板口径一致）：密钥缓存 7 天内可用，过期锁云端插件入口 */
export const KEY_GRACE_PERIOD_MS = 7 * 24 * 3600 * 1000
/** .enc 文件头魔数（写入与读取双端一致） */
export const ENC_MAGIC = 'QHENC1'

/** 密钥落盘加密提供者（默认 null = 纯 base64 混淆；装配层注入 safeStorage 封装） */
export interface SecretStore {
  encrypt(buf: Buffer, scope: string): string
  decrypt(s: string, scope: string): Buffer | null
}

export interface KeyDeps {
  baseUrl: string
  getToken: () => string | null
  /** 缓存写入目录（userData/plugins/keys） */
  cacheDir: string
  /** 密钥落盘加密（electron safeStorage）；缺省 null = base64（与 account raw: 同口径） */
  secretStore?: SecretStore
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

interface CachedKey {
  keyHex: string
  fetchedAt: number
}

function cacheFile(deps: KeyDeps, pluginId: string): string {
  return path.join(deps.cacheDir, `${pluginId}.key`)
}

function readCache(deps: KeyDeps, pluginId: string): CachedKey | null {
  try {
    const raw = fs.readFileSync(cacheFile(deps, pluginId), 'utf8')
    const json = JSON.parse(raw) as { key: string; fetchedAt: number }
    const buf = deps.secretStore ? deps.secretStore.decrypt(json.key, 'qihebox-plugin-key') : null
    if (!buf) return null
    return { keyHex: buf.toString('utf8'), fetchedAt: json.fetchedAt }
  } catch {
    return null
  }
}

function writeCache(deps: KeyDeps, pluginId: string, keyHex: string): void {
  try {
    fs.mkdirSync(deps.cacheDir, { recursive: true })
    const encoded = deps.secretStore
      ? deps.secretStore.encrypt(Buffer.from(keyHex, 'utf8'), 'qihebox-plugin-key')
      : 'raw:' + Buffer.from(keyHex, 'utf8').toString('base64')
    fs.writeFileSync(cacheFile(deps, pluginId), JSON.stringify({ key: encoded, fetchedAt: Date.now() }), { mode: 0o600 })
  } catch (err) {
    deps.log('warn', `[encryption] 密钥缓存写入失败（仅影响离线宽限）: ${String(err)}`)
  }
}

/** 在线取钥：POST /api/box/plugin-key，Bearer JWT，防调包 sha256 比对在服务端（PLAN F5 §77）。
 *  localCipherSha256 = 本地密文文件（main/index.js.enc）的 sha256——由调用方计算传入，
 *  不信任 manifest 字段（manifest 也可被篡改；服务端只认登记值，比对失败拒发钥）。 */
export async function fetchKeyOnline(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!deps.getToken()) {
    deps.log('warn', '[encryption] 未登录，无法在线取钥（加密插件需登录）')
    return null
  }
  const body = {
    plugin_id: manifest.id,
    version: manifest.version,
    cipher_sha256: localCipherSha256,
  }
  const res = await fetchImpl(`${deps.baseUrl}/api/box/plugin-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.getToken()}`,
    },
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    deps.log('warn', `[encryption] 取钥网络失败: ${String(err)}`)
    return null
  })
  if (!res) return null
  const json = (await res.json().catch(() => null)) as { code?: number; data?: { key_hex?: string } } | null
  if (!res.ok || json?.code !== 200 || !json.data?.key_hex) {
    deps.log('warn', `[encryption] 取钥被拒（HTTP ${res.status}）：${JSON.stringify(json)?.slice(0, 160)}`)
    return null
  }
  return json.data.key_hex
}

/**
 * 获取插件内容密钥（hex）：缓存宽限内直接返回；否则在线取钥并写缓存；失败 → null。
 * 解密本身在调用方（Module._compile / protocol），本模块只管密钥生命周期。
 */
export async function getPluginKey(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (!manifest.encryption) return null
  const cached = readCache(deps, manifest.id)
  if (cached && cached.keyHex && Date.now() - cached.fetchedAt < KEY_GRACE_PERIOD_MS) {
    return cached.keyHex
  }
  const fetched = await fetchKeyOnline(deps, manifest, localCipherSha256, fetchImpl)
  if (fetched) {
    writeCache(deps, manifest.id, fetched)
    return fetched
  }
  // 网络失败 + 缓存过期 → 拒绝（锁云端插件入口；本地功能不受影响）
  deps.log('warn', `[encryption] 密钥不可用（${manifest.id}@${manifest.version}）→ 拒绝加载加密插件`)
  return null
}

/** 解密 .enc 内容（magic + iv + tag + body）。非 QHENC1 / 密钥错 → null（调用方 fail-closed）。 */
export function decryptEnc(buf: Buffer, keyHex: string): Buffer | null {
  try {
    if (buf.subarray(0, 6).toString('utf8') !== ENC_MAGIC || buf.length <= 34) return null
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) return null
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(6, 18))
    d.setAuthTag(buf.subarray(18, 34))
    return Buffer.concat([d.update(buf.subarray(34)), d.final()])
  } catch {
    return null
  }
}

/** 加密明文 → .enc 内容（供构建脚本/测试；产品打包在 plugins 仓 --encrypt 实现） */
export function encryptForBundle(buf: Buffer, keyHex: string): Buffer | null {
  try {
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) return null
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(buf), c.final()])
    return Buffer.concat([Buffer.from(ENC_MAGIC, 'utf8'), iv, c.getAuthTag(), body])
  } catch {
    return null
  }
}
